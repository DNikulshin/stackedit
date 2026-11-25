// Режим «одна вкладка = один воркер = одна БД».
// Вторая вкладка с тем же файлом должна упереться в эксклюзивную блокировку OPFS —
// это и есть проверяемое ограничение.

import { createDbServer } from './db-core.js';

const log = (msg) => console.log('[db:dedicated]', msg);
const server = await createDbServer({ log });

self.onmessage = async (event) => {
  const reply = await server.handle(event.data);
  self.postMessage(reply);
};
self.postMessage({ type: 'ready', info: server.info() });
