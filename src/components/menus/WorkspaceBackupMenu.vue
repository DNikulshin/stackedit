<template>
  <div class="side-bar__panel side-bar__panel--menu">
    <input class="hidden-file" id="import-backup-file-input" type="file" @change="onImportBackup">
    <label class="menu-entry button flex flex--row flex--align-center" for="import-backup-file-input">
      <div class="menu-entry__icon flex flex--column flex--center">
        <icon-content-save></icon-content-save>
      </div>
      <div class="flex flex--column">
        Import workspace backup
      </div>
    </label>    <menu-entry @click.native="exportWorkspace">
      <icon-content-save slot="icon"></icon-content-save>
      Export workspace backup
    </menu-entry>
    <menu-entry @click.native="exportAllWorkspaces">
      <icon-content-save slot="icon"></icon-content-save>
      Export all workspaces backup
    </menu-entry>
  </div>
</template>

<script>
import FileSaver from 'file-saver';
import MenuEntry from './common/MenuEntry';
import store from '../../store';
import backupSvc from '../../services/backupSvc';
import localDbSvc from '../../services/localDbSvc';
import storageSvc from '../../services/storageSvc';

export default {
  components: {
    MenuEntry,
  },
  computed: {
    workspaceId: () => store.getters['workspace/currentWorkspace'].id,
  },
  methods: {
    onImportBackup(evt) {
      const file = evt.target.files && evt.target.files[0];
      // Reset the input so that selecting the same file again triggers a change
      evt.target.value = '';
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = e.target.result;
          if (text.match(/\uFFFD/)) {
            store.dispatch('notification/error', 'File is not readable.');
          } else {
            const backup = storageSvc.parseBackup(text);
            if (backup) {
              // Full backup: pick the workspace to recreate, then import its items
              store.dispatch('modal/open', {
                type: 'restoreBackup',
                databases: backup.databases,
                exportedAt: backup.exportedAt,
                appVersion: backup.appVersion,
              }).catch(() => {});
            } else {
              backupSvc.importBackup(text);
            }
          }
        };
        const blob = file.slice(0, 10000000);
        reader.readAsText(blob);
      }
    },
    exportWorkspace() {
      const allItemsById = {};
      localDbSvc.getWorkspaceItems(this.workspaceId, (item) => {
        allItemsById[item.id] = item;
      }, () => {
        const backup = JSON.stringify(allItemsById);
        const blob = new Blob([backup], {
          type: 'text/plain;charset=utf-8',
        });
        FileSaver.saveAs(blob, 'StackEdit workspace.json');
      });
    },
    async exportAllWorkspaces() {
      try {
        // Flush the pending store changes so that the backup is up to date
        await localDbSvc.sync();
        await storageSvc.downloadBackup();
      } catch (err) {
        console.error(err); // eslint-disable-line no-console
        store.dispatch('notification/error', 'Unable to export the backup.');
      }
    },
  },
};
</script>
