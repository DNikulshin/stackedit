import utils from './utils';
import store from '../store';
import welcomeFile from '../data/welcomeFile.md';
import workspaceSvc from './workspaceSvc';
import constants from '../data/constants';
import storageSvc from './storageSvc';

const deleteMarkerMaxAge = 1000;
const dbVersion = 1;
const dbStoreName = 'objects';
const { silent } = utils.queryParams;
const resetApp = localStorage.getItem('resetStackEdit');
if (resetApp) {
  localStorage.removeItem('resetStackEdit');
}

class Connection {
  constructor(workspaceId = store.getters['workspace/currentWorkspace'].id) {
    this.getTxCbs = [];

    // Make the DB name
    this.dbName = utils.getDbName(workspaceId);

    // Init connection
    const request = indexedDB.open(this.dbName, dbVersion);

    request.onerror = () => {
      throw new Error("Can't connect to IndexedDB.");
    };

    request.onsuccess = (event) => {
      this.db = event.target.result;
      this.db.onversionchange = () => window.location.reload();

      this.getTxCbs.forEach(({ onTx, onError }) => this.createTx(onTx, onError));
      this.getTxCbs = null;
    };

    request.onupgradeneeded = (event) => {
      const eventDb = event.target.result;
      const oldVersion = event.oldVersion || 0;

      // We don't use 'break' in this switch statement,
      // the fall-through behavior is what we want.
      /* eslint-disable no-fallthrough */
      switch (oldVersion) {
        case 0: {
          // Create store
          const dbStore = eventDb.createObjectStore(dbStoreName, {
            keyPath: 'id',
          });
          dbStore.createIndex('tx', 'tx', {
            unique: false,
          });
        }
        default:
      }
      /* eslint-enable no-fallthrough */
    };
  }

  /**
   * Create a transaction asynchronously.
   */
  createTx(onTx, onError) {
    // If DB is not ready, keep callbacks for later
    if (!this.db) {
      return this.getTxCbs.push({ onTx, onError });
    }

    // Open transaction in read/write will prevent conflict with other tabs
    const tx = this.db.transaction(this.db.objectStoreNames, 'readwrite');
    tx.onerror = onError;

    return onTx(tx);
  }
}

const contentTypes = {
  content: true,
  contentState: true,
  syncedContent: true,
};

const itemTypes = new Set(constants.types);

/**
 * IDs of the store items that may differ from the DB.
 *
 * Filled by the mutation subscriber below, so that sync() does not have to walk every
 * item of the workspace at every change. `null` means "everything may have changed":
 * that is the state before the first write and after a full scan.
 */
let pendingIds = null;
let pendingDeletes = false;

const hashMap = {};
constants.types.forEach((type) => {
  hashMap[type] = Object.create(null);
});
const lsHashMap = Object.create(null);

const localDbSvc = {
  lastTx: 0,
  hashMap,
  connection: null,
  applyingDbChanges: false,

  /**
   * Sync data items stored in the localStorage.
   */
  syncLocalStorage() {
    constants.localStorageDataIds.forEach((id) => {
      const key = `data/${id}`;

      // Skip reloading the layoutSettings
      if (id !== 'layoutSettings' || !lsHashMap[id]) {
        try {
          // Try to parse the item from the localStorage
          const storedItem = JSON.parse(localStorage.getItem(key));
          if (storedItem.hash && lsHashMap[id] !== storedItem.hash) {
            // Item has changed, replace it in the store
            store.commit('data/setItem', storedItem);
            lsHashMap[id] = storedItem.hash;
          }
        } catch (e) {
          // Ignore parsing issue
        }
      }

      // Write item if different from stored one
      const item = store.state.data.lsItemsById[id];
      if (item && item.hash !== lsHashMap[id]) {
        localStorage.setItem(key, JSON.stringify(item));
        lsHashMap[id] = item.hash;
      }
    });
  },

  /**
   * Return a promise that will be resolved once the synchronization between the store and the
   * localDb will be finished. Effectively, open a transaction, then read and apply all changes
   * from the DB since the previous transaction, then write all the changes from the store.
   */
  async sync() {
    // Take the pending changes now: mutations made during the transaction are kept for the
    // next one instead of being silently dropped
    const changedIds = pendingIds;
    const deleted = pendingDeletes;
    pendingIds = new Set();
    pendingDeletes = false;

    return new Promise((resolve, reject) => {
      // Create the DB transaction
      this.connection.createTx((tx) => {
        const { lastTx } = this;

        // Look for DB changes and apply them to the store
        this.readAll(tx, (storeItemMap) => {
          // Sanitize the workspace if changes have been applied
          if (lastTx !== this.lastTx) {
            workspaceSvc.sanitizeWorkspace();
          }

          // Persist all the store changes into the DB
          if (changedIds === null) {
            // Full pass: nothing is known about the previous state
            this.writeAll(storeItemMap, tx);
          } else if (changedIds.size) {
            this.writeItems(changedIds, storeItemMap, tx);
          }
          if (deleted) {
            // A file may have been deleted without its content, sweep the known items
            this.removeDeletedItems(storeItemMap, tx);
          }
          // Sync the localStorage
          this.syncLocalStorage();
          // Done
          resolve();
        });
      }, () => reject(new Error('Local DB access error.')));
    });
  },

  /**
   * Read and apply all changes from the DB since previous transaction.
   */
  readAll(tx, cb) {
    let { lastTx } = this;
    const dbStore = tx.objectStore(dbStoreName);
    const index = dbStore.index('tx');
    const range = IDBKeyRange.lowerBound(this.lastTx, true);
    const changes = [];
    index.openCursor(range).onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const item = cursor.value;
        if (item.tx > lastTx) {
          lastTx = item.tx;
          if (this.lastTx && item.tx - this.lastTx > deleteMarkerMaxAge) {
            // We may have missed some delete markers
            window.location.reload();
            return;
          }
        }
        // Collect change
        changes.push(item);
        cursor.continue();
        return;
      }

      // Read the collected changes. The map is copied only when it gets modified below
      const storeItemMap = changes.length
        ? { ...store.getters.allItemsById }
        : store.getters.allItemsById;
      this.applyingDbChanges = true;
      changes.forEach((item) => {
        this.readDbItem(item, storeItemMap);
        // If item is an old delete marker, remove it from the DB
        if (!item.hash && lastTx - item.tx > deleteMarkerMaxAge) {
          dbStore.delete(item.id);
        }
      });
      this.applyingDbChanges = false;

      this.lastTx = lastTx;
      cb(storeItemMap);
    };
  },

  /**
   * Write all changes from the store since previous transaction.
   *
   * Used for the first pass only: it walks every known item, which is what makes it
   * unsuitable for the per-second sync.
   */
  writeAll(storeItemMap, tx) {
    if (silent) {
      // Skip writing to DB in silent mode
      return;
    }
    const dbStore = tx.objectStore(dbStoreName);
    const incrementedTx = this.lastTx + 1;

    // Remove deleted store items
    this.removeDeletedItems(storeItemMap, tx);

    // Put changes
    Object.entries(storeItemMap).forEach(([, storeItem]) => {
      // Store object has changed
      if (this.hashMap[storeItem.type][storeItem.id] !== storeItem.hash) {
        const item = {
          ...storeItem,
          tx: incrementedTx,
        };
        dbStore.put(item);
        this.hashMap[item.type][item.id] = item.hash;
        this.lastTx = incrementedTx;
      }
    });
  },

  /**
   * Write the items that changed since the previous transaction.
   */
  writeItems(changedIds, storeItemMap, tx) {
    if (silent) {
      // Skip writing to DB in silent mode
      return;
    }
    const dbStore = tx.objectStore(dbStoreName);
    const incrementedTx = this.lastTx + 1;

    changedIds.forEach((id) => {
      const storeItem = storeItemMap[id];
      if (storeItem) {
        // Store object has changed
        if (this.hashMap[storeItem.type][id] !== storeItem.hash) {
          const item = {
            ...storeItem,
            tx: incrementedTx,
          };
          dbStore.put(item);
          this.hashMap[storeItem.type][id] = storeItem.hash;
          this.lastTx = incrementedTx;
        }
        return;
      }

      // Item has left the store: either it was unloaded, or it was deleted
      const type = this.getKnownType(id);
      if (!type || !this.isDeleted(type, id)) {
        return;
      }
      // Put a delete marker to notify other tabs
      dbStore.put({
        id,
        type,
        tx: incrementedTx,
      });
      delete this.hashMap[type][id];
      this.lastTx = incrementedTx;
    });
  },

  /**
   * Put delete markers for the known items that are not in the store anymore.
   */
  removeDeletedItems(storeItemMap, tx) {
    const dbStore = tx.objectStore(dbStoreName);
    const incrementedTx = this.lastTx + 1;

    Object.keys(this.hashMap).forEach((type) => {
      Object.keys(this.hashMap[type]).forEach((id) => {
        if (storeItemMap[id] || !this.isDeleted(type, id)) {
          return;
        }
        dbStore.put({
          id,
          type,
          tx: incrementedTx,
        });
        delete this.hashMap[type][id];
        this.lastTx = incrementedTx;
      });
    });
  },

  /**
   * Whether an item that is absent from the store was really deleted.
   *
   * Contents and content states are unloaded from the store when they are not opened
   * recently, so for those types only a deleted file means a deleted item.
   */
  isDeleted(type, id) {
    if (!contentTypes[type]) {
      return true;
    }
    const [fileId] = id.split('/');
    return !store.state.file.itemsById[fileId];
  },

  /**
   * Return the type under which the item is known in the DB, if it is known at all.
   */
  getKnownType(id) {
    let knownType = null;
    Object.keys(this.hashMap).some((type) => {
      if (id in this.hashMap[type]) {
        knownType = type;
        return true;
      }
      return false;
    });
    return knownType;
  },

  /**
   * Read and apply one DB change.
   */
  readDbItem(dbItem, storeItemMap) {
    const storeItem = storeItemMap[dbItem.id];
    if (!dbItem.hash) {
      // DB item is a delete marker
      delete this.hashMap[dbItem.type][dbItem.id];
      if (storeItem) {
        // Remove item from the store
        store.commit(`${storeItem.type}/deleteItem`, storeItem.id);
        delete storeItemMap[storeItem.id];
      }
    } else if (this.hashMap[dbItem.type][dbItem.id] !== dbItem.hash) {
      // DB item is different from the corresponding store item
      this.hashMap[dbItem.type][dbItem.id] = dbItem.hash;
      // Update content only if it exists in the store
      if (storeItem || !contentTypes[dbItem.type]) {
        // Put item in the store
        dbItem.tx = undefined;
        store.commit(`${dbItem.type}/setItem`, dbItem);
        storeItemMap[dbItem.id] = dbItem;
      }
    }
  },

  /**
   * Retrieve an item from the DB and put it in the store.
   */
  async loadItem(id) {
    // Check if item is in the store
    const itemInStore = store.getters.allItemsById[id];
    if (itemInStore) {
      // Use deepCopy to freeze item
      return Promise.resolve(itemInStore);
    }
    return new Promise((resolve, reject) => {
      // Get the item from DB
      const onError = () => reject(new Error('Data not available.'));
      this.connection.createTx((tx) => {
        const dbStore = tx.objectStore(dbStoreName);
        const request = dbStore.get(id);
        request.onsuccess = () => {
          const dbItem = request.result;
          if (!dbItem || !dbItem.hash) {
            onError();
          } else {
            this.hashMap[dbItem.type][dbItem.id] = dbItem.hash;
            // Put item in the store
            dbItem.tx = undefined;
            store.commit(`${dbItem.type}/setItem`, dbItem);
            resolve(dbItem);
          }
        };
      }, () => onError());
    });
  },

  /**
   * Unload from the store contents that haven't been opened recently
   */
  async unloadContents() {
    await this.sync();
    // Keep only last opened files in memory
    const lastOpenedFileIdSet = new Set(store.getters['data/lastOpenedIds']);
    Object.keys(contentTypes).forEach((type) => {
      store.getters[`${type}/items`].forEach((item) => {
        const [fileId] = item.id.split('/');
        if (!lastOpenedFileIdSet.has(fileId)) {
          // Remove item from the store
          store.commit(`${type}/deleteItem`, item.id);
        }
      });
    });
  },

  /**
   * Create the connection and start syncing.
   */
  async init() {
    // Reset the app if the reset flag was passed
    if (resetApp) {
      await Promise.all(Object.keys(store.getters['workspace/workspacesById'])
        .map(workspaceId => workspaceSvc.removeWorkspace(workspaceId)));
      constants.localStorageDataIds.forEach((id) => {
        // Clean data stored in localStorage
        localStorage.removeItem(`data/${id}`);
      });
      throw new Error('RELOAD');
    }

    // Collect the IDs of the items that the store changes, so that sync() does not have
    // to compare every known item with the DB once per second. Subscribed here and not at
    // module level: the store is not available yet when this module is evaluated, because
    // it imports the store modules that import this service back.
    store.subscribe((mutation) => {
      const [moduleName, mutationName] = mutation.type.split('/');
      if (this.applyingDbChanges || !itemTypes.has(moduleName)) {
        return;
      }
      if (mutationName === 'deleteItem') {
        pendingDeletes = true;
      }
      const { payload } = mutation;
      const id = typeof payload === 'string' ? payload : payload && payload.id;
      // While a full pass is pending, collecting single IDs is pointless
      if (id && pendingIds) {
        pendingIds.add(id);
      }
    });

    // Create the connection
    this.connection = new Connection();

    // Ask for a persistent storage in the background (may be evicted otherwise)
    storageSvc.autoRequestPersist();

    // Load the DB
    await localDbSvc.sync();

    // Watch workspace deletions and persist them as soon as possible
    // to make the changes available to reloading workspace tabs.
    store.watch(
      () => store.getters['data/workspaces'],
      () => this.syncLocalStorage(),
    );

    // Save welcome file content hash if not done already
    const hash = utils.hash(welcomeFile);
    const { welcomeFileHashes } = store.getters['data/localSettings'];
    if (!welcomeFileHashes[hash]) {
      store.dispatch('data/patchLocalSettings', {
        welcomeFileHashes: {
          ...welcomeFileHashes,
          [hash]: 1,
        },
      });
    }

    // If app was last opened 7 days ago and synchronization is off
    if (!store.getters['workspace/syncToken'] &&
      (store.state.workspace.lastFocus + constants.cleanTrashAfter < Date.now())
    ) {
      // Clean files
      store.getters['file/items']
        .filter(file => file.parentId === 'trash') // If file is in the trash
        .forEach(file => workspaceSvc.deleteFile(file.id));
    }

    // Sync local DB periodically
    utils.setInterval(() => localDbSvc.sync(), 1000);

    // watch current file changing
    store.watch(
      () => store.getters['file/current'].id,
      async () => {
        // See if currentFile is real, ie it has an ID
        const currentFile = store.getters['file/current'];
        // If current file has no ID, get the most recent file
        if (!currentFile.id) {
          const recentFile = store.getters['file/lastOpened'];
          // Set it as the current file
          if (recentFile.id) {
            store.commit('file/setCurrentId', recentFile.id);
          } else {
            // If still no ID, create a new file
            const newFile = await workspaceSvc.createFile({
              name: 'Welcome file',
              text: welcomeFile,
            }, true);
            // Set it as the current file
            store.commit('file/setCurrentId', newFile.id);
          }
        } else {
          try {
            // Load contentState from DB
            await localDbSvc.loadContentState(currentFile.id);
            // Load syncedContent from DB
            await localDbSvc.loadSyncedContent(currentFile.id);
            // Load content from DB
            try {
              await localDbSvc.loadItem(`${currentFile.id}/content`);
            } catch (err) {
              // Failure (content is not available), go back to previous file
              const lastOpenedFile = store.getters['file/lastOpened'];
              store.commit('file/setCurrentId', lastOpenedFile.id);
              throw err;
            }
            // Set last opened file
            store.dispatch('data/setLastOpenedId', currentFile.id);
            // Cancel new discussion and open the gutter if file contains discussions
            store.commit(
              'discussion/setCurrentDiscussionId',
              store.getters['discussion/nextDiscussionId'],
            );
          } catch (err) {
            console.error(err); // eslint-disable-line no-console
            store.dispatch('notification/error', err);
          }
        }
      },
      { immediate: true },
    );
  },

  getWorkspaceItems(workspaceId, onItem, onFinish = () => {}) {
    const connection = new Connection(workspaceId);
    connection.createTx((tx) => {
      const dbStore = tx.objectStore(dbStoreName);
      const index = dbStore.index('tx');
      index.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          onItem(cursor.value);
          cursor.continue();
        } else {
          connection.db.close();
          onFinish();
        }
      };
    });

    // Return a cancel function
    return () => connection.db.close();
  },
};

const loader = type => fileId => localDbSvc.loadItem(`${fileId}/${type}`)
  // Item does not exist, create it
  .catch(() => store.commit(`${type}/setItem`, {
    id: `${fileId}/${type}`,
  }));
localDbSvc.loadSyncedContent = loader('syncedContent');
localDbSvc.loadContentState = loader('contentState');


export default localDbSvc;
