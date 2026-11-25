<template>
  <modal-inner class="modal__inner-1--settings" aria-label="Settings">
    <div class="modal__content">
      <div class="tabs flex flex--row">
        <tab :active="tab === 'custom'" @click="tab = 'custom'">
          Custom settings
        </tab>
        <tab :active="tab === 'default'" @click="tab = 'default'">
          Default settings
        </tab>
        <tab :active="tab === 'storage'" @click="tab = 'storage'">
          Storage
        </tab>
      </div>
      <div class="form-entry" v-if="tab === 'custom'" role="tabpanel" aria-label="Custom settings">
        <label class="form-entry__label">YAML</label>
        <div class="form-entry__field form-entry__field--code-editor">
          <code-editor lang="yaml" :value="customSettings" key="custom-settings" @changed="setCustomSettings"></code-editor>
        </div>
      </div>
      <div class="form-entry" v-else-if="tab === 'default'" role="tabpanel" aria-label="Default settings">
        <label class="form-entry__label">YAML</label>
        <div class="form-entry__field form-entry__field--code-editor">
          <code-editor lang="yaml" :value="defaultSettings" key="default-settings" disabled="true"></code-editor>
        </div>
      </div>
      <div class="form-entry" v-else-if="tab === 'storage'" role="tabpanel" aria-label="Storage">
        <label class="form-entry__label">Your files are stored in this browser</label>
        <div class="form-entry__field storage-entry">
          <div class="storage-entry__text">
            <div :class="['storage-entry__state', {'storage-entry__state--protected': persisted}]">{{persistenceState}}</div>
            <div class="storage-entry__hint">{{persistenceHint}}</div>
          </div>
          <div class="form-entry__actions" v-if="persistenceSupported && !persisted">
            <button class="button" type="button" :disabled="busy" @click="requestPersist">
              Request persistent storage
            </button>
          </div>
        </div>
        <label class="form-entry__label">Space used</label>
        <div class="form-entry__field storage-entry">
          <div class="storage-entry__text">{{usageLabel}}</div>
          <div class="form-entry__actions">
            <button class="button" type="button" :disabled="busy" @click="exportBackup">
              Export backup
            </button>
          </div>
        </div>
        <div class="storage-entry__hint" v-if="storageError">{{storageError}}</div>
      </div>
      <div class="modal__error modal__error--settings">{{error}}</div>
    </div>
    <div class="modal__button-bar">
      <button class="button" @click="config.reject()">Cancel</button>
      <button class="button button--resolve" @click="resolve">Ok</button>
    </div>
  </modal-inner>
</template>

<script>
import yaml from 'js-yaml';
import { mapGetters } from 'vuex';
import ModalInner from './common/ModalInner';
import Tab from './common/Tab';
import CodeEditor from '../CodeEditor';
import defaultSettings from '../../data/defaults/defaultSettings.yml';
import store from '../../store';
import badgeSvc from '../../services/badgeSvc';
import localDbSvc from '../../services/localDbSvc';
import storageSvc from '../../services/storageSvc';

const emptySettings = `# Add your custom settings here to override the
# default settings.
`;

export default {
  components: {
    ModalInner,
    Tab,
    CodeEditor,
  },
  data: () => ({
    tab: 'custom',
    defaultSettings,
    customSettings: null,
    error: null,
    persisted: false,
    persistenceSupported: false,
    estimate: null,
    busy: false,
    storageError: null,
  }),
  computed: {
    ...mapGetters('modal', [
      'config',
    ]),
    strippedCustomSettings() {
      return this.customSettings === emptySettings ? '\n' : this.customSettings.replace(/\t/g, '  ');
    },
    persistenceState() {
      if (!this.persistenceSupported) {
        return 'This browser does not support persistent storage.';
      }
      return this.persisted
        ? 'Protected from automatic removal by the browser.'
        : 'Not protected, the browser may remove your files when the disk is full.';
    },
    persistenceHint() {
      if (!this.persistenceSupported) {
        return 'Your files are still saved locally, but exporting a backup is the only way to keep them for sure.';
      }
      return this.persisted
        ? 'Only you can remove them by clearing the site data.'
        : 'Chrome and Safari decide on their own, Firefox asks before granting it.';
    },
    usageLabel() {
      if (!this.estimate) {
        return 'Not reported by this browser.';
      }
      const used = storageSvc.formatBytes(this.estimate.usage);
      const quota = storageSvc.formatBytes(this.estimate.quota);
      return `${used} used of ${quota} available`;
    },
  },
  watch: {
    tab(value) {
      if (value === 'storage') {
        this.loadStorage();
      }
    },
  },
  created() {
    const settings = store.getters['data/settings'];
    this.setCustomSettings(settings === '\n' ? emptySettings : settings);
    this.loadStorage();
  },
  methods: {
    async loadStorage() {
      this.persistenceSupported = !!(navigator.storage && navigator.storage.persist);
      this.persisted = await storageSvc.persisted();
      this.estimate = await storageSvc.estimate();
    },
    async requestPersist() {
      this.busy = true;
      this.storageError = null;
      try {
        await storageSvc.requestPersist();
        this.persisted = await storageSvc.persisted();
        if (this.persisted) {
          store.dispatch('notification/info', 'Your files are now protected from automatic removal.');
        } else {
          this.storageError = 'The browser refused to protect the storage. Export a backup to be safe.';
        }
      } catch (e) {
        this.storageError = 'Unable to request a persistent storage.';
      }
      this.busy = false;
      this.estimate = await storageSvc.estimate();
    },
    async exportBackup() {
      this.busy = true;
      this.storageError = null;
      try {
        // Flush the pending store changes so that the backup is up to date
        await localDbSvc.sync();
        const backup = await storageSvc.downloadBackup();
        const workspaces = Object.keys(backup.databases).length;
        const items = Object.values(backup.databases)
          .reduce((count, database) => count + database.itemCount, 0);
        store.dispatch(
          'notification/info',
          `Backup exported: ${workspaces} workspace(s), ${items} item(s).`,
        );
      } catch (err) {
        console.error(err); // eslint-disable-line no-console
        this.storageError = 'Unable to export the backup.';
      }
      this.busy = false;
      this.estimate = await storageSvc.estimate();
    },
    setCustomSettings(value) {
      this.customSettings = value;
      try {
        yaml.safeLoad(this.strippedCustomSettings);
        this.error = null;
      } catch (e) {
        this.error = e.message;
      }
    },
    async resolve() {
      if (this.tab === 'storage') {
        // The Storage tab has nothing to apply, just close the dialog
        this.config.resolve();
        return;
      }
      if (!this.error) {
        const settings = this.strippedCustomSettings;
        await store.dispatch('data/setSettings', settings);
        const customSettings = yaml.safeLoad(settings);
        if (customSettings.shortcuts) {
          badgeSvc.addBadge('changeShortcuts');
        }
        const computedSettings = store.getters['data/computedSettings'];
        const customSettingsCount = Object
          .keys(customSettings)
          .filter(key => key !== 'shortcuts' && computedSettings[key])
          .length;
        if (customSettingsCount) {
          badgeSvc.addBadge('changeSettings');
        }
        this.config.resolve(settings);
      }
    },
  },
};
</script>

<style lang="scss">
@import '../../styles/variables.scss';

.modal__inner-1.modal__inner-1--settings {
  max-width: 560px;
}

.modal__error--settings {
  white-space: pre-wrap;
  font-family: $font-family-monospace;
  font-size: $font-size-monospace;
}

.storage-entry {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.storage-entry__text {
  flex: 1;
  padding: 0.5em 0.75em;
  line-height: 1.4;
}

.storage-entry__state {
  font-weight: bold;
}

.storage-entry__state--protected {
  color: $link-color;
}

.storage-entry__hint {
  font-size: 0.75rem;
  color: #808080;
}
</style>
