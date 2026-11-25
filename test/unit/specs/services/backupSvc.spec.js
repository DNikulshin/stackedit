import backupSvc from '../../../../src/services/backupSvc';
import store from '../../../../src/store';
import utils from '../../../../src/services/utils';

const text = '# Imported\n\nHello world.';
// createFile sanitizes the text (adds the trailing newline), and the restored
// selection must be clamped against what the editor will actually hold.
const storedText = utils.sanitizeText(text);

const backup = items => JSON.stringify(items);

const fileItem = (id, name) => ({
  [id]: {
    id,
    type: 'file',
    name,
    parentId: null,
  },
  [`${id}/content`]: {
    id: `${id}/content`,
    type: 'content',
    text,
    properties: null,
    discussions: {},
    comments: {},
  },
});

const importedFile = name => store.getters['file/items'].find(file => file.name === name);

const contentStateOf = (fileId) => {
  const item = store.getters.allItemsById[`${fileId}/contentState`];
  return item && { ...item };
};

describe('backupSvc.importBackup', () => {
  it('restores the cursor position and the scroll offset of an imported file', async () => {
    await backupSvc.importBackup(backup({
      ...fileItem('externalFile', 'Restored file'),
      'externalFile/contentState': {
        id: 'externalFile/contentState',
        type: 'contentState',
        selectionStart: 4,
        selectionEnd: 9,
        scrollPosition: { sectionIdx: 1, posInSection: 0.5 },
      },
    }));

    const file = importedFile('Restored file');
    expect(file).toBeTruthy();
    expect(store.getters.allItemsById[`${file.id}/content`].text).toEqual(storedText);

    const contentState = contentStateOf(file.id);
    expect(contentState.selectionStart).toEqual(4);
    expect(contentState.selectionEnd).toEqual(9);
    expect(contentState.scrollPosition).toEqual({ sectionIdx: 1, posInSection: 0.5 });
  });

  it('clamps a selection that points outside the imported text', async () => {
    await backupSvc.importBackup(backup({
      ...fileItem('externalFile', 'Clamped file'),
      'externalFile/contentState': {
        id: 'externalFile/contentState',
        type: 'contentState',
        selectionStart: -5,
        selectionEnd: 10000,
        scrollPosition: null,
      },
    }));

    const contentState = contentStateOf(importedFile('Clamped file').id);
    expect(contentState.selectionStart).toEqual(0);
    expect(contentState.selectionEnd).toEqual(storedText.length);
    expect(contentState.scrollPosition).toBeNull();
  });

  it('does not create a content state for a file that has none in the backup', async () => {
    await backupSvc.importBackup(backup(fileItem('externalFile', 'Plain file')));

    const file = importedFile('Plain file');
    expect(file).toBeTruthy();
    expect(contentStateOf(file.id)).toBeUndefined();
  });

  it('does not restore the synchronization history', async () => {
    await backupSvc.importBackup(backup({
      ...fileItem('externalFile', 'Synced file'),
      'externalFile/syncedContent': {
        id: 'externalFile/syncedContent',
        type: 'syncedContent',
        historyData: { s1: 'abc' },
        syncHistory: { s1: {} },
        v: 7,
      },
    }));

    const file = importedFile('Synced file');
    expect(store.getters.allItemsById[`${file.id}/syncedContent`]).toBeUndefined();
  });
});
