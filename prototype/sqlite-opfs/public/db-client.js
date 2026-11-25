// Клиент к воркеру: одинаковый API для режимов shared и dedicated.

export class DbClient {
  constructor(mode) {
    this.mode = mode;
    this.worker = null;
    this.port = null;
    this.seq = 0;
    this.pending = new Map();
    this.readyInfo = null;
    this.onLog = () => {};
  }

  static sharedWorkerSupported() {
    return typeof SharedWorker !== 'undefined';
  }

  async connect({ timeoutMs = 15000 } = {}) {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('воркер не ответил за 15 с')), timeoutMs);
      const onReady = (event) => {
        const msg = event.data;
        if (msg && msg.type === 'ready') {
          clearTimeout(timer);
          this.readyInfo = msg.info;
          this.worker.removeEventListener('message', onReady);
          resolve(msg.info);
        }
      };
      if (this.mode === 'shared') {
        if (!DbClient.sharedWorkerSupported()) reject(new Error('SharedWorker не поддерживается'));
        this.worker = new SharedWorker('./db.shared.js', { type: 'module' });
        this.worker.onerror = (e) => reject(new Error(`SharedWorker: ${e.message || 'ошибка'}`));
        this.port = this.worker.port;
        // Важно: сначала слушатель, потом start(), иначе ready-сообщение можно потерять.
        this.port.addEventListener('message', onReady);
        this.port.start();
      } else {
        this.worker = new Worker('./db.dedicated.js', { type: 'module' });
        this.worker.onerror = (e) => reject(new Error(`Worker: ${e.message || 'ошибка'}`));
        this.worker.addEventListener('message', onReady);
      }
    });

    // Общий обработчик ответов (ставится после ready-обработчика).
    const target = this.mode === 'shared' ? this.port : this.worker;
    target.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type === 'ready') return;
      const resolve = this.pending.get(msg.id);
      if (!resolve) return;
      this.pending.delete(msg.id);
      resolve(msg);
    });

    this.readyInfo = await ready;
    return this.readyInfo;
  }

  request(op, args = {}) {
    const id = ++this.seq;
    const target = this.mode === 'shared' ? this.port : this.worker;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      // Внимание: args идёт первым — иначе args.id перетрёт id запроса.
      target.postMessage({ ...args, id, op });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ id, ok: false, error: { name: 'Timeout', message: `${op}: нет ответа 10 с` } });
        }
      }, 10000);
    });
  }

  async must(op, args) {
    const res = await this.request(op, args);
    if (!res.ok) {
      const err = new Error(res.error.message);
      err.name = res.error.name;
      throw err;
    }
    return res.result;
  }

  close() {
    if (this.worker) this.worker.terminate?.();
    if (this.mode === 'shared' && this.port) this.port.close();
    this.worker = null;
    this.port = null;
  }
}
