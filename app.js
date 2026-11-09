import { createDB } from './db.js';
import { apiBase } from './firebase-config.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const db = await createDB();

const WORKER_ST = {
  idle: ['idle', 'Ожидает'], working: ['ok', 'Работает'], limit: ['warn', 'Лимит'], error: ['err', 'Ошибка'],
  Active: ['ok', 'Активен'], AuthError: ['err', 'Ошибка входа'], RateLimit: ['warn', 'Лимит'],
  Error: ['err', 'Ошибка'], Offline: ['idle', 'Офлайн'], Disabled: ['idle', 'Отключён'],
};
const TARGET_ST = { taken: 'Взято в работу', invited: 'Заявка отправлена — ждём принятия', waiting: 'Заявка отправлена — ждём принятия', accepted: 'Приняли заявку — скоро напишем', completed: 'Успешно — всё отправлено, клиент у нас, следим за ответом', action_needed: 'Клиент ответил — нужен ваш ответ', canceled: 'Не приняли за 3 ч — заявка отозвана скриптом', success: 'Успешно — всё отправлено, клиент у нас, следим за ответом', failed: 'Неуспешно' };
const TARGET_SHORT = { taken: 'Взято', waiting: 'Ждём принятия', accepted: 'Приняли', action_needed: 'Ответ!', canceled: 'Отменено', success: 'Успешно', failed: 'Неуспешно' };
const HI_VALUE = 300;
const LEVELS = { info: 'ИНФО', success: 'УСПЕХ', warn: 'ВНИМАНИЕ', error: 'ОШИБКА' };
const money = v => '$' + Number(v || 0).toLocaleString('en-US');

// ---------- sparkline ----------
const hist = { w: [], t: [] };
function spark(svg, arr, v) {
  arr.push(v); if (arr.length > 24) arr.shift();
  svg.replaceChildren();
  if (arr.length < 2) return;
  const W = 64, H = 24, min = Math.min(...arr), r = Math.max(...arr) - min || 1;
  const pts = arr.map((x, i) => `${(i / (arr.length - 1) * W).toFixed(1)},${(H - 3 - (x - min) / r * (H - 6)).toFixed(1)}`).join(' ');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  p.setAttribute('points', pts);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.append(p);
}

// ---------- stats ----------
function renderStats(s) {
  const total = s.total ?? 0, ok = s.ok ?? 0, err = s.errors ?? 0;
  $('stTotal').textContent = total.toLocaleString('en-US');
  $('stOk').textContent = money(s.earned || 0);
  $('stErr').textContent = err.toLocaleString('en-US');
  const base = Math.max(total, ok + err);
  $('stOkPct').textContent = ok ? ok + ' ' + (ok % 10 === 1 && ok % 100 !== 11 ? 'оплата' : (ok % 10 >= 2 && ok % 10 <= 4 && (ok % 100 < 12 || ok % 100 > 14) ? 'оплаты' : 'оплат')) : '';
  $('stErrPct').textContent = base ? (err / base * 100).toFixed(2) + '%' : '';
  spark($('spT'), hist.t, total);
}

// ---------- period + calendar ----------
const sod = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const eod = d => { const x = sod(d); x.setHours(23, 59, 59, 999); return x; };
const today = () => sod(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const PRESETS = [
  { key: 'today', name: 'Сегодня', get: () => [today(), today()] },
  { key: 'week', name: 'Неделя', get: () => [addDays(today(), -6), today()] },
  { key: 'month30', name: 'Месяц', get: () => [addDays(today(), -29), today()] },
  { key: 'thisMonth', name: 'Этот месяц', get: () => { const t = today(); return [new Date(t.getFullYear(), t.getMonth(), 1), t]; } },
  { key: 'all', name: 'Всё время', get: () => [null, null] },
];
const short = d => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const rangeText = (a, b) =>
  a.getTime() === b.getTime() ? short(a)
  : a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear() ? `${a.getDate()}–${short(b)}`
  : `${short(a)} – ${short(b)}`;

let period, statsUnsub = null;
function periodLabel(p) {
  if (!p.from) return 'Всё время';
  const t = rangeText(p.from, p.to);
  const pr = PRESETS.find(x => x.key === p.key);
  return pr ? `${pr.name} · ${t}` : t;
}
const rangeOf = p => p.from ? { from: sod(p.from).getTime(), to: eod(p.to).getTime() } : null;

function subStats() {
  if (statsUnsub) statsUnsub();
  hist.t = [];
  statsUnsub = db.onStats(renderStats, rangeOf(period));
}
function applyPeriod(p, fromRoute = false) {
  period = p;
  $('periodLabel').textContent = periodLabel(p);
  renderPresets();
  if (userReady) subStats();
  if (!fromRoute) syncHash();
}
const presetPeriod = key => { const [from, to] = PRESETS.find(p => p.key === key).get(); return { key, from, to }; };

function renderPresets() {
  const box = $('presets'); box.replaceChildren();
  for (const p of PRESETS) {
    const b = el('button', period.key === p.key ? 'on' : '', p.name);
    b.onclick = () => { applyPeriod(presetPeriod(p.key)); closePop(); };
    box.append(b);
  }
}

const cal = { y: 0, m: 0, start: null, end: null, hover: null };
function renderCal() {
  const title = new Date(cal.y, cal.m, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  $('calTitle').textContent = title[0].toUpperCase() + title.slice(1);
  const first = new Date(cal.y, cal.m, 1);
  const startCell = addDays(first, -((first.getDay() + 6) % 7));
  const s = cal.start?.getTime(), e = cal.end?.getTime() ?? cal.hover;
  const lo = s != null && e != null ? Math.min(s, e) : s, hi = s != null && e != null ? Math.max(s, e) : null;
  const t0 = today().getTime();
  const grid = $('calGrid'); grid.replaceChildren();
  for (let i = 0; i < 42; i++) {
    const d = addDays(startCell, i), t = d.getTime();
    const cls = [];
    if (d.getMonth() !== cal.m) cls.push('out');
    if (t === t0) cls.push('today');
    if (hi != null && t > lo && t < hi) cls.push('in');
    if (t === lo) cls.push('s');
    if (hi != null && t === hi && hi !== lo) cls.push('e');
    const b = el('button', cls.join(' '), d.getDate());
    b.type = 'button'; b.dataset.t = t;
    grid.append(b);
  }
  $('calSel').textContent = cal.start ? rangeText(cal.start, cal.end || cal.start) : 'Выберите даты';
  $('calApply').disabled = !cal.start;
}
$('calGrid').onclick = ev => {
  const b = ev.target.closest('button'); if (!b) return;
  const d = new Date(+b.dataset.t);
  if (!cal.start || cal.end) { cal.start = d; cal.end = null; }
  else { cal.end = d; if (cal.end < cal.start) [cal.start, cal.end] = [cal.end, cal.start]; }
  cal.hover = null; renderCal();
};
$('calGrid').onmouseover = ev => {
  const b = ev.target.closest('button');
  if (!b || !cal.start || cal.end || cal.hover === +b.dataset.t) return;
  cal.hover = +b.dataset.t; renderCal();
};
$('calGrid').onmouseleave = () => { if (cal.hover != null) { cal.hover = null; renderCal(); } };
const shiftMonth = n => { const d = new Date(cal.y, cal.m + n, 1); cal.y = d.getFullYear(); cal.m = d.getMonth(); renderCal(); };
$('calPrev').onclick = () => shiftMonth(-1);
$('calNext').onclick = () => shiftMonth(1);
$('calApply').onclick = () => {
  if (!cal.start) return;
  applyPeriod({ key: 'custom', from: cal.start, to: cal.end || cal.start });
  closePop();
};
function openPop() {
  const ref = period.to || today();
  Object.assign(cal, { y: ref.getFullYear(), m: ref.getMonth(), start: period.from, end: period.from ? period.to : null, hover: null });
  renderPresets(); renderCal();
  $('periodPop').hidden = false;
}
function closePop() { $('periodPop').hidden = true; }
$('periodBtn').onclick = () => $('periodPop').hidden ? openPop() : closePop();
document.addEventListener('pointerdown', e => { if (!$('periodPop').hidden && !e.target.closest('.period')) closePop(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });

// ---------- workers ----------
// кнопка удаления: всегда заметная иконка-корзина (константный SVG, без данных пользователя)
function trashBtn() {
  const b = el('button', 'x del'); b.type = 'button';
  b.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M10 11v6M14 11v6"/></svg>');
  return b;
}
const ago = ms => {
  if (!ms) return '—';
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return m + ' мин назад';
  const h = Math.floor(m / 60);
  return h < 24 ? h + ' ч назад' : Math.floor(h / 24) + ' д назад';
};

function renderWorkers(list) {
  const body = $('wBody');
  body.replaceChildren();
  $('wCount').textContent = list.length;
  $('wT').textContent = list.length;
  const active = list.filter(w => w.status === 'working' || w.status === 'Active').length;
  $('wA').textContent = active;
  spark($('spW'), hist.w, active);
  if (!list.length) {
    const tr = el('tr'), td = el('td', 'empty', 'Нет аккаунтов. Нажмите «+ Добавить»'); td.colSpan = 5; tr.append(td); body.append(tr); return;
  }
  for (const w of list) {
    const [cls, label] = WORKER_ST[w.status] || ['err', w.status || '—'];
    const tr = el('tr');
    const errText = w.lastError && (w.lastError.message || String(w.lastError));
    const pill = el('span', 'pill ' + cls, label); if (errText) pill.title = errText;
    const st = el('td'); st.append(pill);
    const del = trashBtn(); del.title = 'Удалить';
    del.onclick = async () => {
      if (await confirmBox('Удалить воркера?', `Аккаунт ${w.login} будет удалён из списка. Это нельзя отменить.`)) {
        apiFetch(API + '/workers/' + encodeURIComponent(w.login), { method: 'DELETE' })
          .then(r => { if (r.status === 404) throw new Error('сервер устарел — перезапустите сервер'); if (!r.ok) throw new Error('DELETE → ' + r.status); logLine(`Воркер ${w.login} удалён`, 'info'); return fetchWorkers(); })
          .catch(e => logLine(`Не удалось удалить воркера ${w.login}: ${e.message}`));
      }
    };
    const off = w.status === 'Disabled';
    const tog = el('button', 'ghost', off ? 'Включить' : 'Отключить'); tog.type = 'button'; tog.style.marginRight = '6px';
    tog.onclick = async () => {
      tog.disabled = true;
      try {
        const r = await apiFetch(API + '/workers/' + encodeURIComponent(w.login) + (off ? '/enable' : '/disable'), { method: 'POST' });
        const res = await r.json().catch(() => ({}));
        if (r.status === 404 && !res.error) throw new Error('сервер устарел — перезапустите сервер');
        if (!r.ok) throw new Error(res.error || r.status);
        if (!off) logLine(`Воркер ${w.login} отключён (выход из Steam)`, 'info');
        else if (res.status === 'Active') logLine(`Воркер ${w.login} включён, вход выполнен`, 'success');
        else if (res.status === 'RateLimit') logLine(`Воркер ${w.login} включён, но Steam временно ограничил вход (лимит)`, 'warn');
        else logLine(`Воркер ${w.login} включён, но вход не выполнен: ${(res.lastError && res.lastError.message) || res.status}`);
      } catch (e) { logLine(`Воркер ${w.login}: не удалось ${off ? 'включить' : 'отключить'} — ${e.message}`); }
      await fetchWorkers();
    };
    const prx = el('button', 'ghost', w.proxy ? 'Прокси ✎' : '+ Прокси'); prx.type = 'button'; prx.style.marginRight = '6px';
    prx.onclick = () => openProxyModal(w);
    const sec = el('button', 'ghost', w.hasSecret ? '2FA ✎' : '+ 2FA'); sec.type = 'button'; sec.style.marginRight = '6px';
    sec.onclick = () => openSecretModal(w);
    const act = el('td'); act.append(tog, prx, sec, del);
    const lg = el('td', '');
    const lnk = el('a', 'wlink', w.login); lnk.href = '#'; lnk.title = 'Что делает этот профиль'; lnk.onclick = ev => { ev.preventDefault(); openWorkerInfo(w.login); }; lg.append(lnk);
    if (errText) lg.append(el('small', 'werr', errText));
    tr.append(lg, st, el('td', 'm', w.steamId || w.proxy || 'без прокси'), el('td', 'm', ago(w.since ?? w.updatedAt)), act);
    body.append(tr);
  }
}

// ---------- карточка воркера: статус, таймеры, очередь, журнал действий ----------
const fmtLeft = ms => {
  if (ms <= 0) return 'сейчас';
  const s = Math.ceil(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), c = s % 60;
  if (d) return `${d} д ${h} ч ${m} мин`;
  return (h ? h + ' ч ' : '') + (h || m ? m + ' мин ' : '') + (!h ? c + ' с' : '');
};
// живые таймеры: любой элемент с data-due (мс) обновляется раз в секунду
setInterval(() => {
  document.querySelectorAll('[data-due]').forEach(n => { n.textContent = (n.dataset.pre || '') + fmtLeft(Number(n.dataset.due) - Date.now()); });
}, 1000);

// Путь цели в воронке: [{ label, state: done|now|next|skip, at, due, note }]
// сервер пишет время тика редко (раз в ~5 минут): между записями следующий тик досчитываем шагами по 60 с, пока сервер жив
const fnNext = () => { if (!funnelNext) return 0; const now = Date.now(); if (funnelNext >= now - 5000 || !engineAlive()) return funnelNext; return funnelNext + Math.ceil((now - 5000 - funnelNext) / 60000) * 60000; };
let chatSince = 0, funnelNext = 0, funnelSince = 0, funnelOnly = []; // когда воронка в следующий раз проверит цели (приходит с сервера)
const WAIT_MS = 3 * 3600e3, FU_MIN = 5 * 60e3, FU_MAX = 10 * 60e3;
function pathOf(t) {
  if (funnelSince && t.status === 'taken') {
    if (funnelOnly.length && !funnelOnly.includes(String(t.id)))
      return [{ label: 'Тест-режим: заявка этой цели не отправляется', state: 'skip', note: 'включён тест-режим сервера (FUNNEL_ONLY_OWN=1 в .env): воронка работает только для своих ID. Уберите эту строку из .env и перезапустите сервер' }];
    if (!funnelOnly.length && !((t.ts || 0) >= funnelSince))
      return [{ label: 'Старая запись — воронка её не обрабатывает', state: 'skip', note: 'создана до запуска воронки: в работу берутся только новые цели' }];
  }
  const st = t.status, by = t.worker ? ` · воркер ${t.worker}` : '';
  const P = [];
  if (st === 'failed') return [{ label: 'Не попала в воронку', state: 'skip', note: t.failReason || 'неуспешно' }];
  if (st === 'success' || st === 'invited') return [{ label: TARGET_ST[st], state: 'done', note: 'выставлено вручную, воронка не трогает' }];
  P.push({ label: 'Взято в работу', state: 'done', at: t.ts });
  P.push(st === 'taken'
    ? { label: 'Отправка заявки в друзья', state: 'now', worker: t.planned_worker, wlabel: '🤖 отправит воркер: ', noWorkerText: 'воркер пока не назначен — нет свободных (не в сети или исчерпан лимит 10 заявок)', ...(funnelNext > Date.now() - 5000 ? { due: funnelNext, pre: 'отправка через ' } : { note: 'воронка не отвечает — сервер выключен?' }), note2: 'нужен воркер в сети, лимит 10 заявок в день на воркера (сообщения в лимит не входят)' }
    : { label: 'Заявка в друзья отправлена', state: 'done', at: t.waiting_since, worker: t.worker, noWorker: !t.worker });
  const cancelAt = (t.waiting_since || 0) + WAIT_MS;
  if (st === 'taken') P.push({ label: 'Ждём принятия заявки (до 3 ч)', state: 'next', note: 'таймер 3 ч стартует после отправки' });
  else if (st === 'waiting') P.push({ label: 'Ждём принятия заявки', state: 'now', due: cancelAt, pre: 'отмена через ' });
  else if (st === 'canceled') P.push({ label: 'Заявку не приняли за 3 ч', state: 'done', at: t.canceled_at || cancelAt });
  else P.push({ label: 'Заявку приняли', state: 'done', at: t.accepted_at, worker: t.worker, noWorker: !t.worker });
  // ветка «приняли»
  if (st === 'accepted') {
    const d = t.followup_delay_ms;
    P.push({ label: 'Пауза перед первым сообщением', state: 'now', due: t.accepted_at && d ? t.accepted_at + d : null, pre: 'сообщение через ', note: d ? '' : 'случайно 5–10 мин' });
  } else if (st === 'action_needed') {
    P.push(t.completed_at || t.last_out_at
      ? { label: 'Первое сообщение отправлено', state: 'done', at: t.completed_at, worker: t.worker, noWorker: !t.worker }
      : { label: 'Первое сообщение НЕ отправлялось (клиент написал первым)', state: 'skip', note: 'нажмите «Запустить заново» — сообщение уйдёт по таймеру, или напишите сами' });
    P.push({ label: 'Клиент ответил — нужен ваш ответ', state: 'now', at: t.action_needed_at, note: t.last_reply ? '«' + t.last_reply.slice(0, 120) + '»' : '' });
  } else if (st === 'completed') {
    P.push({ label: 'Первое сообщение отправлено', state: 'done', at: t.completed_at, worker: t.worker, noWorker: !t.worker });
  } else if (st !== 'canceled') {
    P.push({ label: 'Если примут → пауза 5–10 мин → первое сообщение', state: 'next' });
  }
  // ветка «не приняли»
  if (st === 'canceled') P.push({ label: 'Заявка отменена (удалён из друзей)', state: 'done', at: t.canceled_at, worker: t.worker, noWorker: !t.worker });
  else if (st === 'taken' || st === 'waiting') P.push({ label: 'Если не примут за 3 ч → отмена заявки, слот освободится', state: 'next', due: st === 'waiting' ? cancelAt : null, pre: 'через ' });
  // ошибка последней попытки + обратный отсчёт до повтора — на текущем шаге
  const cur = P.find(x => x.state === 'now');
  if (cur && t.last_error) { cur.err = t.last_error + ` · попытка №${t.try_count || 1}` + (t.last_error_at ? ' · ' + fmtAt(t.last_error_at) : ''); if (t.next_try_at) cur.retryDue = retryAt(t); }
  return P;
}
const fmtAt = ms => ms ? new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
function renderPath(t) {
  const box = $('editPath'); box.replaceChildren();
  const stv = t.status, ctl = $('editCtl');
  ctl.hidden = !['taken', 'waiting', 'accepted', 'canceled', 'completed', 'action_needed'].includes(stv);
  $('tCancel').hidden = !['taken', 'waiting', 'accepted'].includes(stv);
  $('tSendNow').hidden = stv !== 'accepted';
  if ($('tCtlMsg') && ctl.dataset.for !== String(t.id)) { $('tCtlMsg').textContent = ''; ctl.dataset.for = String(t.id); }
  const steps = pathOf(t);
  box.hidden = false;
  box.append(el('div', 'tp-h', 'Путь цели'));
  for (const s of steps) {
    const r = el('div', 'tp-s ' + s.state);
    r.append(el('i', 'dot'));
    const b = el('div', 'tp-b');
    b.append(el('div', 'tp-l', s.label));
    const sub = [s.at ? fmtAt(s.at) : '', s.note || '', s.note2 || ''].filter(Boolean).join(' · ');
    if (sub) b.append(el('div', 'tp-n', sub));
    if (s.due) { const tm = el('div', 'tp-t', ''); tm.dataset.due = s.due; tm.dataset.pre = s.pre || ''; tm.textContent = (s.pre || '') + fmtLeft(s.due - Date.now()); b.append(tm); }
    if (s.worker) b.append(el('div', 'tp-w', (s.wlabel || '🤖 воркер: ') + s.worker));
    else if (s.noWorkerText) b.append(el('div', 'tp-w none', s.noWorkerText));
    else if (s.noWorker) b.append(el('div', 'tp-w none', 'воркер не определён — запись старая или статус выставлен вручную (воронка заявку не отправляла)'));
    if (s.err) b.append(el('div', 'tp-e', '⚠ Ошибка: ' + s.err));
    if (s.retryDue) { const rt = el('div', 'tp-t err', ''); rt.dataset.due = s.retryDue; rt.dataset.pre = 'повтор через '; rt.textContent = 'повтор через ' + fmtLeft(s.retryDue - Date.now()); b.append(rt); }
    r.append(b); box.append(r);
  }
}
// Когда реально произойдёт повтор: первая проверка воронки, не раньше next_try_at
function retryAt(t) {
  let at = t.next_try_at || 0;
  if (fnNext() > Date.now() - 5000) { let k = fnNext(); while (k < at - 10000) k += 60000; at = k; }
  return at;
}
// короткая строка «что дальше» в карточке списка
function nextLine(t) {
  if (pathOf(t)[0]?.state === 'skip' && t.status === 'taken') return { text: funnelOnly.length ? 'тест-режим: заявку не отправляем (только свой ID)' : 'старая запись — заявку не отправляем' };
  if (t.last_error && t.next_try_at) return { due: retryAt(t), pre: '⚠ ошибка, повтор через ' };
  if (t.status === 'taken') return fnNext() > Date.now() - 5000 ? { due: fnNext(), pre: '→ заявка в друзья через ' } : { text: '→ заявка в друзья: воронка не отвечает' };
  if (t.status === 'waiting' && t.waiting_since) return { due: t.waiting_since + WAIT_MS, pre: '→ нет ответа — отмена через ' };
  if (t.status === 'accepted' && t.accepted_at) return { due: t.accepted_at + (t.followup_delay_ms || FU_MAX), pre: '→ первое сообщение через ' };
  return null;
}
let wiTimer = null, wiLogin = null, wiLeft = [];
async function refreshWorkerInfo() {
  if (!wiLogin) return;
  try {
    const r = await apiFetch(API + '/workers/' + encodeURIComponent(wiLogin) + '/activity', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'сервер устарел — перезапустите сервер' : 'GET → ' + r.status);
    const d = await r.json();
    const [cls, label] = WORKER_ST[d.status] || ['err', d.status || '—'];
    const pill = $('wiStatus'); pill.className = 'pill ' + cls; pill.textContent = label;
    const meta = $('wiMeta'); meta.replaceChildren();
    const row = (k, v) => { const p = el('div', 'wi-row'); p.append(el('span', 'k', k), el('span', 'v', v)); meta.append(p); };
    row('Steam ID', d.steamId || '—');
    row('Прокси', d.proxy || 'без прокси');
    row('Заявок в друзья сегодня', d.dailyLimit ? `${d.requestsToday || 0} / ${d.dailyLimit}` : '—');
    if (d.lastError) row('Последняя ошибка', d.lastError.message || String(d.lastError));
    wiLeft = [];
    const tm = $('wiTimers'); tm.replaceChildren();
    for (const t of d.timers || []) { const p = el('div', 'wi-row'), v = el('span', 'v', fmtLeft(t.remainingMs)); p.append(el('span', 'k', t.label), v); tm.append(p); wiLeft.push({ v, end: Date.now() + t.remainingMs }); }
    if (!(d.timers || []).length) tm.append(el('div', 'wi-empty', 'Активных пауз нет — воркер свободен'));
    const q = $('wiQueue'); q.replaceChildren();
    for (const t of d.queue || []) { const p = el('div', 'wi-row'), v = el('span', 'v', fmtLeft(t.remainingMs)); p.append(el('span', 'k', t.steamId + ' — ' + t.what), v); q.append(p); wiLeft.push({ v, end: Date.now() + t.remainingMs }); }
    if (!(d.queue || []).length) q.append(el('div', 'wi-empty', 'Целей в ожидании нет'));
    const lg = $('wiLog'); lg.replaceChildren();
    for (const a of d.activity || []) {
      const p = el('div', 'wi-line ' + (a.level || 'info'));
      p.append(el('span', 'ts', new Date(a.ts).toLocaleTimeString('ru-RU')), el('span', '', a.text));
      lg.append(p);
    }
    if (!(d.activity || []).length) lg.append(el('div', 'wi-empty', 'Пока ничего не происходило (журнал обнуляется при перезапуске сервера)'));
  } catch (e) { $('wiMeta').replaceChildren(el('div', 'wi-empty', 'Не удалось загрузить: ' + e.message)); }
}
function openWorkerInfo(login) {
  const dlg = $('mWInfo');
  wiLogin = login; $('wiLogin').textContent = login;
  document.documentElement.classList.add('lock');
  if (!dlg.open) dlg.showModal();
  refreshWorkerInfo();
  clearInterval(wiTimer);
  let n = 0;
  wiTimer = setInterval(() => {
    if (!dlg.open) { clearInterval(wiTimer); wiLogin = null; return; }
    for (const t of wiLeft) t.v.textContent = fmtLeft(t.end - Date.now()); // тикает каждую секунду
    if (++n % 4 === 0) refreshWorkerInfo();                                 // данные — раз в 4 с
  }, 1000);
}

// ---------- REST-режим: воркеры с бэкенда ----------
const API = apiBase || '/api';
// Сайт может быть открыт без локального сервера (GitHub Pages, телефон): тогда данные идут из Firestore,
// а действия, которым нужен сервер (воркеры, источники, чат…), недоступны — вместо них понятное сообщение.
let apiUp = null, apiProbeAt = 0;
const apiProbe = () => { apiProbeAt = Date.now(); return fetch(API + '/workers', { cache: 'no-store' }).then(r => (apiUp = r.ok && /json/.test(r.headers.get('content-type') || '')), () => (apiUp = false)); };
let apiProbing = apiProbe();
// действия, которые сервер выполняет по команде из Firestore, когда сайт открыт НЕ с локального сервера (GitHub, телефон)
const RPC_OK = [
  /^\/targets\/[^/]+\/(cancel|restart|chat|reply|send-now)$/, /^\/update-prices$/, /^\/prices$/,
  /^\/workers\/[^/]+\/(activity|enable|disable|guard-login|proxy)$/, /^\/sources(\/[^/]+)?$/, /^\/cybershoke\/modes$/, /^\/messages$/,
];
const rpcCache = new Map();
async function apiFetch(url, opts) {
  if (apiUp === null) await apiProbing;
  if (!apiUp && Date.now() - apiProbeAt > 10000) await (apiProbing = apiProbe());
  if (apiUp) return fetch(url, opts);
  const path = String(url).slice(API.length).split('?')[0];
  if (db.rpc && RPC_OK.some(re => re.test(path))) {
    const method = (opts && opts.method) || 'GET';
    // опросы (источники, чат, сообщения…) не должны долбить базу: одинаковые GET-запросы берём из кэша на 15 с, любая запись его сбрасывает
    if (method === 'GET') { const c = rpcCache.get(path); if (c && Date.now() - c.at < 15000) return new Response(c.text, { status: c.code, headers: { 'Content-Type': 'application/json' } }); }
    else rpcCache.clear();
    const r = await db.rpc(method, path, opts && opts.body ? JSON.parse(opts.body) : null);
    if (method === 'GET' && r.code < 400) rpcCache.set(path, { at: Date.now(), ...r });
    return new Response(r.text, { status: r.code, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('это действие (пароли, 2FA, добавление воркеров) доступно только когда сайт открыт с компьютера: запустите сервер и откройте http://localhost:3000');
}
// GET /api/workers → [{ login, status, steamId, lastError }]; очищает таблицу и рендерит заново
async function fetchWorkers() {
  if (document.hidden || !apiUp) return;
  try {
    const r = await apiFetch(API + '/workers', { cache: 'no-store' });
    if (!r.ok) throw new Error(`GET /workers → ${r.status}`);
    renderWorkers(await r.json());
  } catch (e) {
    const body = $('wBody'); body.replaceChildren();
    const tr = el('tr'), td = el('td', 'empty', 'Бэкенд недоступен: ' + e.message); td.colSpan = 5; tr.append(td); body.append(tr);
  }
}
// POST /api/add-worker { login, password, sharedSecret } → { login, status, lastError }
// Итог входа пишем в консоль (лог) на дашборде.
async function addWorkerRest(d) {
  const login = (d.login || '').trim();
  let r, res;
  try {
    r = await apiFetch(API + '/add-worker', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password: d.password, sharedSecret: d.secret || '', proxy: d.proxy || '' }),
    });
    res = await r.json().catch(() => ({}));
  } catch (e) {
    logLine(`Воркер ${login}: бэкенд недоступен — запрос не отправлен (${e.message})`);
    throw new Error('Бэкенд недоступен');
  }
  if (!r.ok) {
    const m = res.error || `ошибка сервера ${r.status}`;
    logLine(`Воркер ${login}: не добавлен — ${m}`);
    throw new Error(m);
  }
  await fetchWorkers();
  const why = res.lastError && res.lastError.message;
  switch (res.status) {
    case 'Active':
      logLine(`Воркер ${login} добавлен, вход выполнен${res.steamId ? ' (SteamID ' + res.steamId + ')' : ''}`, 'success'); break;
    case 'AuthError':
      logLine(`Воркер ${login} добавлен, но вход не выполнен: ${why || 'неверный логин, пароль или 2FA-код'}`); break;
    case 'RateLimit':
      logLine(`Воркер ${login} добавлен, но Steam временно ограничил вход (лимит). Повторите позже`, 'warn'); break;
    case 'Error':
      logLine(`Воркер ${login} добавлен, но вход не выполнен: ${why || 'неизвестная ошибка'}`); break;
    default:
      logLine(`Воркер ${login} добавлен, статус: ${res.status || 'неизвестен'}`, 'warn');
  }
}
// воркеры всегда идут через бэкенд (/api), цели и логи остаются на Firebase
function watchWorkers() {
  let stopDb = null;
  const tick = async () => {
    if (apiUp === null) await apiProbing;
    if (!apiUp && Date.now() - apiProbeAt > 10000) await (apiProbing = apiProbe());
    if (apiUp) { if (stopDb) { stopDb(); stopDb = null; } fetchWorkers(); }
    else if (!stopDb) stopDb = db.onWorkers(renderWorkers); // сервера нет — показываем воркеров из базы
  };
  tick();
  const id = setInterval(tick, 5000);
  return () => { clearInterval(id); if (stopDb) stopDb(); };
}

// ---------- таймер лимита (чип рядом с «Очистить консоль») ----------
// GET /api/engine/cooldowns → [{ ipKey, label, remainingMs }, ...]; пусто = лимита нет, чип скрыт
function watchCooldown() {
  const chip = $('cooldownChip');
  let data = [];
  const render = () => {
    if (!data.length) { chip.hidden = true; return; }
    const best = data.reduce((a, b) => (a.remainingMs < b.remainingMs ? a : b));
    const secs = Math.max(0, Math.ceil(best.remainingMs / 1000));
    const m = String(Math.floor(secs / 60)).padStart(2, '0'), s2 = String(secs % 60).padStart(2, '0');
    const extra = data.length > 1 ? ` (+${data.length - 1})` : '';
    chip.textContent = `⏳ лимит: ${m}:${s2} — ${best.label}${extra}`;
    chip.hidden = false;
  };
  const tick = setInterval(() => { data = data.map(c => ({ ...c, remainingMs: c.remainingMs - 1000 })).filter(c => c.remainingMs > 0); render(); }, 1000);
  let stopDb = null;
  const poll = async () => {
    if (apiUp === null) await apiProbing;
    if (apiUp) {
      if (stopDb) { stopDb(); stopDb = null; }
      try {
        const r = await apiFetch(API + '/engine/cooldowns', { cache: 'no-store' });
        if (r.ok) { data = await r.json(); render(); }
      } catch (_) { /* бэкенд недоступен — не трогаем чип */ }
    } else if (!stopDb && db.onCooldowns) {
      // сайт открыт не с локального сервера: сервер публикует лимиты в Firestore (control/cooldowns)
      try { stopDb = db.onCooldowns(list => { data = list.map(c => ({ ...c, remainingMs: c.until - Date.now() })).filter(c => c.remainingMs > 0); render(); }, () => { stopDb = null; }); } catch (_) { stopDb = null; }
    }
  };
  poll();
  const id = setInterval(poll, 5000);
  return () => { clearInterval(id); clearInterval(tick); if (stopDb) stopDb(); };
}
watchCooldown();

// ---------- targets ----------
let targets = [], filter = 'all';
const inFilter = (t, k) => k === 'waiting' ? (t.status === 'waiting' || t.status === 'invited') : k === 'success' ? (t.status === 'success' || t.status === 'completed') : t.status === k;
function stText(t) { return t.status === 'canceled' && t.canceled_manual ? 'Отменено вами' : (TARGET_ST[t.status] || t.status); }
function renderFilters() {
  const box = $('filters'); box.replaceChildren();
  for (const [k, label] of [['all', 'Все'], ...Object.entries(TARGET_SHORT)]) {
    const n = k === 'all' ? targets.length : targets.filter(t => inFilter(t, k)).length;
    const b = el('button', (filter === k ? 'on' : '') + (k === 'action_needed' && n ? ' need' : ''), `${label} · ${n}`);
    b.onclick = () => { filter = k; renderTargets(targets); syncHash(); };
    box.append(b);
  }
}
function renderTargets(list) {
  targets = list;
  renderFilters();
  $('tCount').textContent = list.length;
  const box = $('tList'); box.replaceChildren();
  const shown = filter === 'all' ? list : list.filter(t => inFilter(t, filter));
  if (!shown.length) box.append(el('div', 'empty', list.length ? 'В этом статусе целей нет' : 'Целей нет. Нажмите «+ Добавить»'));
  for (const t of shown) {
    const row = el('div', 't' + (t.value >= HI_VALUE ? ' hi' : '') + (t.status === 'action_needed' ? ' need' : ''));
    row.tabIndex = 0; row.title = 'Открыть цель';
    const open = () => { location.hash = buildHash(parseHash().view, 'edit', { id: t.id }); };
    row.onclick = open;
    row.onkeydown = e => { if (e.key === 'Enter' && e.target === row) open(); };
    const del = trashBtn(); del.title = 'Удалить';
    del.onclick = async e => {
      e.stopPropagation();
      if (await confirmBox('Удалить цель?', `Цель ${t.name} будет удалена. Это нельзя отменить.`)) db.removeTarget(t.id).catch(err => logLine(err.message));
    };
    const left = el('div');
    const sub = el('div', 's'); sub.append(el('i', t.status === 'completed' ? 'success' : t.status), document.createTextNode(stText(t)));
    left.append(el('div', 'n', t.name), sub);
    const nx = nextLine(t);
    if (t.mode) left.append(el('div', 'nx', '📍 ' + modeLabel(t.mode)));
    if (t.worker && ['waiting', 'accepted', 'completed', 'action_needed', 'canceled'].includes(t.status)) left.append(el('div', 'nx', 'воркер ' + t.worker));
    else if (t.status === 'taken' && t.planned_worker) left.append(el('div', 'nx', 'отправит воркер ' + t.planned_worker));
    if (t.last_error && t.next_try_at) { const e = el('div', 'nx', '⚠ ' + String(t.last_error).slice(0, 110)); e.title = t.last_error; left.append(e); }
    if (nx) { const l = el('div', 'nx', nx.text || ''); if (nx.due) { l.dataset.due = nx.due; l.dataset.pre = nx.pre; l.textContent = nx.pre + fmtLeft(nx.due - Date.now()); } left.append(l); }
    const right = el('div', 'r'); right.append(el('div', 'val', money(t.value)));
    if (t.earned != null) right.append(el('div', 'earn', 'оплата ' + money(t.earned)));
    row.append(left, right, del);
    box.append(row);
  }
  if (pendingEditId != null) openEdit(pendingEditId);
  else if (editId != null && $('mEdit').open) { const cur = list.find(x => String(x.id) === String(editId)); if (cur) renderPath(cur); }
}

// ---------- run state ----------
let running = false, busy = false;
function renderRun(r) {
  running = !!r;
  $('btnStart').classList.toggle('on', running);
  $('btnStop').classList.toggle('on', !running);
  const s = $('sys');
  s.textContent = running ? 'СИСТЕМА: РАБОТАЕТ' : 'СИСТЕМА: ОЖИДАЕТ';
  s.className = 'sys ' + (running ? 'on' : 'off');
}
async function setRun(v) {
  if (busy || v === running) return;
  busy = true; $('btnStart').disabled = $('btnStop').disabled = true;
  try { const r = await db.setRunning(v); if (typeof r === 'boolean') renderRun(r); }
  catch (e) { logLine(e.message); }
  busy = false; $('btnStart').disabled = $('btnStop').disabled = false;
}
$('btnStart').onclick = () => setRun(true);
$('btnStop').onclick = () => setRun(false);

// ---------- logs ----------
const pad = (n, l = 2) => String(n).padStart(l, '0');
const fmt = ts => { const d = new Date(ts || Date.now()); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
const logBox = $('logBox');
let followLogs = true;
const atBottom = () => logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 24;
function updateLogBtns() {
  const over = logBox.scrollHeight > logBox.clientHeight + 4;
  $('logTop').hidden = !(over && logBox.scrollTop > 24);
  $('logBottom').hidden = !(over && !atBottom());
}
logBox.addEventListener('scroll', () => { if (logBox.clientHeight) followLogs = atBottom(); updateLogBtns(); });
// подтверждение опасного действия: resolve(true) только по кнопке «Удалить»
function confirmBox(title, text, ok = 'Удалить') {
  return new Promise(res => {
    const d = $('mConfirm'); let yes = false;
    $('cTitle').textContent = title; $('cText').textContent = text; $('cOk').textContent = ok;
    $('cOk').onclick = () => { yes = true; d.close(); };
    d.addEventListener('close', () => res(yes), { once: true });
    openModal(d);
  });
}
$('logClear').onclick = () => openModal($('mClear'));

// ---------- статус: Firebase и сервер ----------
const hm = t => t ? new Date(t).toLocaleTimeString('ru-RU') : '—';
function rows(box, list) {
  box.replaceChildren();
  for (const [k, v, st] of list) {
    const r = el('div', 'r'); r.append(el('span', '', k), el('b', st || '', String(v))); box.append(r);
  }
}
const engineAlive = () => !!(engineV && engineV.lastSeen && Date.now() - engineV.lastSeen < engineV.ttl);
function renderSrv(v) {
  if (v !== undefined) engineV = v;
  const c = $('srv'), alive = engineAlive();
  c.textContent = 'Сервер · ' + (alive ? 'работает' : 'выключен');
  c.className = 'chip ' + (alive ? 'on' : 'bad');
}
function renderStatus() {
  const i = db.info();
  if ($('mFb').open) {
    if (db.mode === 'firebase') {
      $('fbTitle').textContent = 'Firebase';
      rows($('fbRows'), [
        ['Подключение', connOk ? 'на связи' : 'нет связи', connOk ? 'ok' : 'bad'],
        ['Доступ к базе', i.error ? 'ошибка: ' + i.error : 'в порядке', i.error ? 'bad' : 'ok'],
        ['Проект', i.project], ['Аккаунт', i.user || '—'],
        ['Последняя синхронизация', i.lastSync ? hm(i.lastSync) + ' (' + ago(i.lastSync) + ')' : '—'],
        ['Кэш в браузере', `воркеры ${i.cache.workers} · цели ${i.cache.targets} · дни ${i.cache.days} · логи ${i.cache.logs}`],
        ['Чтений с сервера за сессию', i.reads], ['Записей за сессию', i.writes],
      ]);
    } else {
      $('fbTitle').textContent = 'Подключение';
      rows($('fbRows'), [['Режим', { rest: 'REST', local: 'Локальный сервер' }[db.mode]], ['Связь', connOk ? 'на связи' : 'не запущен', connOk ? 'ok' : 'bad']]);
    }
  }
  if ($('mSrv').open) {
    const alive = engineAlive(), seen = !!(engineV && engineV.seen);
    rows($('srvRows'), [
      ['Статус', alive ? 'работает' : seen ? 'не отвечает' : 'не запускался', alive ? 'ok' : 'bad'],
      ['Последний сигнал', seen && engineV.lastSeen ? hm(engineV.lastSeen) + ' (' + ago(engineV.lastSeen) + ')' : '—'],
      ...(engineV && engineV.version ? [['Версия', engineV.version]] : []),
      ['Скрипт', running ? 'запущен' : 'остановлен', running ? 'ok' : ''],
      ['Воркеров в списке', $('wCount').textContent],
      ['Ошибок в консоли', recentErrors.length, recentErrors.length ? 'bad' : 'ok'],
    ]);
    const box = $('srvErrs'); box.replaceChildren();
    if (!alive) box.append(el('div', 'h', 'Подсказка'), el('div', '', 'Сервер появится «на связи», когда воркер начнёт писать control/engine.lastSeen (раз в ≤5 мин).'));
    if (recentErrors.length) {
      box.append(el('div', 'h', 'Последние ошибки'));
      for (const e of recentErrors.slice(-5).reverse()) box.append(el('div', 'e', `[${hm(e.ts)}] ${e.text}`));
    }
  }
}
let statusTimer = 0;
for (const [btn, dlg] of [['conn', 'mFb'], ['srv', 'mSrv']]) {
  $(btn).onclick = () => {
    $(dlg).showModal(); document.documentElement.classList.add('lock');
    renderStatus(); clearInterval(statusTimer); statusTimer = setInterval(renderStatus, 1000);
  };
  $(dlg).addEventListener('close', () => { if (!$('mFb').open && !$('mSrv').open) clearInterval(statusTimer); });
}
setInterval(() => { if (db.mode === 'firebase' && !$('srv').hidden) renderSrv(); }, 30000);
$('clearOk').onclick = async () => {
  $('mClear').close();
  logBox.replaceChildren(); followLogs = true; updateLogBtns(); recentErrors.length = 0;
  try { await db.clearLogs?.(); } catch (e) { /* на сервере логи не трогаем */ }
  // консоль не должна оставаться пустой: сразу показываем состояние каждого воркера
  try {
    const r = await fetch('/api/workers-report', { method: 'POST' });
    if (!r.ok) throw new Error(r.status === 404 ? 'сервер устарел — перезапустите сервер' : 'HTTP ' + r.status);
  } catch (e) { logLine('Отчёт по воркерам недоступен: ' + e.message, 'warn'); }
};
$('logTop').onclick = () => logBox.scrollTo({ top: 0, behavior: 'smooth' });
$('logBottom').onclick = () => { followLogs = true; logBox.scrollTo({ top: logBox.scrollHeight, behavior: 'smooth' }); };

const recentErrors = [];
function addLog({ ts, level = 'info', text }) {
  const lv = level === 'warning' ? 'warn' : level;
  if (lv === 'error') { recentErrors.push({ ts, text }); if (recentErrors.length > 20) recentErrors.shift(); }
  const row = el('div', lv);
  row.append(el('span', 'tm', `[${fmt(ts)}] `), el('span', 'lv', (LEVELS[lv] || lv.toUpperCase()) + ': '), document.createTextNode(text));
  const stick = followLogs;            // всегда держим низ, пока пользователь сам не пролистал вверх
  logBox.append(row);
  while (logBox.childElementCount > 500) logBox.firstChild.remove();
  if (stick) logBox.scrollTop = logBox.scrollHeight;
  updateLogBtns();
}
const logLine = (text, level = 'error') => addLog({ text, level });

// ---------- connection ----------
let connOk = false, engineV = null;
db.onConn(ok => {
  connOk = ok;
  const c = $('conn');
  c.textContent = ({ firebase: 'Firebase', rest: 'REST', local: 'Локальный сервер' }[db.mode]) + (ok ? ' · на связи' : db.mode === 'local' ? ' · не запущен' : ' · нет связи');
  c.className = 'chip ' + (ok ? 'on' : 'bad');
  if (!ok) { $('sys').textContent = 'СИСТЕМА: НЕТ СВЯЗИ'; $('sys').className = 'sys bad'; }
  else renderRun(running);
});

// ---------- modals ----------
function openModal(dlg) {
  const f = dlg.querySelector('form');
  f.reset();
  const m = f.querySelector('.msg'); if (m) { m.hidden = true; m.textContent = ''; }
  document.documentElement.classList.add('lock');
  dlg.showModal();
  f.querySelector('input:not([type=radio])')?.focus();
}
// закрытие по фону — только если и нажатие, и отпускание были на фоне
// (выделение текста в поле с выходом мышки за окно модалку не закрывает)
let downOnBackdrop = false;
document.addEventListener('pointerdown', e => { downOnBackdrop = e.target instanceof HTMLDialogElement; });
document.addEventListener('click', e => {
  const c = e.target.closest('[data-close]');
  if (c) c.closest('dialog').close();
  else if (downOnBackdrop && e.target instanceof HTMLDialogElement) e.target.close();
  downOnBackdrop = false;
});
// пока открыта модалка — страница под ней не скроллится
document.querySelectorAll('dialog.modal').forEach(d => d.addEventListener('close', () => {
  if (![...document.querySelectorAll('dialog.modal')].some(x => x.open)) document.documentElement.classList.remove('lock');
}));
function bindForm(dlgId, action) {
  const dlg = $(dlgId), f = dlg.querySelector('form');
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    try { await action(Object.fromEntries(new FormData(f))); dlg.close(); }
    catch (err) { const m = f.querySelector('.msg'); m.textContent = err.message; m.hidden = false; }
    btn.disabled = false;
  };
}
bindForm('mWorker', addWorkerRest);

// модалка 2FA у существующего воркера: визард «Включить 2FA через Steam» (код с почты -> код из SMS -> готово),
// плюс запасной путь — вставить готовый secret вручную (если он уже есть откуда-то).
function openSecretModal(w) {
  const dlg = $('mSecret');
  openModal(dlg);
  $('secretLogin').textContent = w.login;
  const f = dlg.querySelector('form');
  const body = $('secretBody');
  const footer = $('secretFooter');
  const msg = f.querySelector('.msg');
  const showMsg = t => { msg.textContent = t; msg.hidden = !t; };
  let stage = 'guard'; // guard (код из приложения) | start -> email -> sms (новая 2FA) | manual

  async function post(path, payload) {
    const r = await apiFetch(API + '/workers/' + encodeURIComponent(w.login) + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}),
    });
    const res = await r.json().catch(() => ({}));
    if (r.status === 404 && !res.error) throw new Error('сервер устарел — перезапустите сервер');
    if (!r.ok) throw new Error(res.error || r.status);
    return res;
  }

  function renderGuard() {
    stage = 'guard'; showMsg('');
    body.innerHTML = `<p style="color:var(--mut);font-size:13px;margin:0 0 10px">Guard на аккаунте уже включён — снимать его не нужно. Откройте приложение, где он стоит, и введите ТЕКУЩИЙ код (он меняется каждые 30 сек). Steam выдаст воркеру сессию, и дальше он входит сам; код понадобится снова только когда сессия истечёт (~раз в несколько месяцев).</p><label>Текущий код Guard<input name="code" autocomplete="one-time-code" required></label>`;
    footer.innerHTML = `<button type="button" class="ghost" data-close>Отмена</button><button type="button" class="ghost" id="toNew">Включить новый Guard…</button><button type="submit" class="primary">Войти</button>`;
    footer.querySelector('#toNew').onclick = renderStart;
    setTimeout(() => f.code && f.code.focus(), 50);
  }

  function renderStart() {
    stage = 'start'; showMsg('');
    body.innerHTML = `<p style="color:var(--mut);font-size:13px;margin:0 0 10px">Аккаунт должен быть БЕЗ активного Steam Guard (если уже включён где-то ещё — сначала снимите его там). Нажмите «Включить» — Steam пришлёт код на почту, затем SMS-код на телефон.</p>`;
    footer.innerHTML = `<button type="button" class="ghost" id="toGuard">← Войти кодом</button><button type="button" class="ghost" id="toManual">Secret вручную</button><button type="submit" class="primary">Включить 2FA</button>`;
    footer.querySelector('#toManual').onclick = renderManual;
    footer.querySelector('#toGuard').onclick = renderGuard;
  }

  function renderCode(kind, label) {
    stage = kind; showMsg('');
    body.innerHTML = `<label>${label}<input name="code" autocomplete="one-time-code" required></label>`;
    footer.innerHTML = `<button type="button" class="ghost" data-close>Отмена</button><button type="submit" class="primary">Подтвердить</button>`;
    setTimeout(() => f.code && f.code.focus(), 50);
  }

  function renderDone(revocationCode, statusLine) {
    stage = 'done'; showMsg('');
    body.innerHTML = `<p style="color:var(--ok);font-size:13px;margin:0 0 6px">${statusLine}</p>
      <p style="font-size:13px;margin:0 0 4px">Код для отключения 2FA (сохраните, Steam больше его не покажет):</p>
      <div style="display:flex;gap:6px;align-items:center"><code style="font-size:15px;letter-spacing:1px" id="revCode">${revocationCode || '—'}</code>
      ${revocationCode ? `<button type="button" class="small" id="cpRev">Скопировать</button>` : ''}</div>`;
    footer.innerHTML = `<button type="button" class="primary" data-close>Готово</button>`;
    const cp = body.querySelector('#cpRev'); if (cp) cp.onclick = () => { navigator.clipboard.writeText(revocationCode); cp.textContent = 'Скопировано'; };
  }

  function renderManual() {
    stage = 'manual'; showMsg('');
    body.innerHTML = `<label>Секрет (shared_secret) <i>пусто — убрать 2FA</i><input name="sharedSecret"></label>`;
    footer.innerHTML = `<button type="button" class="ghost" data-close>Отмена</button><button type="button" class="ghost" id="toStart">← Назад</button><button type="submit" class="primary">Сохранить и перелогинить</button>`;
    footer.querySelector('#toStart').onclick = renderGuard;
  }

  renderGuard();

  f.onsubmit = async e => {
    e.preventDefault();
    const btn = f.querySelector('[type=submit]'); if (btn) btn.disabled = true;
    try {
      if (stage === 'guard') {
        const res = await post('/guard-login', { code: f.code.value.trim() });
        const why = res.lastError && res.lastError.message;
        if (res.status === 'Active') { logLine(`Воркер ${w.login}: вход по коду Guard выполнен, сессия сохранена`, 'success'); dlg.close(); await fetchWorkers(); }
        else showMsg(why || ('статус: ' + res.status));
      } else if (stage === 'start') {
        const res = await post('/2fa/start');
        if (res.step === 'sms') { logLine(`Воркер ${w.login}: 2FA — SMS уже запрошен`, 'info'); renderCode('sms', 'Код из SMS на телефоне'); }
        else renderCode('email', 'Код из письма на почте аккаунта' + (res.hint ? ` (${res.hint})` : ''));
      } else if (stage === 'email') {
        const code = f.code.value.trim();
        const res = await post('/2fa/email-code', { code });
        logLine(`Воркер ${w.login}: email-код принят, Steam отправил SMS`, 'info');
        renderCode('sms', 'Код из SMS на телефоне');
        dlg.dataset.revocation = res.revocation_code || '';
      } else if (stage === 'sms') {
        const code = f.code.value.trim();
        const res = await post('/2fa/sms-code', { code });
        const why = res.lastError && res.lastError.message;
        const line = res.status === 'Active' ? '2FA включена, вход выполнен' : `2FA включена, но вход не выполнен — ${why || res.status}`;
        logLine(`Воркер ${w.login}: ${line}`, res.status === 'Active' ? 'success' : 'warn');
        if (res.revocation_code) logLine(`Воркер ${w.login}: код отключения 2FA — ${res.revocation_code} (сохраните!)`, 'info');
        renderDone(res.revocation_code, line);
        await fetchWorkers();
      } else if (stage === 'manual') {
        const val = f.sharedSecret.value.trim();
        const res = await post('/secret', { sharedSecret: val });
        const why = res.lastError && res.lastError.message;
        if (res.status === 'Active') logLine(`Воркер ${w.login}: 2FA-секрет обновлён, вход выполнен`, 'success');
        else logLine(`Воркер ${w.login}: 2FA-секрет сохранён, но вход не выполнен — ${why || res.status}`);
        dlg.close();
        await fetchWorkers();
      }
    } catch (err) {
      showMsg(err.message);
    }
    if (btn) btn.disabled = false;
  };
}

// модалка смены прокси у существующего воркера
function openProxyModal(w) {
  const dlg = $('mProxy');
  openModal(dlg);
  $('proxyLogin').textContent = w.login;
  const f = dlg.querySelector('form');
  f.proxy.value = w.proxy || '';
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    const val = f.proxy.value.trim();
    if (val && val === String(w.proxy || '').trim() && !/@|:.*:.*:/.test(val)) { dlg.close(); return; } // в поле показан только host:port — менять нечего (иначе потеряем логин/пароль)
    try {
      const r = await apiFetch(API + '/workers/' + encodeURIComponent(w.login) + '/proxy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proxy: val }),
      });
      const res = await r.json().catch(() => ({}));
      if (r.status === 404 && !res.error) throw new Error('сервер устарел — перезапустите сервер');
      if (!r.ok) throw new Error(res.error || r.status);
      logLine(`Воркер ${w.login}: прокси ${val ? 'обновлён (' + res.proxy + ')' : 'убран'}, статус: ${res.status}`, 'success');
      dlg.close();
      await fetchWorkers();
    } catch (err) {
      const m = f.querySelector('.msg'); m.textContent = err.message; m.hidden = false;
    }
    btn.disabled = false;
  };
}

// ---------- вкладка «Цены» ----------
let priceRows = [];   // [[name, price], ...] по алфавиту
function drawPrices() {
  const q = $('pSearch').value.trim().toLowerCase();
  const list = q ? priceRows.filter(r => r[0].toLowerCase().includes(q)) : priceRows;
  const w = Math.min(70, priceRows.reduce((m, r) => Math.max(m, r[0].length), 0)) + 3;
  $('pText').textContent = list.length
    ? list.map(([n, p]) => n.padEnd(w) + '$' + p.toFixed(2)).join('\n')
    : (priceRows.length ? 'Ничего не найдено' : 'Цен пока нет. Нажмите «Обновить» — цены скачаются в prices.json на сервере.');
  $('pCount').textContent = priceRows.length;
}
// цены лежат в prices.json на сервере; последняя загруженная копия хранится в браузере — без сервера список всё равно виден
const PRICE_KEY = 'pm_prices_v1';
function showPrices(d, note) {
  priceRows = Object.entries(d.prices || {}).sort((a, b) => a[0].localeCompare(b[0], 'en'));
  $('pUpd').textContent = (d.updatedAt ? 'обновлено ' + new Date(d.updatedAt).toLocaleString('ru-RU') : 'не обновлялось') + (note ? ' · ' + note : '');
  drawPrices();
}
async function loadPrices() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(PRICE_KEY) || 'null'); } catch (_) {}
  if (cached && !priceRows.length) showPrices(cached, 'сохранённая копия');
  try {
    const r = await apiFetch(API + '/prices', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'сервер устарел — перезапустите сервер' : 'HTTP ' + r.status);
    const d = await r.json();
    showPrices(d);
    try { localStorage.setItem(PRICE_KEY, JSON.stringify({ updatedAt: d.updatedAt, prices: d.prices })); } catch (_) {} // не влезло в хранилище — не страшно
  } catch (e) {
    if (cached) showPrices(cached, 'сервер закрыт — показана сохранённая копия');
    else $('pText').textContent = 'Цены пока не загружены: ' + e.message + '. Запустите сервер и откройте вкладку ещё раз.';
  }
}
$('pSearch').addEventListener('input', drawPrices);

// «Обновить»: после подтверждения сервер скачивает цены CS2 и сохраняет их в prices.json
async function updatePricesRest(btn) {
  const ok = await confirmBox('Обновить цены?', 'Сервер скачает актуальные цены CS2 и заменит файл prices.json. Это может занять до минуты.', 'Обновить');
  if (!ok) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Обновляю...';
  try {
    const r = await apiFetch(API + '/update-prices', { cache: 'no-store' });
    const res = await r.json().catch(() => ({}));
    if (r.status === 404 && !res.error) throw new Error('сервер устарел — перезапустите сервер');
    if (!r.ok || !res.ok) throw new Error(res.error || 'HTTP ' + r.status);
    (res.skipped || []).forEach(m => logLine('Источник цен пропущен — ' + m, 'warn'));
    logLine(`Цены обновлены: ${res.count} предметов сохранено в prices.json на сервере (источник: ${res.source})`, 'success');
    await loadPrices();
  } catch (e) {
    logLine('Не удалось обновить цены: ' + e.message);
  } finally { btn.disabled = false; btn.textContent = label; }
}
$('pricesBtn').onclick = e => updatePricesRest(e.currentTarget);

// ---------- источники клиентов (ссылки) ----------
let srcSig = '';
let csModes = [], csModesAt = 0;
async function loadCsModes() {
  if (Date.now() - csModesAt < 60000 && csModes.length) return;
  try { const r = await apiFetch(API + '/cybershoke/modes', { cache: 'no-store' }); if (r.ok) { csModes = await r.json(); csModesAt = Date.now(); } } catch (_) {}
}
function modesBox(s) {
  const box = el('div', 'modes'), cur = new Set(s.modes);
  const all = [{ mode: 'MATCHES', players: null }, ...csModes.filter(m => m.mode !== 'MATCHES')];
  for (const m of cur) if (!all.some(x => x.mode === m)) all.push({ mode: m, players: 0 });
  for (const m of all) {
    const l = el('label', cur.has(m.mode) ? 'on' : ''), c = el('input'); c.type = 'checkbox'; c.checked = cur.has(m.mode);
    l.append(c, document.createTextNode(m.mode + (m.players ? ' · ' + m.players : '')));
    c.onchange = async () => {
      c.checked ? cur.add(m.mode) : cur.delete(m.mode); l.classList.toggle('on', c.checked);
      try {
        const r = await apiFetch(API + '/sources/' + encodeURIComponent(s.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modes: [...cur] }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
      } catch (e) { logLine('Не удалось сохранить режимы: ' + e.message); }
    };
    box.append(l);
  }
  box.append(el('div', 'hint', 'MATCHES — кастомные матчи (SteamID точные). Остальные режимы: сайт показывает только ники, SteamID ищется поиском Steam по нику и аватару — находятся не все, и это идёт медленно (в фоне, пачками).'));
  return box;
}
async function loadSources(force) {
  const box = $('srcList');
  try {
    const r = await apiFetch(API + '/sources', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'сервер устарел — перезапустите сервер' : 'HTTP ' + r.status);
    const list = await r.json();
    if (list.some(x => Array.isArray(x.modes))) await loadCsModes();
    // не перерисовываем список, пока человек выделяет/копирует текст, и когда данные не изменились — иначе выделение сбрасывается
    const sel = window.getSelection && window.getSelection();
    if (!force && sel && !sel.isCollapsed && box.contains(sel.anchorNode)) return;
    const sig = JSON.stringify(list);
    if (!force && sig === srcSig) return;
    srcSig = sig;
    box.replaceChildren();
    if (!list.length) { box.append(el('div', 'empty', 'Ссылок пока нет')); return; }
    for (const s of list) {
      const on = s.enabled !== false; // нет поля (старый сервер) = в работе
      const row = el('div', 'srcrow' + (on ? '' : ' off')), main = el('div', 'srcmain');
      const sw = el('label', 'sw'), chk = el('input'); chk.type = 'checkbox'; chk.checked = on;
      sw.title = on ? 'В работе — выключить (пауза)' : 'На паузе — включить в работу';
      sw.append(chk, el('span', 'sl'));
      chk.onchange = async () => {
        const want = chk.checked; chk.disabled = true; row.classList.toggle('off', !want);
        try {
          const r = await apiFetch(API + '/sources/' + encodeURIComponent(s.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: want }) });
          if (!r.ok) throw new Error(r.status === 404 ? 'сервер устарел — перезапустите сервер' : 'HTTP ' + r.status);
        } catch (e) { logLine('Не удалось переключить источник: ' + e.message); }
        loadSources(true);
      };
      main.append(el('div', 'srcurl', s.url));
      const info = s.state === 'error' ? 'ошибка: ' + s.error
        : s.state === 'new' ? 'ждёт проверки'
        : s.state === 'done' ? `✔ группа полностью обработана — выберите другую · найдено ${s.found} · проверено ${s.checked} · пропущено ${s.skipped}`
        : s.groupTotal ? `${s.kind || ''} · партия ${s.batches}${s.groupDone ? ' (последняя)' : ''} · найдено ${s.found} из ~${s.groupTotal * 1000} · проверено ${s.checked} · пропущено ${s.skipped}`
        : `${s.kind || ''} · найдено ${s.found} · проверено ${s.checked} · пропущено ${s.skipped}`;
      main.append(el('small', s.state === 'error' ? 'werr' : 'srcinfo', (on ? '▶ в работе · ' : '⏸ на паузе · ') + info));
      if (Array.isArray(s.modes)) main.append(modesBox(s));
      const del = trashBtn(); del.title = 'Удалить ссылку';
      del.onclick = async () => {
        if (!(await confirmBox('Удалить источник?', `Ссылка ${s.url} будет удалена из списка вместе с прогрессом по ней (найдено ${s.found}, проверено ${s.checked}). Это нельзя отменить.`))) return;
        await apiFetch(API + '/sources/' + encodeURIComponent(s.id), { method: 'DELETE' }).catch(() => {}); loadSources(true);
      };
      row.append(sw, main, del); box.append(row);
    }
  } catch (e) { box.replaceChildren(el('div', 'empty', 'Не удалось загрузить: ' + e.message)); }
}
async function addSource() {
  const inp = $('srcUrl'), msg = $('srcMsg');
  msg.hidden = true;
  try {
    const r = await apiFetch(API + '/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: inp.value }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || (r.status === 404 ? 'сервер устарел — перезапустите сервер' : 'HTTP ' + r.status));
    inp.value = '';
    logLine('Ссылка-источник добавлена. Нажмите «Старт», чтобы воркеры начали проверку', 'info');
    loadSources(true);
  } catch (e) { msg.textContent = e.message; msg.hidden = false; }
}
$('srcBtn').onclick = () => { openModal($('mSources')); loadSources(true); };
$('srcAdd').onclick = addSource;
$('srcUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSource(); } });
setInterval(() => { if ($('mSources').open) loadSources(); }, 4000);
bindForm('mTarget', d => db.addTarget(d));

// карточка цели: смена статуса; при «Успешно» спрашиваем, сколько заработано
let editId = null, pendingEditId = null;
const modeLabel = m => ({ MATCHES: 'матч (комната Cybershoke)', GROUPS: 'группа Steam / ссылка', DM: 'DM (Cybershoke)' }[m] || ('Cybershoke · ' + m));
function renderInfo(t) {
  const box = $('editInfo'); box.replaceChildren();
  const id = String(t.steamId || t.name || '');
  if (!/^7656119\d{10}$/.test(id)) { box.hidden = true; return; }
  box.hidden = false;
  const link = el('a', 'link', 'Профиль Steam ↗');
  link.href = t.profileUrl || `https://steamcommunity.com/profiles/${id}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
  const head = el('div', 'ih'); head.append(el('span', 'iid', id), link);
  box.append(head);
  box.append(el('div', 'imode', 'Найден: ' + (t.mode ? modeLabel(t.mode) : 'источник не записан (цель добавлена до обновления или найдена не из источника)')));
  if (t.isPrivate) box.append(el('div', 'istate bad', 'Инвентарь закрыт — оценить нельзя'));
  else if (t.checkedAt) {
    box.append(el('div', 'istate ok', `Инвентарь открыт · предметов ${t.itemsCount || 0} · оценка ${money(t.value)}`));
    if ((t.top || []).length) {
      const list = el('div', 'itop');
      for (const it of t.top) { const r = el('div', 'ir'); r.append(el('span', 'in', (it.qty > 1 ? it.qty + '× ' : '') + it.name), el('b', '', money(it.sum))); list.append(r); }
      box.append(list);
    } else {
      const b = el('button', 'ghost small', 'Показать предметы (перепроверить)'); b.type = 'button';
      b.onclick = async () => {
        b.disabled = true; b.textContent = 'Проверяю…';
        try {
          const r = await fetch('/api/check-target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steamId: id }) });
          const res = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(res.error || ('HTTP ' + r.status));
          const items = (res.top || (res.result && res.result.top) || []);
          if (items.length) { t.top = items; renderInfo(t); } else { b.textContent = 'Предметов не найдено'; }
        } catch (e) { b.disabled = false; b.textContent = 'Не удалось: ' + e.message; }
      };
      box.append(b);
    }
  }
  if (t.failReason) box.append(el('div', 'ireason', 'Причина статуса: ' + t.failReason));
}
const editStatus = () => new FormData($('editForm')).get('status');
function syncEarned() {
  const on = $('editForm').elements.paid.checked;
  $('payRow').hidden = !on;
  $('editForm').elements.earned.required = on;
  if (on && !$('editForm').elements.paidDate.value) $('editForm').elements.paidDate.value = ymd(new Date());
}
function openEdit(id) {
  const t = targets.find(x => String(x.id) === String(id));
  if (!t) {
    pendingEditId = db.mode === 'local' ? null : id; // у Firebase/REST цели приходят чуть позже
    if (!pendingEditId) { const h = parseHash(); history.replaceState(null, '', buildHash(h.view)); }
    return;
  }
  pendingEditId = null; editId = t.id;
  const f = $('editForm'); f.reset();
  $('editTitle').textContent = t.name;
  renderInfo(t);
  renderPath(t);
  f.elements.status.value = t.status;
  f.elements.paid.checked = t.earned != null;
  f.elements.earned.value = t.earned ?? '';
  f.elements.paidDate.value = t.okDay || '';
  f.elements.value.value = t.value ?? '';
  syncEarned();
  const m = f.querySelector('.msg'); if (m) { m.hidden = true; m.textContent = ''; }
  document.documentElement.classList.add('lock');
  $('mEdit').showModal();
  chatFor = null; $('chatMsg').textContent = ''; $('chatLog').replaceChildren(); loadChat(true);
}
$('editForm').addEventListener('change', e => {
  if (e.target.name !== 'paid') return;
  syncEarned();
  if (e.target.checked) $('editForm').elements.earned.focus();
});
bindForm('mEdit', d => db.updateTarget(editId, d));
$('editDelete').onclick = async () => {
  const t = targets.find(x => String(x.id) === String(editId));
  if (!await confirmBox('Удалить цель?', `Цель ${t ? t.name : ''} будет удалена. Это нельзя отменить.`)) return;
  try { await db.removeTarget(editId); $('mEdit').close(); }
  catch (err) { const m = $('editForm').querySelector('.msg'); m.textContent = err.message; m.hidden = false; }
};
for (const [id, m] of [['addToggle', 'worker'], ['tAddToggle', 'target']]) {
  $(id).onclick = e => { e.preventDefault(); location.hash = buildHash(parseHash().view, m); };
}

// ---------- UI ----------
$('nav').onclick = e => {
  const a = e.target.closest('a'); if (!a) return;
  e.preventDefault();
  location.hash = buildHash(a.dataset.view);
};
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, m = f.querySelector('.msg'), b = f.querySelector('button'); b.disabled = true; m.hidden = true;
  try { await db.signIn(f.login.value, f.password.value); f.password.value = ''; }
  catch (err) { m.textContent = err.message; m.hidden = false; }
  b.disabled = false;
};
$('settingsBtn').onclick = () => openModal($('mSet'));
$('signOut').onclick = () => { $('mSet').close(); db.signOut(); };

// ---------- subscriptions ----------
let unsubs = [], userReady = false;
function unsubAll() {
  unsubs.forEach(u => u()); unsubs = [];
  if (statsUnsub) { statsUnsub(); statsUnsub = null; }
}
function subscribe() {
  unsubAll();
  $('logBox').replaceChildren();
  userReady = true;
  subStats();
  unsubs = [db.onEngine(e => { chatSince = e.chatSince || 0; renderSrv(e); if (e.funnelNext !== funnelNext || e.funnelSince !== funnelSince) { funnelNext = e.funnelNext || 0; funnelSince = e.funnelSince || 0; funnelOnly = e.funnelOnly || []; if (targets.length) renderTargets(targets); } }), watchWorkers(), db.onTargets(renderTargets), db.onRun(renderRun), db.onLogs(lines => lines.forEach(addLog))];
}
applyPeriod(presetPeriod('thisMonth'), true);
db.onAuth(user => {
  $('login').hidden = !!user;
  $('settingsBtn').hidden = !(user && db.mode === 'firebase');
  $('srv').hidden = !(user && db.mode === 'firebase');
  $('setUser').textContent = user?.email || '';
  if (user) subscribe(); else { userReady = false; unsubAll(); }
});

// ---------- роутинг по ссылке ----------
// #/<экран>?p=<период>&m=<окно>
//   экран: dashboard | workers | targets | logs
//   p: today | week | month30 | thisMonth | all | ГГГГ-ММ-ДД_ГГГГ-ММ-ДД
//   m: worker | target (открывает модалку)
const VIEWS = ['dashboard', 'workers', 'targets', 'logs', 'prices', 'messages'];
const MODALS = { worker: 'mWorker', target: 'mTarget', edit: 'mEdit' };
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function parseHash() {
  const [path, qs = ''] = location.hash.slice(1).split('?');
  const view = path.split('/').filter(Boolean)[0];
  const params = new URLSearchParams(qs);
  return { view: VIEWS.includes(view) ? view : 'dashboard', m: MODALS[params.get('m')] ? params.get('m') : null, params };
}
function buildHash(view, m, extra = {}) {
  const q = new URLSearchParams();
  if (period.key !== 'thisMonth') q.set('p', PRESETS.some(x => x.key === period.key) ? period.key : `${ymd(period.from)}_${ymd(period.to)}`);
  const f = 'f' in extra ? extra.f : filter;
  if (f && f !== 'all') q.set('f', f);
  if (m) q.set('m', m);
  if (extra.id != null) q.set('id', extra.id);
  if (extra.hl) q.set('hl', extra.hl);
  const s = q.toString();
  return `#/${view}${s ? '?' + s : ''}`;
}
function syncHash() { const h = parseHash(); history.replaceState(null, '', buildHash(h.view, h.m, { id: h.params.get('id') })); }
function periodFromParam(s) {
  if (!s) return null;
  if (PRESETS.some(p => p.key === s)) return presetPeriod(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const from = new Date(+m[1], m[2] - 1, +m[3]), to = new Date(+m[4], m[5] - 1, +m[6]);
  return isNaN(from) || isNaN(to) || to < from ? null : { key: 'custom', from, to };
}
const samePeriod = (a, b) => a.key === b.key && a.from?.getTime() === b.from?.getTime() && a.to?.getTime() === b.to?.getTime();

let lastView = null;
function route() {
  const { view, m, params } = parseHash();
  const want = periodFromParam(params.get('p')) || presetPeriod('thisMonth');
  if (!samePeriod(want, period)) applyPeriod(want, true);
  const f = params.get('f');
  const nf = f && TARGET_ST[f] ? f : 'all';
  if (nf !== filter) { filter = nf; renderTargets(targets); }
  if (lastView !== view) { window.scrollTo(0, 0); lastView = view; }
  $('app').dataset.view = view;
  if (view === 'prices') loadPrices();
  if (view === 'messages') loadMessages();
  $('nav').querySelectorAll('a').forEach(x => x.classList.toggle('on', x.dataset.view === view));
  for (const [key, id] of Object.entries(MODALS)) {
    const d = $(id);
    if (m === key && !d.open) key === 'edit' ? openEdit(params.get('id')) : openModal(d);
    if (m !== key && d.open) d.close();
  }
  const hl = params.get('hl');
  requestAnimationFrame(() => {
    applyLayout();
    logBox.querySelectorAll('.hl').forEach(x => x.classList.remove('hl'));
    if (hl === 'error') {
      // последняя ошибка в консоли — подсветить и показать по центру
      const rows = logBox.querySelectorAll('.error'), last = rows[rows.length - 1];
      if (last) { last.classList.add('hl'); logBox.scrollTop = Math.max(0, last.offsetTop - logBox.clientHeight / 2); }
      history.replaceState(null, '', buildHash(view, m, { id: params.get('id') }));
    } else if (followLogs) logBox.scrollTop = logBox.scrollHeight;
    updateLogBtns();
  });
}
// карточки статистики ведут на нужный экран
document.querySelectorAll('.cards a.card').forEach(a => {
  a.onclick = e => {
    e.preventDefault();
    const { go, f, hl } = a.dataset;
    location.hash = buildHash(go, null, { f: f || 'all', hl });
  };
});
for (const id of Object.values(MODALS)) {
  // закрыли окно (✕, Esc, фон, после сохранения) → убираем m из ссылки
  $(id).addEventListener('close', () => { const h = parseHash(); if (h.m) history.replaceState(null, '', buildHash(h.view)); });
}
window.addEventListener('hashchange', route);
route();

// ---------- ползунки размеров (сохраняются в localStorage) ----------
const LKEY = 'pm_layout_v1';
const layout = (() => { try { return JSON.parse(localStorage.getItem(LKEY)) || {}; } catch { return {}; } })();
const DEF = { tw: 380, wh: 330 };
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const shown = id => getComputedStyle($(id)).display !== 'none';
function clamped() {
  const gw = document.querySelector('.grid').clientWidth, ch = $('col').clientHeight;
  return {
    tw: gw > 0 && shown('splitV') ? clampN(layout.tw ?? DEF.tw, 260, Math.max(260, gw - 14 - 420)) : null,
    wh: ch > 0 && shown('splitH') ? clampN(layout.wh ?? DEF.wh, 120, Math.max(120, ch - 14 - 140)) : null,
  };
}
function applyLayout() {
  const c = clamped();
  if (c.tw != null) $('app').style.setProperty('--tw', c.tw + 'px');
  if (c.wh != null) $('app').style.setProperty('--wh', c.wh + 'px');
}
const saveLayout = () => { try { localStorage.setItem(LKEY, JSON.stringify(layout)); } catch {} };
function makeSplit(id, key, fromPointer, keyStep) {
  const s = $(id);
  s.addEventListener('pointerdown', e => {
    e.preventDefault(); s.setPointerCapture(e.pointerId);
    s.classList.add('drag'); document.body.classList.add('dragging');
  });
  s.addEventListener('pointermove', e => {
    if (!s.hasPointerCapture(e.pointerId)) return;
    layout[key] = fromPointer(e); applyLayout();
  });
  const end = () => {
    if (!s.classList.contains('drag')) return;
    s.classList.remove('drag'); document.body.classList.remove('dragging');
    const c = clamped(); if (layout[key] != null && c[key] != null) layout[key] = Math.round(c[key]);
    saveLayout();
  };
  s.addEventListener('pointerup', end);
  s.addEventListener('pointercancel', end);
  s.addEventListener('dblclick', () => { delete layout[key]; saveLayout(); applyLayout(); });
  s.addEventListener('keydown', e => {
    const d = keyStep(e.key); if (!d) return;
    e.preventDefault(); layout[key] = (layout[key] ?? DEF[key]) + d;
    applyLayout(); const c = clamped(); layout[key] = Math.round(c[key]); saveLayout();
  });
}
// ширина панели «Цели» = расстояние от курсора до правого края сетки
makeSplit('splitV', 'tw', e => document.querySelector('.grid').getBoundingClientRect().right - e.clientX - 7,
  k => k === 'ArrowLeft' ? 20 : k === 'ArrowRight' ? -20 : 0);
// высота «Воркеров» = расстояние от верха панели до курсора
makeSplit('splitH', 'wh', e => e.clientY - $('workers').getBoundingClientRect().top - 7,
  k => k === 'ArrowDown' ? 20 : k === 'ArrowUp' ? -20 : 0);
window.addEventListener('resize', applyLayout);
applyLayout();


// ---------- сообщения (СМС) ----------
// groups = { _all: [...общие], MATCHES: [...], DM: [...], GROUPS: [...] }; у каждого типа свой текст, пустой тип использует «Общие»
let msgGroups = { _all: [] }, msgTypes = [], msgViewMode = 'blocks', msgTimer = null, msgLoaded = false, msgSeeded = true, msgOff = new Set();
const MSG_TITLE = { _all: 'Общие (для всех типов без своих сообщений)', MATCHES: 'MATCHES — кастомные матчи', GROUPS: 'GROUPS — группы Steam и прочие ссылки' };
const msgTitle = k => MSG_TITLE[k] || k;
const msgKeys = () => [...new Set([...msgTypes, ...Object.keys(msgGroups).filter(k => k !== '_all')])].concat('_all');
const onCount = g => (g || []).filter(m => m.enabled !== false).length;
function saveMsgs() {
  clearTimeout(msgTimer);
  msgTimer = setTimeout(async () => {
    try {
      const r = await apiFetch(API + '/messages', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groups: msgGroups, seeded: true, off: [...msgOff] }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json(); msgTypes = d.types || msgTypes; $('msgInfo').textContent = 'Сохранено';
    } catch (e) { $('msgInfo').textContent = 'Не удалось сохранить: ' + e.message; }
  }, 500);
}
function sectionCount(k, h) { const n = onCount(msgGroups[k]); h.querySelector('em').textContent = n ? n + ' вкл.' : 'пусто'; h.parentElement.classList.toggle('empty', !n); $('msgCount').textContent = Object.values(msgGroups).reduce((a, g) => a + onCount(g), 0) + ' вкл.'; }
function renderMsgs() {
  document.querySelectorAll('#msgView button').forEach(b => b.classList.toggle('on', b.dataset.v === msgViewMode));
  const box = $('msgSections'); box.replaceChildren();
  for (const k of msgKeys()) {
    const list = (msgGroups[k] = msgGroups[k] || []);
    const sec = el('div', 'msgsec' + (msgOff.has(k) ? ' off' : '')), h = el('h4');
    if (k !== '_all') {
      const sw = el('label', 'sw'), chk = el('input'); chk.type = 'checkbox'; chk.checked = !msgOff.has(k); sw.append(chk, el('span', 'sl'));
      sw.title = 'Вся категория: выключена — её сообщения не используются, берутся «Общие»';
      chk.onchange = () => { chk.checked ? msgOff.delete(k) : msgOff.add(k); sec.classList.toggle('off', !chk.checked); saveMsgs(); };
      h.append(sw);
    }
    h.append(el('span', '', msgTitle(k)), el('em', ''), el('span', 'grow'));
    const cp = el('button', '', 'Копировать'); cp.type = 'button';
    cp.onclick = async () => { try { await navigator.clipboard.writeText(list.map((m, i) => (i + 1) + '. ' + m.text).join('\n')); cp.textContent = 'Скопировано'; setTimeout(() => cp.textContent = 'Копировать', 1500); } catch (_) {} };
    h.append(cp); sec.append(h);
    if (msgViewMode === 'text') {
      const ta = el('textarea', 'stext'); ta.spellcheck = false; ta.value = list.map((m, i) => (i + 1) + '. ' + m.text).join('\n'); ta.rows = Math.min(14, Math.max(4, list.length + 1));
      ta.placeholder = k === '_all' ? 'Одно сообщение — одна строка' : 'Пусто — будут использоваться «Общие». Одно сообщение — одна строка';
      ta.oninput = () => { // те же строки сохраняют включено/выключено
        const old = msgGroups[k], used = new Set();
        msgGroups[k] = ta.value.split('\n').map(x => x.trim().replace(/^\d+[.)]\s*/, '')).filter(Boolean).map(t => {
          const i = old.findIndex((m, j) => m.text === t && !used.has(j)); if (i >= 0) { used.add(i); return old[i]; }
          return { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: t, enabled: true };
        });
        sectionCount(k, h); saveMsgs();
      };
      sec.append(ta);
    } else {
      for (const [i, m] of list.entries()) {
        const row = el('div', 'msgrow' + (m.enabled === false ? ' off' : ''));
        const sw = el('label', 'sw'), chk = el('input'); chk.type = 'checkbox'; chk.checked = m.enabled !== false; sw.append(chk, el('span', 'sl')); sw.title = 'Использовать это сообщение';
        chk.onchange = () => { m.enabled = chk.checked; row.classList.toggle('off', !chk.checked); sectionCount(k, h); saveMsgs(); };
        const ta = el('textarea'); ta.rows = 2; ta.value = m.text; ta.oninput = () => { m.text = ta.value; saveMsgs(); };
        const del = trashBtn(); del.title = 'Удалить сообщение';
        del.onclick = async () => { if (!(await confirmBox('Удалить сообщение?', m.text))) return; list.splice(i, 1); renderMsgs(); saveMsgs(); };
        row.append(sw, ta, del); sec.append(row);
      }
      const add = el('div', 'sadd'), na = el('textarea'); na.rows = 1; na.placeholder = 'Новое сообщение';
      const ab = el('button', 'primary', 'Добавить'); ab.type = 'button';
      ab.onclick = () => { const t = na.value.trim(); if (!t) return; list.push({ id: 'm' + Date.now().toString(36), text: t, enabled: true }); renderMsgs(); saveMsgs(); };
      add.append(na, ab); sec.append(add);
    }
    box.append(sec); sectionCount(k, h);
  }
}
async function loadMessages() {
  try {
    const r = await apiFetch(API + '/messages', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'сервер устарел — перезапустите сервер' : 'HTTP ' + r.status);
    const d = await r.json();
    if (!d || Array.isArray(d) || !d.groups) throw new Error('сервер устарел — перезапустите сервер (иначе сообщения не загрузятся и могут затереться)');
    if (msgLoaded && $('messages').contains(document.activeElement) && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) { if ((d.types || []).join() !== msgTypes.join()) { msgTypes = d.types || []; renderMsgs(); } return; } // не перебиваем набор текста
    msgGroups = d.groups || { _all: [] }; msgTypes = d.types || []; msgSeeded = !!d.seeded; msgOff = new Set(d.off || []); msgLoaded = true;
    if (!msgSeeded) { // первый раз: у каждого типа стартовый текст = текущие «Общие»; новые типы потом появятся пустыми
      for (const k of msgKeys()) if (k !== '_all' && !(msgGroups[k] || []).length) msgGroups[k] = (msgGroups._all || []).map(m => ({ ...m, id: 'm' + Math.random().toString(36).slice(2, 8) }));
      msgSeeded = true; saveMsgs();
    }
    renderMsgs();
  } catch (e) { $('msgSections').replaceChildren(el('div', 'empty', 'Не удалось загрузить: ' + e.message)); }
}
document.querySelectorAll('#msgView button').forEach(b => { b.onclick = () => { msgViewMode = b.dataset.v; renderMsgs(); }; });
setInterval(() => { if ($('app').dataset.view === 'messages') loadMessages(); }, 5000);

// ---------- карточка цели: переписка ----------
let chatFor = null, chatSig = '';
async function loadChat(force) {
  const t = targets.find(x => String(x.id) === String(editId));
  const box = $('editChat'); if (!t) return;
  const can = ['accepted', 'completed', 'action_needed'].includes(t.status);
  box.hidden = !can; if (!can) return;
  $('chatWho').textContent = t.worker ? '· от воркера ' + t.worker : '';
  try {
    const r = await apiFetch(API + '/targets/' + encodeURIComponent(t.id) + '/chat', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const list = await r.json(), sig = JSON.stringify(list.map(m => m.id));
    if (!force && sig === chatSig && chatFor === t.id) return;
    chatSig = sig; chatFor = t.id;
    const log = $('chatLog'); log.replaceChildren();
    if (!list.length) log.append(el('div', 'muted', (t.completed_at && chatSince && t.completed_at < chatSince) ? 'Это сообщение ушло до появления истории переписки, поэтому его здесь нет. Всё, что отправится или придёт теперь, будет видно. Чтобы проверить, нажмите «Запустить заново».' : 'Сообщений пока нет'));
    for (const m of list) { const d = el('div', 'cm ' + m.dir); d.append(document.createTextNode(m.text), el('small', '', (m.dir === 'out' ? 'вы · ' + (m.worker || '') : 'клиент') + ' · ' + fmtAt(m.ts))); log.append(d); }
    log.scrollTop = log.scrollHeight;
  } catch (e) { $('chatMsg').textContent = 'Переписка недоступна: ' + e.message; }
}
$('chatSend').onclick = async () => {
  const t = targets.find(x => String(x.id) === String(editId)), ta = $('chatText'), msg = $('chatMsg'); if (!t || !ta.value.trim()) return;
  $('chatSend').disabled = true; msg.textContent = 'Отправляю…';
  try {
    const r = await apiFetch(API + '/targets/' + encodeURIComponent(t.id) + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ta.value }) });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || (r.status === 404 ? 'сервер устарел — перезапустите сервер' : 'HTTP ' + r.status));
    ta.value = ''; msg.textContent = 'Отправлено от воркера ' + res.worker; loadChat(true);
  } catch (e) { msg.textContent = 'Ошибка: ' + e.message; }
  $('chatSend').disabled = false;
};
$('chatText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('chatSend').click(); } });
setInterval(() => { if ($('mEdit').open) loadChat(); }, 4000);

// ---------- карточка цели: отменить цепочку / запустить заново ----------
async function targetCtl(act) {
  const t = targets.find(x => String(x.id) === String(editId)); if (!t) return;
  const cancel = act === 'cancel', now = act === 'send-now', msg = $('tCtlMsg');
  const ok = now ? await confirmBox('Отправить СМС сейчас?', `${t.name}: первое сообщение уйдёт сразу, без ожидания 5–10 минут.`, 'Отправить') : await confirmBox(cancel ? 'Отменить цепочку?' : 'Запустить заново?',
    cancel ? `${t.name}: цепочка остановится, отправленная заявка в друзья будет отозвана (или цель убрана из друзей). Позже можно запустить заново.`
           : `${t.name}: путь начнётся с первого шага — заявка в друзья, ожидание, сообщение. Старые отметки пути сбросятся.`, cancel ? 'Отменить' : 'Запустить');
  if (!ok) return;
  $('tCancel').disabled = $('tRestart').disabled = $('tSendNow').disabled = true; msg.textContent = '…';
  try {
    const r = await apiFetch(API + '/targets/' + encodeURIComponent(t.id) + '/' + act, { method: 'POST' });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(res.error || (r.status === 404 ? 'сервер устарел — перезапустите сервер' : 'HTTP ' + r.status));
    msg.textContent = now ? 'Сообщение отправлено' : cancel ? 'Цепочка отменена' : 'Запущено заново'; logLine(`${t.name}: ${now ? 'сообщение отправлено вручную' : cancel ? 'цепочка отменена вручную' : 'запущено заново'}`, 'info');
  } catch (e) { msg.textContent = 'Ошибка: ' + e.message; }
  $('tCancel').disabled = $('tRestart').disabled = $('tSendNow').disabled = false;
}
$('tCancel').onclick = () => targetCtl('cancel');
$('tRestart').onclick = () => targetCtl('restart');
$('tSendNow').onclick = () => targetCtl('send-now');
