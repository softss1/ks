// Слой данных. Один интерфейс, два режима:
//  • firebase — Firestore: кэш + инкрементальное чтение (только новое), прямая запись, вход через Google
//  • rest     — опрос Node.js бэкенда (/api)
//  • local    — localStorage
// Пароль и 2FA аккаунтов в Firestore не пишутся никогда.
import { firebaseConfig, apiBase } from './firebase-config.js';

const API = apiBase || '/api';
const useFirebase = !!firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith('YOUR_');
let connCb = () => {};
const setConn = ok => connCb(ok);

async function http(path, method = 'GET', body, token) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

// ---------- REST ----------
function poll(fn, cb, ms = 2000) {
  let alive = true;
  const tick = async () => {
    try { const d = await fn(); if (alive) { cb(d); setConn(true); } }
    catch { if (alive) setConn(false); }
  };
  tick();
  const id = setInterval(tick, ms);
  return () => { alive = false; clearInterval(id); };
}

function restDB() {
  return {
    mode: 'rest',
    onEngine: cb => (cb(null), () => {}), info: () => ({}),
    onConn: cb => { connCb = cb; },
    onAuth: cb => cb({}),
    signIn() {}, signOut() {},
    onStats: (cb, range) => poll(() => http('/stats' + (range ? `?from=${range.from}&to=${range.to}` : '')), cb),
    onWorkers: cb => poll(() => http('/workers'), cb),
    onTargets: cb => poll(() => http('/targets'), cb),
    onRun: cb => poll(async () => (await http('/status')).running, cb),
    onLogs(cb) {
      let since = 0;
      return poll(async () => { const r = await http('/logs?since=' + since); since = r.next ?? since; return r.lines; }, cb);
    },
    addWorker: d => http('/workers', 'POST', d),
    removeWorker: id => http('/workers/' + encodeURIComponent(id), 'DELETE'),
    addTarget: d => http('/targets', 'POST', d),
    removeTarget: id => http('/targets/' + encodeURIComponent(id), 'DELETE'),
    updateTarget: (id, d) => http('/targets/' + encodeURIComponent(id), 'PATCH', d),
    setRunning: async v => (await http(v ? '/start' : '/stop', 'POST')).running,
  };
}


// ---------- Local (localStorage, без бэкенда) ----------
function localDB() {
  const KEY = 'pm_state_v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  const s = { workers: [], targets: [], logs: [], events: null, seq: 0, id: 1, ...saved };
  // события статистики: {ts, k: 'total'|'ok'|'err'}
  if (!s.events) s.events = s.targets.map(t => ({ ts: t.ts || Date.now(), k: 'total' }));
  delete s.stats;
  let up = false; // отвечает ли локальный сервер
  const subs = new Set();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} subs.forEach(f => f()); };
  const sub = f => { subs.add(f); f(); return () => subs.delete(f); };
  const log = (level, text) => {
    const ts = Date.now();
    s.logs.push({ seq: ++s.seq, ts, level, text }); s.logs = s.logs.slice(-200);
    if (level === 'error') s.events.push({ ts, k: 'err' }); // каждая ошибка из консоли попадает в счётчик «Ошибок»
  };
  const STATUSES = ['taken', 'invited', 'waiting', 'accepted', 'completed', 'action_needed', 'canceled', 'success', 'failed'];
  const ST_LABEL = { taken: 'Взято в работу', invited: 'Заявка отправлена — ждём принятия', waiting: 'Заявка отправлена — ждём принятия', accepted: 'Приняли заявку — скоро напишем', completed: 'Успешно — всё отправлено, клиент у нас, следим за ответом', action_needed: 'Клиент ответил — нужен ваш ответ', canceled: 'Не приняли за 3 ч — заявка отозвана скриптом', success: 'Успешно — всё отправлено, клиент у нас, следим за ответом', failed: 'Неуспешно' };

  return {
    mode: 'local',
    onEngine: cb => (cb(null), () => {}), info: () => ({}),
    // «на связи» = локальный сервер (start.command) реально отвечает; данные при этом лежат в браузере
    onConn: cb => {
      connCb = cb;
      const ping = async () => {
        try { up = (await fetch('/api/ping', { cache: 'no-store' })).ok; } catch { up = false; }
        setConn(up);
      };
      ping(); setInterval(ping, 3000);
    },
    onAuth: cb => cb({}),
    signIn() {}, signOut() {},
    onStats: (cb, range) => sub(() => {
      const r = { total: 0, ok: 0, errors: 0, earned: 0 };
      for (const e of s.events) {
        if (range && (e.ts < range.from || e.ts > range.to)) continue;
        if (e.k === 'total') r.total++; else if (e.k === 'ok') { r.ok++; r.earned += e.amt || 0; } else r.errors++;
      }
      cb(r);
    }),
    onWorkers: cb => sub(() => cb([...s.workers])),
    onTargets: cb => sub(() => cb([...s.targets])),
    onRun: cb => sub(() => cb(false)),
    onLogs(cb) {
      let last = 0;
      return sub(() => {
        const fresh = s.logs.filter(l => l.seq > last);
        if (fresh.length) { last = fresh[fresh.length - 1].seq; cb(fresh); }
      });
    },
    async addWorker(d) {
      const login = String(d.login || '').trim();
      if (!login || !d.password) throw new Error('Нужны логин и пароль');
      if (s.workers.some(w => w.login === login)) throw new Error('Аккаунт ' + login + ' уже есть');
      // пароль/2FA локально не сохраняются — их принимает только бэкенд
      s.workers.push({ id: s.id++, login, proxy: String(d.proxy || '').trim(), status: 'idle', since: Date.now() });
      log('info', `Аккаунт ${login} добавлен`); save();
    },
    async removeWorker(id) {
      const w = s.workers.find(x => x.id === id);
      s.workers = s.workers.filter(x => x.id !== id);
      if (w) log('info', `Аккаунт ${w.login} удалён`); save();
    },
    async addTarget(d) {
      const name = String(d.name || '').trim();
      if (!name) throw new Error('Укажите цель');
      const ts = Date.now(), id = s.id++;
      s.targets.unshift({ id, name, value: Number(d.value) || 0, status: STATUSES.includes(d.status) ? d.status : 'taken', ts });
      s.events.push({ ts, k: 'total', id }); s.events = s.events.slice(-20000);
      log('info', `Цель ${name} добавлена ($${Number(d.value) || 0})`); save();
    },
    async removeTarget(id) {
      s.targets = s.targets.filter(x => x.id !== id);
      s.events = s.events.filter(e => !(e.k === 'ok' && e.id === id)); // успех удалённой цели не считаем
      save();
    },
    async updateTarget(id, d) {
      const t = s.targets.find(x => x.id === id);
      if (!t) throw new Error('Цель не найдена');
      const status = STATUSES.includes(d.status) ? d.status : t.status;
      const paid = d.paid === 'on' || d.paid === true;
      let amt = null;
      if (paid) {
        amt = Number(d.earned);
        if (d.earned === '' || d.earned == null || !Number.isFinite(amt) || amt < 0) throw new Error('Укажите сумму оплаты');
      }
      const prev = s.events.find(e => e.k === 'ok' && e.id === id);
      s.events = s.events.filter(e => !(e.k === 'ok' && e.id === id));
      const was = t.status;
      t.status = status;
      if (d.value !== undefined && d.value !== '') t.value = Number(d.value) || 0;
      if (paid) {
        const ts = /^\d{4}-\d\d-\d\d$/.test(d.paidDate || '') ? new Date(d.paidDate + 'T12:00:00').getTime() : (prev?.ts ?? Date.now());
        t.earned = amt; s.events.push({ ts, k: 'ok', id, amt });
      } else delete t.earned;
      if (was !== status) log(status === 'failed' ? 'warn' : 'info', `Цель ${t.name}: ${ST_LABEL[status]}`);
      if (paid && !(prev && prev.amt === amt)) log('success', `Цель ${t.name}: оплата $${amt}`);
      else if (was === status) log('info', `Цель ${t.name} обновлена`);
      save();
    },
    // очистка консоли сбрасывает и счётчик ошибок — он строится из тех же записей
    async clearLogs() { s.logs = []; s.events = s.events.filter(e => e.k !== 'err'); save(); },
    async setRunning(v) {
      if (v) log('error', !up ? 'Старт: не выполнен — локальный сервер не запущен (откройте start.command)'
        : s.workers.length ? 'Старт: не выполнен — на сервере нет модуля скрипта'
        : 'Старт: не выполнен — нет воркеров, добавьте аккаунт');
      else log('info', 'Стоп: скрипт и так не запущен');
      save(); return false;
    },
  };
}

// ---------- Firebase ----------
// Коллекции: workers · targets · stats_daily · logs · control/{state,engine}. Схема: other/firestore-schema.md
// Экономия чтений (лимиты Spark): данные лежат в локальном кэше (localStorage). Слушатели читают ТОЛЬКО
// документы новее курсора updatedAt (logs — новее курсора ts), старые из базы не перечитываются.
// Удаление = мягкое (deleted:true), чтобы изменение дошло до других вкладок/устройств.
async function fbDB() {
  const base = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const [{ initializeApp }, A, F] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const fs = F.getFirestore(app);
  const col = n => F.collection(fs, n);
  const ST = { reads: 0, writes: 0, lastSync: 0, error: '' };       // счётчики текущей сессии (для окна «Firebase»)
  const ENGINE_TTL = 5 * 60 * 1000;                                   // сервер пишет control/engine.lastSeen раз в 2 мин
  let engine = null;
  const fail = e => { console.error('Firestore:', e); ST.error = e.code || e.message || 'ошибка'; setConn(false); };
  const synced = n => { ST.reads += n; ST.lastSync = Date.now(); ST.error = ''; };
  const dk = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const STATUSES = ['taken', 'invited', 'waiting', 'accepted', 'completed', 'action_needed', 'canceled', 'success', 'failed'];
  const ST_LABEL = { taken: 'Взято в работу', invited: 'Заявка отправлена — ждём принятия', waiting: 'Заявка отправлена — ждём принятия', accepted: 'Приняли заявку — скоро напишем', completed: 'Успешно — всё отправлено, клиент у нас, следим за ответом', action_needed: 'Клиент ответил — нужен ваш ответ', canceled: 'Не приняли за 3 ч — заявка отозвана скриптом', success: 'Успешно — всё отправлено, клиент у нас, следим за ответом', failed: 'Неуспешно' };

  const mail = l => { l = String(l || '').trim().toLowerCase(); return l.includes('@') ? l : l + '@kss.app'; };
  const authMsg = e => ({
    'auth/invalid-credential': 'Неверный логин или пароль', 'auth/wrong-password': 'Неверный пароль', 'auth/user-not-found': 'Неверный логин или пароль',
    'auth/too-many-requests': 'Слишком много попыток, подождите', 'auth/weak-password': 'Пароль короче 6 символов',
    'auth/network-request-failed': 'Нет связи с Firebase', 'auth/operation-not-allowed': 'Вход по паролю не включён в Firebase',
  }[e.code] || e.message);
  let uid = null, C = null, stops = [], saveT = 0;
  const blank = () => ({ workers: {}, targets: {}, stats: {}, logs: [], cur: {}, logTs: 0 });
  // кэш пишет только одна вкладка (Web Lock), иначе вкладки затирают кэш друг друга устаревшими данными
  let writer = !navigator.locks;
  navigator.locks?.request('pm-cache-writer', { ifAvailable: true }, lock => { if (lock) { writer = true; return new Promise(() => {}); } });
  const clearedAt = () => Number(localStorage.getItem('pm_logs_cleared_' + uid)) || 0; // отметка «консоль очищена» общая для вкладок
  const persist = () => { if (!writer) return; clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem('pm_fb_v4_' + uid, JSON.stringify(C)); } catch {} }, 400); };
  const subs = { workers: new Set(), targets: new Set(), stats: new Set(), logs: new Set(), run: new Set(), engine: new Set() };
  const fire = (k, arg) => subs[k].forEach(f => f(arg));
  let running = false;

  // курсорный поток: только документы с updatedAt >= курсора
  function inc(coll, key) {
    const cur = C.cur[key];
    const q = F.query(col(coll), ...(cur ? [F.where('updatedAt', '>=', new F.Timestamp(cur.s, cur.n))] : []), F.orderBy('updatedAt'));
    return F.onSnapshot(q, snap => {
      if (!snap.metadata.fromCache) { setConn(true); synced(snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites).length); }
      let touched = false;
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') { delete C[key][ch.doc.id]; touched = true; continue; } // документ удалён на сервере — убираем и из кэша
        const d = ch.doc, x = d.data({ serverTimestamps: 'estimate' });
        const ts = d.metadata.hasPendingWrites ? null : d.get('updatedAt');
        delete x.updatedAt;
        if (x.deleted) delete C[key][d.id]; else C[key][d.id] = x;
        const c = C.cur[key];
        if (ts && (!c || ts.seconds > c.s || (ts.seconds === c.s && ts.nanoseconds > c.n))) C.cur[key] = { s: ts.seconds, n: ts.nanoseconds };
        touched = true;
      }
      if (touched) { persist(); fire(key); }
    }, fail);
  }
  // логи: только записи с ts >= последнего известного (без кэша — последние 100)
  function logStream() {
    const q = C.logTs
      ? F.query(col('logs'), F.where('ts', '>=', C.logTs), F.orderBy('ts'))
      : F.query(col('logs'), F.orderBy('ts', 'desc'), F.limit(100));
    return F.onSnapshot(q, snap => {
      if (!snap.metadata.fromCache) { setConn(true); synced(snap.docChanges().filter(c => c.type === 'added').length); }
      const have = new Set(C.logs.map(l => l.id));
      const fresh = [];
      for (const ch of snap.docChanges()) {
        if (ch.type !== 'added' || have.has(ch.doc.id)) continue;
        const x = ch.doc.data();
        if (x.ts <= clearedAt()) continue;
        fresh.push({ id: ch.doc.id, ts: x.ts, level: x.level, text: x.text });
      }
      if (!fresh.length) return;
      fresh.sort((a, b) => a.ts - b.ts);
      C.logs = C.logs.concat(fresh).slice(-300);
      C.logTs = Math.max(C.logTs, fresh[fresh.length - 1].ts);
      persist(); fire('logs', fresh);
    }, fail);
  }
  function start() {
    try { C = { ...blank(), ...JSON.parse(localStorage.getItem('pm_fb_v4_' + uid)) }; } catch { C = blank(); }
    const t = clearedAt(); if (t) C.logs = C.logs.filter(l => l.ts > t);
    stops = [
      inc('workers', 'workers'), inc('targets', 'targets'), inc('stats_daily', 'stats'), logStream(),
      F.onSnapshot(F.doc(fs, 'control', 'state'), s => { running = s.data()?.running === true; synced(1); fire('run'); }, fail),
      F.onSnapshot(F.doc(fs, 'control', 'engine'), s => { engine = s.exists() ? s.data() : null; synced(1); fire('engine'); }, fail),
    ];
  }
  const stop = () => { stops.forEach(f => f()); stops = []; engine = null; };

  // пакетная запись: документ + статистика (increment) + лог — атомарно
  const now = () => F.serverTimestamp();
  function batch() {
    const b = F.writeBatch(fs), st = {}; let ops = 0;
    return {
      set: (ref, d, merge) => { ops++; b.set(ref, { ...d, updatedAt: now() }, merge ? { merge: true } : {}); },
      stat(day, f, v) { (st[day] ||= {})[f] = (st[day][f] || 0) + v; },
      log: (level, text) => { ops++; b.set(F.doc(col('logs')), { ts: Date.now(), level, text }); },
      del: ref => { ops++; b.delete(ref); },
      async commit() {
        for (const [day, d] of Object.entries(st)) {
          const inc = Object.fromEntries(Object.entries(d).filter(([, v]) => v).map(([f, v]) => [f, F.increment(v)]));
          if (Object.keys(inc).length) { ops++; b.set(F.doc(fs, 'stats_daily', day), { ...inc, updatedAt: now() }, { merge: true }); }
        }
        await b.commit(); ST.writes += ops;
      },
    };
  }
  const list = (m, sort) => Object.entries(m).map(([id, x]) => ({ id, ...x })).sort(sort);
  const sub = (k, cb, get) => { const f = arg => cb(get(arg)); subs[k].add(f); f(); return () => subs[k].delete(f); };

  return {
    mode: 'firebase',
    onConn: cb => { connCb = cb; },
    onAuth: cb => A.onAuthStateChanged(auth, user => {
      if (!user) { stop(); uid = null; }
      else if (user.uid !== uid) { stop(); uid = user.uid; start(); }
      cb(user);
    }),
    // вход по логину и паролю: логин → служебный e-mail <логин>@kss.app (Firebase Auth требует e-mail)
    signIn: (login, pass) => A.signInWithEmailAndPassword(auth, mail(login), pass).catch(e => { throw new Error(authMsg(e)); }),
    signOut: () => A.signOut(auth),
    async changePassword(oldPass, newPass) {
      const u = auth.currentUser;
      try {
        await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, oldPass));
        await A.updatePassword(u, newPass);
      } catch (e) { throw new Error(authMsg(e)); }
    },
    onStats: (cb, range) => sub('stats', cb, () => {
      const a = range ? dk(range.from) : '', z = range ? dk(range.to) : '9999';
      const r = { total: 0, ok: 0, errors: 0, earned: 0 };
      for (const [k, x] of Object.entries(C.stats)) {
        if (k < a || k > z) continue;
        r.total += x.total || 0; r.ok += x.ok || 0; r.errors += x.errors || 0; r.earned += x.earned || 0;
      }
      return r;
    }),
    // команда серверу через Firestore (когда сайт открыт не с локального сервера): control/rpc_* → сервер выполняет → ответ в тот же документ
    async rpc(method, path, body) {
      if (!engine || !engine.lastSeen || Date.now() - engine.lastSeen > ENGINE_TTL) throw new Error('сервер не запущен — запустите его на компьютере');
      const id = 'rpc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const ref = F.doc(fs, 'control', id);
      await F.setDoc(ref, { kind: 'rpc', status: 'pending', method, path, body: body == null ? '' : JSON.stringify(body), at: Date.now() });
      ST.writes++;
      const cleanup = n => { F.deleteDoc(ref).catch(() => {}); for (let i = 0; i < (n || 0); i++) F.deleteDoc(F.doc(fs, 'control', id + '_p' + i)).catch(() => {}); };
      let d;
      try {
        d = await new Promise((resolve, reject) => {
          let off = () => {};
          const t = setTimeout(() => { off(); reject(new Error('сервер не ответил за 2 минуты')); }, 120000);
          off = F.onSnapshot(ref, s => { const x = s.data(); if (x && x.status === 'done') { clearTimeout(t); off(); resolve(x); } }, e => { clearTimeout(t); reject(e); });
        });
        let text = d.resp || '';
        if (d.parts > 0) {
          const parts = await Promise.all(Array.from({ length: d.parts }, (_, i) => F.getDoc(F.doc(fs, 'control', id + '_p' + i))));
          text = parts.map(p => p.data()?.data || '').join('');
        }
        ST.reads += 1 + (d.parts || 0);
        cleanup(d.parts);
        return { code: d.code || 200, text };
      } catch (e) { cleanup(d && d.parts); throw e; }
    },
    // один логин — одна строка: если в базе остались старые дубли, берём самую свежую запись
    // таймер лимита (control/cooldowns) — для сайта без локального сервера; возвращает отписку
    onCooldowns: (cb, onErr) => F.onSnapshot(F.doc(fs, 'control', 'cooldowns'), s => cb(s.exists() ? (s.data().list || []) : []), e => onErr && onErr(e)),
    onWorkers: cb => sub('workers', cb, () => {
      const best = new Map();
      for (const w of list(C.workers, (a, b) => (a.since || 0) - (b.since || 0))) { const p = best.get(w.login); if (!p || (w.since || 0) >= (p.since || 0)) best.set(w.login, w); }
      return [...best.values()];
    }),
    onTargets: cb => sub('targets', cb, () => list(C.targets, (a, b) => (b.ts || 0) - (a.ts || 0))),
    onRun: cb => sub('run', cb, () => running),
    onEngine: cb => sub('engine', cb, () => ({ seen: !!engine, lastSeen: engine?.lastSeen || 0, ttl: ENGINE_TTL, version: engine?.version || '', note: engine?.note || '', chatSince: engine?.chat_since || 0, funnelNext: engine?.funnel_next_tick_at || 0, funnelSince: engine?.funnel_since || 0, funnelOnly: engine?.funnel_only || [] })),
    info: () => ({
      project: firebaseConfig.projectId, user: auth.currentUser?.email || '', ...ST,
      cache: { workers: Object.keys(C?.workers || {}).length, targets: Object.keys(C?.targets || {}).length, days: Object.keys(C?.stats || {}).length, logs: (C?.logs || []).length },
    }),
    onLogs(cb) {
      cb(C.logs.slice());
      const f = fresh => cb(fresh); subs.logs.add(f); return () => subs.logs.delete(f);
    },
    async addWorker(d) {
      const login = String(d.login || '').trim();
      if (!login || !d.password) throw new Error('Нужны логин и пароль');
      if (Object.values(C.workers).some(w => w.login === login)) throw new Error('Аккаунт ' + login + ' уже есть');
      // пароль и 2FA в Firestore НЕ пишутся (см. other/firestore-schema.md)
      const b = batch();
      b.set(F.doc(col('workers')), { login, proxy: String(d.proxy || '').trim(), status: 'idle', since: Date.now(), deleted: false });
      b.log('info', `Аккаунт ${login} добавлен`);
      await b.commit();
    },
    async removeWorker(id) {
      const w = C.workers[id]; if (!w) return;
      const b = batch();
      b.set(F.doc(fs, 'workers', id), { deleted: true });
      b.log('info', `Аккаунт ${w.login} удалён`);
      await b.commit();
    },
    async addTarget(d) {
      const name = String(d.name || '').trim();
      if (!name) throw new Error('Укажите цель');
      const ts = Date.now(), value = Number(d.value) || 0, b = batch();
      b.set(F.doc(col('targets')), { name, value, status: STATUSES.includes(d.status) ? d.status : 'taken', ts, deleted: false });
      b.stat(dk(ts), 'total', 1);
      b.log('info', `Цель ${name} добавлена ($${value})`);
      await b.commit();
    },
    async removeTarget(id) {
      const t = C.targets[id]; if (!t) return;
      const b = batch();
      b.set(F.doc(fs, 'targets', id), { deleted: true, deleted_at: Date.now() }, true); // merge: статус и воркер сохраняются — воронка доделает отмену заявки
      if (t.earned != null && t.okDay) { b.stat(t.okDay, 'ok', -1); b.stat(t.okDay, 'earned', -(t.earned || 0)); } // оплата удалённой цели не считаем
      await b.commit();
    },
    async updateTarget(id, d) {
      const t = C.targets[id];
      if (!t) throw new Error('Цель не найдена');
      const status = STATUSES.includes(d.status) ? d.status : t.status;
      const paid = d.paid === 'on' || d.paid === true;
      let amt = null;
      if (paid) {
        amt = Number(d.earned);
        if (d.earned === '' || d.earned == null || !Number.isFinite(amt) || amt < 0) throw new Error('Укажите сумму оплаты');
      }
      const hadPaid = t.earned != null;
      const b = batch(), upd = { status };
      if (d.value !== undefined && d.value !== '') upd.value = Number(d.value) || 0;
      if (hadPaid && t.okDay) { b.stat(t.okDay, 'ok', -1); b.stat(t.okDay, 'earned', -(t.earned || 0)); }
      if (paid) {
        const okDay = /^\d{4}-\d\d-\d\d$/.test(d.paidDate || '') ? d.paidDate : (hadPaid && t.okDay ? t.okDay : dk(Date.now()));
        Object.assign(upd, { earned: amt, okDay });
        b.stat(okDay, 'ok', 1); b.stat(okDay, 'earned', amt);
      } else { upd.earned = F.deleteField(); upd.okDay = F.deleteField(); }
      b.set(F.doc(fs, 'targets', id), upd, true);
      if (t.status !== status) b.log(status === 'failed' ? 'warn' : 'info', `Цель ${t.name}: ${ST_LABEL[status]}`);
      if (paid && !(hadPaid && t.earned === amt)) b.log('success', `Цель ${t.name}: оплата $${amt}`);
      else if (t.status === status) b.log('info', `Цель ${t.name} обновлена`);
      await b.commit();
    },
    // очистка консоли сбрасывает и счётчик ошибок — как в локальном режиме
    async clearLogs() {
      const items = C.logs.slice(); C.logs = [];
      try { localStorage.setItem('pm_logs_cleared_' + uid, String(Date.now())); } catch {}
      persist();
      for (let i = 0; i < items.length; i += 400) {
        const b = batch();
        for (const l of items.slice(i, i + 400)) { b.del(F.doc(fs, 'logs', l.id)); if (l.level === 'error') b.stat(dk(l.ts), 'errors', -1); }
        await b.commit();
      }
    },
    async setRunning(v) {
      const ctl = F.doc(fs, 'control', 'state');
      if (!v) { await F.setDoc(ctl, { running: false, updatedAt: now() }, { merge: true }); return; }
      // проверка движка по control/engine {lastSeen: ms} (слушатель уже держит документ — отдельного чтения нет)
      // + должен быть хотя бы один воркер — проверка инвентаря снова идёт через воркеров (лейны)
      let why = '';
      if (!engine || !engine.lastSeen || Date.now() - engine.lastSeen > ENGINE_TTL) why = 'движок не отвечает (сервер не запущен)';
      else if (!Object.keys(C.workers || {}).length) why = 'нет воркеров, добавьте аккаунт';
      // + лицензия: «Старт» не должен срабатывать, пока доступ закрыт администратором
      if (!why) {
        try {
          const r = await fetch('https://firestore.googleapis.com/v1/projects/vlad-licenses/databases/(default)/documents/licenses/ffb5f771-01fae7ee-e6b85c67-32913c09');
          if (r.status === 404) why = 'лицензия не найдена';
          else if (r.ok) {
            const doc = await r.json(); const f = (doc && doc.fields) || {};
            const active = !!(f.active && f.active.booleanValue === true);
            const paidUntil = (f.paidUntil && f.paidUntil.stringValue) || '';
            if (!(active && paidUntil >= new Date().toISOString().slice(0, 10))) why = !active ? 'доступ закрыт администратором' : ('истёк срок оплаты (до ' + paidUntil + ')');
          }
        } catch (_) {} // нет сети до лицензии — не блокируем из-за временного сбоя, решит сервер
      }
      if (why) {
        const b = batch(); b.log('error', 'Старт: не выполнен — ' + why); b.stat(dk(Date.now()), 'errors', 1); await b.commit();
        return;
      }
      await F.setDoc(ctl, { running: true, updatedAt: now() }, { merge: true });
    },
  };
}

export async function createDB() {
  if (apiBase) return restDB();   // задан URL бэкенда — работаем через REST
  if (useFirebase) {
    try { return await fbDB(); } catch (e) { console.error('Firebase init failed', e); }
  }
  return apiBase ? restDB() : localDB();
}
