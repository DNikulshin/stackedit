// Режим «один SharedWorker на origin = один владелец БД».
//
// Две вещи, найденные на стенде (Chrome 150) и определяющие структуру файла:
//   1. top-level await в module SharedWorker — onconnect не вызывается вообще;
//   2. статический import модуля, который тянет sqlite.wasm, блокирует тело модуля
//      так же, как TLA, — подключение тоже не приходит.
// Поэтому здесь нет ни TLA, ни статических импортов: onconnect назначается синхронно,
// а всё остальное грузится динамически.

let server = null;
let initError = null;
let portSeq = 0;
const ports = new Set();

const log = (msg) => console.log('[db:shared]', msg);

const send = (port, payload) => {
  try { port.postMessage(payload); } catch (err) { log(`port.postMessage: ${err.message}`); }
};

const ready = (async () => {
  try {
    const { createDbServer } = await import('./db-core.js');
    server = await createDbServer({ log });
    log('БД готова');
  } catch (err) {
    initError = { name: err.name || 'Error', message: String(err.message || err) };
    log(`инициализация не удалась: ${initError.name}: ${initError.message}`);
  }
  ports.forEach((port) => send(port, {
    type: 'ready',
    info: server ? server.info() : { openError: initError },
  }));
})();

self.onconnect = (event) => {
  const port = event.ports[0];
  const portId = ++portSeq;
  log(`подключился порт #${portId}`);
  ports.add(port);

  port.onmessage = async (e) => {
    await ready;
    if (!server) {
      send(port, {
        id: e.data && e.data.id,
        ok: false,
        error: initError || { name: 'NotReady', message: 'БД не инициализирована' },
      });
      return;
    }
    send(port, await server.handle(e.data));
  };

  // Если БД уже готова — отвечаем сразу, иначе ответит ready() выше.
  if (server || initError) {
    send(port, { type: 'ready', portId, info: server ? server.info() : { openError: initError } });
  }
};
