// Вкладка-лидер: единственный владелец SQLite-БД в OPFS.
//
// Почему так: OPFS недоступен из SharedWorker — createSyncAccessHandle там запрещён,
// а VFS opfs требует SharedArrayBuffer, которого в SharedWorker нет (проверено на стенде).
// Значит владельцем БД может быть только Dedicated Worker, то есть конкретная вкладка.
// Лидерство раздаётся через Web Locks (лок держится, пока вкладка жива), обмен
// запросами — через BroadcastChannel, ответы адресные (tabId).

const DB_CHANNEL = 'stackedit-db-bus';
const DB_LOCK = 'stackedit-db-leader';

export class LeaderDbClient {
  constructor({ workerUrl = './db.dedicated.js' } = {}) {
    this.mode = 'leader';
    this.workerUrl = workerUrl;
    this.tabId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
    this.worker = null;
    this.isLeader = false;
    this.seq = 0;
    this.pending = new Map();
    this.channel = null;
    this.readyInfo = null;
    this.leaderInfo = null;
    this.releaseLock = null;
    this.resolveAcquired = null;
    this.log = (...args) => console.log('[leader]', ...args);
  }

  // --- транспорт ---

  workerRequest(op, args, timeoutMs = 15000) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: { name: 'Timeout', message: `${op}: нет ответа` } });
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      // Внимание: args идёт первым — иначе args.id перетрёт id запроса.
      this.worker.postMessage({ ...args, id, op });
    });
  }

  channelRequest(op, args, timeoutMs = 15000) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: { name: 'Timeout', message: `${op}: лидер не ответил за ${timeoutMs} мс` } });
      }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.channel.postMessage({ kind: 'request', tabId: this.tabId, id, op, args });
    });
  }

  request(op, args = {}) {
    return this.isLeader ? this.workerRequest(op, args) : this.channelRequest(op, args);
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

  // --- лидерство ---

  async start() {
    this.channel = new BroadcastChannel(DB_CHANNEL);
    this.channel.onmessage = (event) => this.onChannelMessage(event.data);

    const acquired = await this.tryTakeLeadership();
    if (!acquired) {
      const res = await this.channelRequest('info', {}, 10000);
      if (res.ok) {
        this.leaderInfo = res.result;
      } else if (res.error.name === 'Timeout') {
        // Лидер молчит — возможно, закрывается. Одна повторная попытка занять лок.
        this.log('лидер не ответил — повторная попытка захвата');
        await this.tryTakeLeadership();
      }
    }
    this.readyInfo = this.isLeader ? await this.must('info') : this.leaderInfo;
    return this.readyInfo;
  }

  async tryTakeLeadership() {
    if (!('locks' in navigator)) {
      await this.becomeLeader();
      return true;
    }

    const acquired = new Promise((resolve) => { this.resolveAcquired = resolve; });

    navigator.locks.request(DB_LOCK, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) {
        this.log('лок занят — работаю клиентом лидера');
        this.resolveAcquired(false);
        return;
      }
      this.log('лок получен — становлюсь лидером');
      try {
        await this.becomeLeader();
        this.resolveAcquired(true);
      } catch (err) {
        this.log(`лидер не смог открыть БД: ${err.message}`);
        this.resolveAcquired(false);
        return;
      }
      // Держим лок, пока вкладка жива.
      await new Promise((resolve) => { this.releaseLock = resolve; });
    }).catch((err) => {
      this.log(`locks.request: ${err.message}`);
      this.resolveAcquired(false);
    });

    return acquired;
  }

  async becomeLeader() {
    this.isLeader = true;
    this.worker = new Worker(this.workerUrl, { type: 'module' });

    this.worker.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type === 'ready') return;
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });

    this.leaderInfo = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('воркер лидера не ответил за 15 с')), 15000);
      const onReady = (event) => {
        const msg = event.data;
        if (msg && msg.type === 'ready') {
          clearTimeout(timer);
          resolve(msg.info);
        }
      };
      this.worker.addEventListener('message', onReady);
    });

    this.channel.postMessage({ kind: 'leader-ready', tabId: this.tabId, info: this.leaderInfo });
  }

  onChannelMessage(msg) {
    if (!msg) return;

    // Ответы адресованы нам (tabId совпадает) — их обрабатываем до фильтра чужих сообщений.
    if (msg.kind === 'response') {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
      return;
    }

    if (msg.tabId === this.tabId) return;

    if (msg.kind === 'leader-ready') {
      this.leaderInfo = msg.info;
      return;
    }

    if (msg.kind === 'request' && this.isLeader) {
      const reply = (res) => this.channel.postMessage({ kind: 'response', tabId: msg.tabId, ...res });
      const once = (event) => {
        const res = event.data;
        if (!res || res.id !== msg.id) return;
        this.worker.removeEventListener('message', once);
        reply(res);
      };
      this.worker.addEventListener('message', once);
      this.worker.postMessage({ ...(msg.args || {}), id: msg.id, op: msg.op });
    }
  }

  close() {
    if (this.releaseLock) this.releaseLock();
    if (this.worker) this.worker.terminate();
    if (this.channel) this.channel.close();
    this.worker = null;
    this.channel = null;
    this.isLeader = false;
  }
}
