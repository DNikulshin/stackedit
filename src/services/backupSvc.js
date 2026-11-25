import store from '../store';
import workspaceSvc from './workspaceSvc';
import utils from './utils';

export default {
  async importBackup(jsonValue) {
    const fileNameMap = {};
    const folderNameMap = {};
    const parentIdMap = {};
    const textMap = {};
    const propertiesMap = {};
    const discussionsMap = {};
    const commentsMap = {};
    const contentStateMap = {};
    const folderIdMap = {
      trash: 'trash',
    };
    const fileIdMap = {};

    // Parse JSON value
    const parsedValue = JSON.parse(jsonValue);
    Object.entries(parsedValue).forEach(([id, value]) => {
      if (value) {
        const v4Match = id.match(/^file\.([^.]+)\.([^.]+)$/);
        if (v4Match) {
          // StackEdit v4 format
          const [, v4Id, type] = v4Match;
          if (type === 'title') {
            fileNameMap[v4Id] = value;
          } else if (type === 'content') {
            textMap[v4Id] = value;
          }
        } else if (value.type === 'folder') {
          // StackEdit v5 folder
          folderIdMap[id] = utils.uid();
          folderNameMap[id] = value.name;
          parentIdMap[id] = `${value.parentId || ''}`;
        } else if (value.type === 'file') {
          // StackEdit v5 file
          fileNameMap[id] = value.name;
          parentIdMap[id] = `${value.parentId || ''}`;
        } else if (value.type === 'content') {
          // StackEdit v5 content
          const [fileId] = id.split('/');
          if (fileId) {
            textMap[fileId] = value.text;
            propertiesMap[fileId] = value.properties;
            discussionsMap[fileId] = value.discussions;
            commentsMap[fileId] = value.comments;
          }
        } else if (value.type === 'contentState') {
          // Cursor position and scroll offset of a file (id is `${fileId}/contentState`).
          // syncedContent is deliberately not restored: it carries the merge history of a
          // synced location, and the location itself is not restored (see the modal note).
          const [fileId] = id.split('/');
          if (fileId) {
            contentStateMap[fileId] = value;
          }
        }
      }
    });

    await utils.awaitSequence(
      Object.keys(folderNameMap),
      async externalId => workspaceSvc.setOrPatchItem({
        id: folderIdMap[externalId],
        type: 'folder',
        name: folderNameMap[externalId],
        parentId: folderIdMap[parentIdMap[externalId]],
      }),
    );

    await utils.awaitSequence(
      Object.keys(fileNameMap),
      async (externalId) => {
        const file = await workspaceSvc.createFile({
          name: fileNameMap[externalId],
          parentId: folderIdMap[parentIdMap[externalId]],
          text: textMap[externalId],
          properties: propertiesMap[externalId],
          discussions: discussionsMap[externalId],
          comments: commentsMap[externalId],
        }, true);
        if (file) {
          fileIdMap[externalId] = file.id;
        }
      },
    );

    // Restore the cursor position and the scroll offset of the imported files.
    // Committed straight to the store: contentState is not an explorer item, so it has no
    // path, and workspaceSvc.setOrPatchItem would call makePathUnique on it (itemsByPath has
    // no entry for that id). The selection is clamped to the imported text, so a backup
    // that refers to a different revision cannot point outside the document.
    Object.keys(contentStateMap)
      .filter(externalId => fileIdMap[externalId])
      .forEach((externalId) => {
        const { selectionStart, selectionEnd, scrollPosition } = contentStateMap[externalId];
        const content = store.getters.allItemsById[`${fileIdMap[externalId]}/content`];
        const maxOffset = content ? content.text.length : 0;
        const clamp = offset => Math.min(Math.max(offset || 0, 0), maxOffset);
        store.commit('contentState/setItem', {
          id: `${fileIdMap[externalId]}/contentState`,
          type: 'contentState',
          selectionStart: clamp(selectionStart),
          selectionEnd: clamp(selectionEnd),
          scrollPosition: scrollPosition || null,
        });
      });
  },
};
