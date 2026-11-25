<template>
  <modal-inner class="modal__inner-1--restore-backup" aria-label="Restore backup">
    <div class="modal__content">
      <div class="modal__title">{{title}}</div>
      <div class="modal__sub-title">{{subTitle}}</div>
      <form-entry label="Workspace to restore" info="into the current workspace">
        <select slot="field" class="textfield" v-model="selectedId">
          <option v-for="database in databases" :key="database.id" :value="database.id">
            {{database.label}}
          </option>
        </select>
      </form-entry>
      <div class="modal__info modal__info--multiline">
        Files, folders and their content are recreated in <b>{{currentWorkspaceName}}</b>.
        File IDs and sync locations are not restored.
      </div>
      <div class="modal__error" v-if="error">{{error}}</div>
    </div>
    <div class="modal__button-bar">
      <button class="button" @click="config.reject()">Cancel</button>
      <button class="button button--resolve" :disabled="busy" @click="restore">Restore</button>
    </div>
  </modal-inner>
</template>

<script>
import { mapGetters } from 'vuex';
import ModalInner from './common/ModalInner';
import FormEntry from './common/FormEntry';
import store from '../../store';
import backupSvc from '../../services/backupSvc';

export default {
  components: {
    ModalInner,
    FormEntry,
  },
  data: () => ({
    selectedId: null,
    busy: false,
    error: null,
  }),
  computed: {
    ...mapGetters('modal', [
      'config',
    ]),
    ...mapGetters('workspace', [
      'currentWorkspace',
    ]),
    databases() {
      const knownWorkspaces = store.getters['data/workspaces'];
      return Object.entries(this.config.databases).map(([id, database]) => {
        const name = database.workspaceName || database.workspaceId || id;
        const missing = knownWorkspaces[database.workspaceId] ? '' : ', not in this browser';
        return {
          id,
          label: `${name} — ${database.itemCount} item(s)${missing}`,
        };
      });
    },
    title() {
      const count = this.databases.length;
      return `Backup of ${count} workspace(s)`;
    },
    subTitle() {
      const { exportedAt, appVersion } = this.config;
      const date = exportedAt ? new Date(exportedAt).toLocaleString() : 'unknown date';
      return `Exported ${date} with StackEdit ${appVersion || 'unknown version'}.`;
    },
    currentWorkspaceName() {
      return this.currentWorkspace.name || this.currentWorkspace.id;
    },
  },
  created() {
    const currentId = this.currentWorkspace.id;
    const match = Object.entries(this.config.databases)
      .find(([, database]) => database.workspaceId === currentId);
    this.selectedId = (match && match[0]) || Object.keys(this.config.databases)[0];
  },
  methods: {
    async restore() {
      const database = this.config.databases[this.selectedId];
      if (!database) {
        this.error = 'Nothing to restore.';
        return;
      }
      this.busy = true;
      this.error = null;
      try {
        // The single workspace importer already knows how to recreate files and folders
        await backupSvc.importBackup(JSON.stringify(database.items));
        const files = Object.values(database.items)
          .filter(item => item.type === 'file')
          .length;
        this.config.resolve(this.selectedId);
        store.dispatch(
          'notification/info',
          `Restored ${files} file(s) into ${this.currentWorkspaceName}.`,
        );
      } catch (err) {
        console.error(err); // eslint-disable-line no-console
        this.error = err.message || 'Unable to restore the backup.';
      }
      this.busy = false;
    },
  },
};
</script>

<style lang="scss">
@import '../../styles/variables.scss';

.modal__inner-1.modal__inner-1--restore-backup {
  max-width: 560px;
}
</style>
