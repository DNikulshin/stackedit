// Ядро прототипа: SQLite-Wasm поверх OPFS, схема под модель StackEdit.
//
// Модель данных повторяет то, что сейчас лежит в IndexedDB (src/services/localDbSvc.js):
//   store `objects`: id (PK), type, hash, tx; индекс по tx — «что изменилось с версии N».
// Удаление — запись без hash (delete-маркер), как в текущем коде.
//
// Здесь только синхронный API: файл открыт в воркере, поэтому доступ к OPFS идёт через
// FileSystemSyncAccessHandle — единственный режим, где SQLite-Wasm работает нормально.

import sqlite3InitModule from './vendor/sqlite-wasm/index.mjs';

const DB_PATH = '/stackedit-db.sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (
  id   TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  hash TEXT,              -- NULL = delete-маркер
  tx   INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_tx ON objects(tx);
`;

function jsonOut(row) {
  return {
    id: row.id,
    type: row.type,
    hash: row.hash,
    tx: row.tx,
    ...JSON.parse(row.json),
  };
}

export async function createDbServer({ log = () => {} } = {}) {
  const state = {
    sqliteVersion: null,
    vfs: null,
    db: null,
    openError: null,
    openedAt: null,
    writes: 0,
    lastStorage: {},
  };

  const sqlite3 = await sqlite3InitModule();
  state.sqliteVersion = sqlite3.version.libVersion;

  // В Dedicated Worker с COOP/COEP доступен VFS `opfs` (нужен SharedArrayBuffer и
  // createSyncAccessHandle). В SharedWorker Chrome не даёт ни того, ни другого
  // (crossOriginIsolated=false, createSyncAccessHandle → SecurityError), поэтому там
  // остаётся только `opfs-sahpool`. Наличие VFS проверяем по конструктору: флаг
  // `'opfs' in sqlite3` в этой сборке не выставляется автоматически.
  let openDb;
  let poolUtil = null;
  if (typeof sqlite3.oo1?.OpfsDb === 'function') {
    state.vfs = 'opfs';
    openDb = (path) => new sqlite3.oo1.OpfsDb(path);
  } else if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
    state.vfs = 'opfs-sahpool';
    poolUtil = await sqlite3.installOpfsSAHPoolVfs({
      name: 'stackedit-pool',
      // Не стирать хранилище при неудачной инициализации: для пользовательских
      // документов молчаливое удаление — недопустимый сценарий.
      clearOnInit: false,
    });
    openDb = (path) => new poolUtil.OpfsSAHPoolDb(path);
  } else {
    throw new Error('OPFS недоступен: ни VFS opfs, ни opfs-sahpool');
  }
  log(`sqlite3 ${state.sqliteVersion}, VFS ${state.vfs}`);

  const open = () => {
    if (state.db) return state.db;
    const t0 = performance.now();
    try {
      state.db = openDb(DB_PATH);
      state.db.exec(SCHEMA);
      state.openedAt = Math.round(performance.now() - t0);
      log(`БД открыта за ${state.openedAt} мс: ${state.db.filename}`);
    } catch (err) {
      state.openError = { name: err.name || 'Error', message: String(err.message || err) };
      state.openedAt = Math.round(performance.now() - t0);
      log(`БД НЕ открыта (${state.openedAt} мс): ${state.openError.name}: ${state.openError.message}`);
      throw err;
    }
    return state.db;
  };

  const requireDb = () => {
    if (state.db) return state.db;
    if (state.openError) {
      const err = new Error(state.openError.message);
      err.name = state.openError.name;
      throw err;
    }
    return open();
  };

  const ops = {
    init() {
      open();
      return { ...ops.info(), reopened: state.openedAt };
    },

    info() {
      return {
        sqliteVersion: state.sqliteVersion,
        vfs: state.vfs,
        dbFile: DB_PATH,
        openError: state.openError,
        openedMs: state.openedAt,
        writes: state.writes,
        ...state.lastStorage,
      };
    },

    // Пакетная запись (в одной транзакции): [{id,type,hash,tx,json}]
    put({ items }) {
      const db = requireDb();
      const t0 = performance.now();
      db.transaction(() => {
        const stmt = db.prepare(
          'INSERT INTO objects (id, type, hash, tx, json) VALUES (?, ?, ?, ?, ?) '
          + 'ON CONFLICT(id) DO UPDATE SET type=excluded.type, hash=excluded.hash, '
          + 'tx=excluded.tx, json=excluded.json',
        );
        try {
          items.forEach((it) => {
            stmt.bind([it.id, it.type, it.hash ?? null, it.tx, it.json]);
            stmt.step();
            stmt.reset();
          });
        } finally {
          stmt.finalize();
        }
      });
      state.writes += items.length;
      return { written: items.length, ms: Math.round(performance.now() - t0) };
    },

    get({ id }) {
      const db = requireDb();
      let out = null;
      db.exec({
        sql: 'SELECT id, type, hash, tx, json FROM objects WHERE id = ?',
        bind: [id],
        rowMode: 'object',
        callback: (row) => { out = jsonOut(row); },
      });
      return out;
    },

    del({ id }) {
      const db = requireDb();
      db.exec({ sql: 'DELETE FROM objects WHERE id = ?', bind: [id] });
      return { deleted: id };
    },

    // Аналог index.openCursor() по индексу tx: «все изменения начиная с версии tx»
    scan({ since = 0, limit = 1000 } = {}) {
      const db = requireDb();
      const rows = [];
      db.exec({
        sql: 'SELECT id, type, hash, tx, json FROM objects WHERE tx > ? ORDER BY tx LIMIT ?',
        bind: [since, limit],
        rowMode: 'object',
        callback: (row) => { rows.push(jsonOut(row)); },
      });
      return rows;
    },

    integrity() {
      const db = requireDb();
      const rows = [];
      db.exec({ sql: 'PRAGMA integrity_check', rowMode: 'object', callback: (r) => rows.push(r) });
      return rows.map((r) => Object.values(r).join(','));
    },

    count() {
      const db = requireDb();
      let n = 0;
      db.exec({ sql: 'SELECT count(*) AS n FROM objects', rowMode: 'object', callback: (r) => { n = r.n; } });
      return n;
    },

    clear() {
      const db = requireDb();
      db.exec('DELETE FROM objects');
      return { cleared: true };
    },

    // Проверка эксклюзивности: второе соединение к тому же файлу в том же воркере.
    reopen() {
      requireDb();
      const second = openDb(DB_PATH);
      try {
        second.exec('SELECT count(*) FROM objects');
        return { secondConnection: 'ok', vfs: state.vfs };
      } finally {
        second.close();
      }
    },

    close() {
      if (state.db) {
        state.db.close();
        state.db = null;
        return { closed: true };
      }
      return { closed: false };
    },
  };

  // Сведения о хранилище (асинхронно, кэшируются для info()).
  const refreshStorage = async () => {
    const out = {};
    try {
      out.persisted = await navigator.storage.persisted();
      const est = await navigator.storage.estimate();
      out.usage = est.usage ?? null;
      out.quota = est.quota ?? null;
    } catch (err) {
      out.storageError = String(err.message || err);
    }
    state.lastStorage = out;
    return out;
  };
  refreshStorage();
  // persist() в воркере недоступен (проверено: navigator.storage.persist is not a function),
  // поэтому разрешение запрашивает страница, а воркер только сообщает своё состояние.
  ops.storage = async () => refreshStorage();

  // Открываем сразу: если файл занят другим воркером, ошибка должна быть видна на старте.
  try {
    open();
  } catch {
    // ошибка сохранена в state.openError, вернём её в info()
  }

  return {
    async handle(msg) {
      const { id, op, ...args } = msg || {};
      const fn = ops[op];
      if (!fn) return { id, ok: false, error: { name: 'NoSuchOp', message: String(op) } };
      try {
        const result = await fn(args);
        return { id, ok: true, result };
      } catch (err) {
        return {
          id,
          ok: false,
          error: { name: err.name || 'Error', message: String(err.message || err) },
        };
      }
    },
    info: () => ops.info(),
    poolUtil,
  };
}
