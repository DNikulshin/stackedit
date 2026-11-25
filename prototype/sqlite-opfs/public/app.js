// Стенд: UI + точка входа для автоматического прогона (window.stand).

import { DbClient } from './db-client.js';
import { LeaderDbClient } from './db-leader.js';

const $ = (id) => document.getElementById(id);
const logList = $('log');
let client = null;

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function log(msg, cls) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = ts();
  const span = document.createElement('span');
  span.textContent = msg;
  if (cls) span.className = cls;
  li.append(time, span);
  logList.prepend(li);
  console.log(`[stand] ${msg}`);
}

function renderDict(el, pairs) {
  el.innerHTML = '';
  pairs.forEach(([k, v, cls]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v === null || v === undefined ? '—' : String(v);
    if (cls) dd.className = cls;
    el.append(dt, dd);
  });
}

function paintEnv() {
  const sw = DbClient.sharedWorkerSupported();
  const iso = self.crossOriginIsolated;
  renderDict($('env'), [
    ['crossOriginIsolated', String(iso), iso ? 'ok' : 'bad'],
    ['SharedWorker', sw ? 'есть' : 'нет', sw ? 'ok' : 'warn'],
    ['navigator.locks', 'locks' in navigator ? 'есть' : 'нет', 'locks' in navigator ? 'ok' : 'warn'],
    ['navigator.storage', 'storage' in navigator ? 'есть' : 'нет'],
    ['User-Agent', navigator.userAgent],
  ]);
  navigator.storage?.estimate?.().then((est) => {
    const rows = [...document.querySelectorAll('#env dt')].map((n) => n.textContent);
    if (!rows.includes('usage / quota')) {
      renderDict($('env'), [
        ['crossOriginIsolated', String(iso), iso ? 'ok' : 'bad'],
        ['SharedWorker', sw ? 'есть' : 'нет', sw ? 'ok' : 'warn'],
        ['navigator.locks', 'locks' in navigator ? 'есть' : 'нет'],
        ['usage / quota', `${(est.usage / 1e6).toFixed(1)} / ${(est.quota / 1e6).toFixed(0)} МБ`],
        ['User-Agent', navigator.userAgent],
      ]);
    }
  }).catch(() => {});
}

function paintDbInfo(info) {
  if (!info) return renderDict($('dbinfo'), [['состояние', 'не подключено', 'warn']]);
  renderDict($('dbinfo'), [
    ['sqlite', info.sqliteVersion],
    ['VFS', info.vfs],
    ['файл', info.dbFile],
    ['открыта за', info.openedMs === null ? '—' : `${info.openedMs} мс`],
    ['ошибка открытия', info.openError ? `${info.openError.name}: ${info.openError.message}` : 'нет',
      info.openError ? 'bad' : 'ok'],
    ['persisted', String(info.persisted)],
    ['usage', info.usage === null || info.usage === undefined ? '—' : `${(info.usage / 1e6).toFixed(2)} МБ`],
    ['записей', info.writes],
  ]);
}

async function refreshInfo() {
  if (!client) return null;
  const res = await client.request('info');
  if (res.ok) paintDbInfo(res.result);
  return res.ok ? res.result : null;
}

async function connect() {
  if (client) return client;
  const mode = document.querySelector('input[name=mode]:checked').value;
  client = mode === 'leader' ? new LeaderDbClient() : new DbClient('dedicated');
  log(`подключаюсь: ${mode}`);
  const t0 = performance.now();
  try {
    const info = client.start ? await client.start() : await client.connect();
    log(`подключено за ${Math.round(performance.now() - t0)} мс; sqlite ${info.sqliteVersion}`, 'ok');
    paintDbInfo(info);
    const res = await client.request('init');
    if (!res.ok) {
      log(`init: ${res.error.name}: ${res.error.message}`, 'bad');
    } else {
      paintDbInfo(res.result);
    }
    return client;
  } catch (err) {
    log(`ошибка подключения: ${err.name}: ${err.message}`, 'bad');
    client = null;
    throw err;
  }
}

function disconnect() {
  if (!client) return;
  client.close();
  client = null;
  paintDbInfo(null);
  log('отключено');
}

function item(i, tx, prefix = 'file') {
  return {
    id: `${prefix}-${i}/content`,
    type: 'content',
    hash: `h${i}`,
    tx: tx + i + 1,
    json: JSON.stringify({ text: `# документ ${i}\n`, i }),
  };
}

function paintLastOp(pairs) {
  renderDict($('lastop'), pairs);
}

const actions = {
  async write(n = 1000, prefix = 'file') {
    const c = await connect();
    const tx0 = Date.now() / 1000;
    // Уникальный префикс на батч: иначе повторные вызовы перезаписывают те же id.
    const batch = `${prefix}${tx0.toString(36).replace('.', '')}`;
    const items = Array.from({ length: n }, (_, i) => item(i, tx0, batch));
    const t0 = performance.now();
    const res = await c.must('put', { items });
    const ms = Math.round(performance.now() - t0);
    log(`записано ${res.written} (${prefix}) за ${res.ms} мс (всего ${Math.round(performance.now() - t0)} мс)`, 'ok');
    paintLastOp([['written', res.written], ['ms', ms], ['rows', await c.must('count')]]);
    await refreshInfo();
    return { written: res.written, ms };
  },

  async read() {
    const c = await connect();
    const first = await c.must('get', { id: 'file-0/content' });
    const last = await c.must('get', { id: 'file-999/content' });
    log(`чтение: file-0 ${first ? 'есть' : 'нет'}, file-999 ${last ? 'есть' : 'нет'}`);
    paintLastOp([['file-0', first ? first.hash : '—'], ['file-999', last ? last.hash : '—']]);
    return { first, last };
  },

  async scan() {
    const c = await connect();
    const t0 = performance.now();
    const rows = await c.must('scan', { since: 0, limit: 5000 });
    log(`scan: ${rows.length} строк за ${Math.round(performance.now() - t0)} мс`);
    paintLastOp([['строк', rows.length], ['первый tx', rows[0]?.tx ?? '—'], ['последний tx', rows.at(-1)?.tx ?? '—']]);
    return { rows: rows.length };
  },

  async count() {
    const c = await connect();
    const n = await c.must('count');
    log(`count = ${n}`);
    paintLastOp([['строк', n]]);
    return n;
  },

  async persist() {
    // persist() вызывается из окна: в воркере этого метода нет.
    const c = await connect();
    const granted = await navigator.storage.persist();
    const storage = await c.must('storage');
    log(`persist: granted=${granted}, persisted=${storage.persisted}`, granted ? 'ok' : 'warn');
    await refreshInfo();
    return { granted, ...storage };
  },

  async integrity() {
    const c = await connect();
    const rows = await c.must('integrity');
    const ok = rows.length === 1 && rows[0] === 'ok';
    log(`integrity_check: ${rows.join('; ')}`, ok ? 'ok' : 'bad');
    paintLastOp([['integrity', rows.join('; ')]]);
    return rows;
  },

  async reopen() {
    const c = await connect();
    try {
      const res = await c.must('reopen');
      log(`второе соединение: ${res.secondConnection}`, 'warn');
      return res;
    } catch (err) {
      log(`второе соединение: ${err.name}: ${err.message}`, 'bad');
      return { error: err.message, name: err.name };
    }
  },

  async clear() {
    const c = await connect();
    await c.must('clear');
    log('таблица очищена', 'warn');
    await refreshInfo();
  },
};

// UI
$('connect').addEventListener('click', () => connect().catch(() => {}));
$('disconnect').addEventListener('click', disconnect);
$('write').addEventListener('click', () => actions.write());
$('read').addEventListener('click', () => actions.read());
$('scan').addEventListener('click', () => actions.scan());
$('count').addEventListener('click', () => actions.count());
$('persist').addEventListener('click', () => actions.persist());
$('reopen').addEventListener('click', () => actions.reopen());
$('clear').addEventListener('click', () => actions.clear());

paintEnv();
paintDbInfo(null);
log('стенд готов');

// Точка входа для автотеста: window.stand.connect('shared'), .write(1000), ...
window.stand = {
  connect: (mode) => {
    document.querySelector(`input[name=mode][value="${mode}"]`).checked = true;
    return connect();
  },
  disconnect,
  write: (n, prefix) => actions.write(n, prefix),
  integrity: () => actions.integrity(),
  read: () => actions.read(),
  scan: () => actions.scan(),
  count: () => actions.count(),
  persist: () => actions.persist(),
  reopen: () => actions.reopen(),
  clear: () => actions.clear(),
  info: () => refreshInfo(),
  log: (msg) => log(msg),
  get client() { return client; },
};
