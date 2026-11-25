import FileSaver from 'file-saver';
import store from '../store';
import utils from './utils';
import constants from '../data/constants';

const dbStoreName = 'objects';
const mainDbName = utils.getDbName('main');
// Workspace IDs are base36 numbers, see utils.makeWorkspaceId
const dbNamePattern = new RegExp(`^${mainDbName}(-[0-9a-z]+)?$`);
const backupFormat = 'stackedit-workspaces-backup';
const backupFormatVersion = 1;

/**
 * Return the ID of the workspace stored in the specified database.
 */
const workspaceIdFromDbName = dbName => (dbName === mainDbName
  ? 'main'
  : dbName.slice(mainDbName.length + 1));

/**
 * List the names of the databases owned by the app.
 *
 * `indexedDB.databases()` returns every database of the origin, and the origin is
 * shared with other apps when StackEdit is served from a subdirectory
 * (GitHub Pages project page, /preview/<name>/), hence the name filter.
 */
const listDbNames = async () => {
  let dbNames;
  if (indexedDB.databases) {
    dbNames = (await indexedDB.databases()).map(({ name }) => name);
  } else {
    // Fallback for browsers without indexedDB.databases()
    dbNames = [
      mainDbName,
      ...Object.keys(store.getters['data/workspaces'])
        .map(workspaceId => utils.getDbName(workspaceId)),
    ];
  }
  return dbNames
    .filter(name => name && dbNamePattern.test(name))
    .sort();
};

/**
 * Open a database without upgrading it.
 */
const openDb = dbName => new Promise((resolve, reject) => {
  const request = indexedDB.open(dbName);
  request.onerror = () => reject(new Error(`Can't open the ${dbName} database.`));
  request.onsuccess = () => resolve(request.result);
});

/**
 * Read all the items of a database, or an empty list if it has no object store yet.
 */
const readItems = (db) => {
  if (!db.objectStoreNames.contains(dbStoreName)) {
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    const items = [];
    const tx = db.transaction(dbStoreName, 'readonly');
    tx.onerror = () => reject(new Error(`Can't read the ${db.name} database.`));
    tx.oncomplete = () => resolve(items);
    tx.objectStore(dbStoreName).openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.continue();
      }
    };
  });
};

/**
 * Build a file name friendly timestamp.
 */
const timestamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/**
 * Whether the browser asks the user before granting a persistent storage.
 * Firefox notifies the user with a permission popup, Chrome and Safari decide silently.
 */
const promptsForPersistence = () => /Firefox\/|FxiOS\//.test(navigator.userAgent);

const storageSvc = {
  /**
   * Whether the browser promised not to evict the data of this origin.
   */
  async persisted() {
    if (!navigator.storage || !navigator.storage.persisted) {
      return false;
    }
    return navigator.storage.persisted();
  },

  /**
   * Ask the browser to make the storage persistent.
   *
   * Chrome decides on its own, Firefox shows a permission prompt, therefore this
   * has to be called from a user gesture rather than on page load.
   */
  async requestPersist() {
    if (!navigator.storage || !navigator.storage.persist) {
      return false;
    }
    return navigator.storage.persist();
  },

  /**
   * Ask for a persistent storage at startup, without blocking and without errors.
   *
   * Firefox is excluded: it shows a permission popup, and asking on page load would
   * be hostile. There the request is left to the Storage settings tab, that is, to a
   * user gesture. Chrome and Safari decide on their own based on the user history.
   */
  async autoRequestPersist() {
    try {
      if (promptsForPersistence() || await this.persisted()) {
        return false;
      }
      return await this.requestPersist();
    } catch (e) {
      // Best-effort storage is the default, no need to bother the user
      return false;
    }
  },

  /**
   * Resolve to the origin usage and quota in bytes, or to null if not available.
   */
  async estimate() {
    if (!navigator.storage || !navigator.storage.estimate) {
      return null;
    }
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  },

  /**
   * Parse a backup file.
   *
   * Resolves to the full backup object, or to null when the file is a single
   * workspace backup (the format the "Export workspace backup" entry produces).
   */
  parseBackup(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!parsed || parsed.format !== backupFormat || !parsed.databases) {
      return null;
    }
    return parsed;
  },

  /**
   * Dump every workspace database into a single serializable backup.
   *
   * Each `items` map has the same shape as the single workspace backup produced by
   * the "Export workspace backup" entry, so that one workspace can be restored as
   * is with "Import workspace backup".
   *
   * Databases are read sequentially: several readwrite connections to the same
   * database opened in parallel are not reliable (see prototype/sqlite-opfs).
   */
  async exportAllBackup() {
    const dbNames = await listDbNames();
    const workspacesById = store.getters['data/workspaces'];
    const databases = {};
    await utils.awaitSequence(dbNames, async (dbName) => {
      const workspaceId = workspaceIdFromDbName(dbName);
      const workspace = workspacesById[workspaceId] || {};
      const db = await openDb(dbName);
      let dbItems;
      try {
        dbItems = await readItems(db);
      } finally {
        db.close();
      }
      const items = {};
      dbItems.forEach((dbItem) => {
        // Delete markers carry no data, they only notify the other tabs
        if (dbItem.hash) {
          const item = { ...dbItem };
          // Transaction numbers are local to a browser, they are recomputed on import
          delete item.tx;
          items[item.id] = item;
        }
      });
      databases[dbName] = {
        workspaceId,
        workspaceName: workspace.name || '',
        providerId: workspace.providerId || '',
        itemCount: Object.keys(items).length,
        items,
      };
    });
    return {
      format: backupFormat,
      formatVersion: backupFormatVersion,
      exportedAt: new Date().toISOString(),
      appVersion: VERSION,
      origin: constants.origin,
      databases,
    };
  },

  /**
   * Format a byte count for the UI.
   */
  formatBytes(bytes) {
    if (typeof bytes !== 'number') {
      return 'unknown';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  },

  /**
   * Dump every workspace database and save the result as a file.
   * Call localDbSvc.sync() beforehand to flush the pending store changes.
   */
  async downloadBackup() {
    const backup = await this.exportAllBackup();
    const blob = new Blob([JSON.stringify(backup)], {
      type: 'application/json;charset=utf-8',
    });
    FileSaver.saveAs(blob, `StackEdit backup ${timestamp()}.json`);
    return backup;
  },
};

export default storageSvc;
