const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFileContextMenu, LAUNCHABLE_EXTENSIONS } = require('../src/main/services/file-context-menu');

// CR-B17-08 (#649): "Open" on a program or script asks first, a failed Open
// says so, and Delete cannot take the main process down.

const OPEN = 0;
const CANCEL = 1;

/**
 * A stand-in file system: every path is a regular file with `mode`, unless it
 * is listed in `folders`; `links` maps a path to the real path it resolves to.
 */
function fakeFs({ mode = 0o644, folders = [], links = {} } = {}) {
  const folderSet = new Set(folders);
  return {
    realpath: async (p) => links[p] ?? p,
    stat: async (p) => ({
      isFile: () => !folderSet.has(p),
      isDirectory: () => folderSet.has(p),
      mode: folderSet.has(p) ? 0o40755 : 0o100000 | mode,
    }),
  };
}

function createMenu({ platform, response = CANCEL, openFailure = '', fsOptions, env = {}, locale, withDialog = true }) {
  const calls = { openPath: [], dialogs: [], warnings: [] };
  const menu = createFileContextMenu({
    Menu: { buildFromTemplate: (template) => ({ template, popup() {} }) },
    shell: {
      openPath: async (p) => {
        calls.openPath.push(p);
        return openFailure;
      },
      showItemInFolder() {},
      trashItem: async () => {},
    },
    dialog: withDialog
      ? {
        showMessageBox: async (...args) => {
          calls.dialogs.push(args[args.length - 1]);
          return { response };
        },
      }
      : null,
    platform,
    fs: fakeFs(fsOptions),
    env,
    logger: { warn: (...args) => calls.warnings.push(args.join(' ')) },
    getLocale: () => locale,
  });
  return { menu, calls };
}

const openItem = (menu, filePath) => menu.buildTemplate(filePath).find((item) => item.label === 'Open');

for (const [platform, extensions] of Object.entries(LAUNCHABLE_EXTENSIONS)) {
  test(`${platform}: "Open" on every listed program type asks first and opens only after "Open" (#649)`, async () => {
    for (const ext of extensions) {
      const filePath = `/ws/tool${ext}`;
      const fsOptions = ext === '.app' ? { folders: [filePath] } : {};

      const cancelled = createMenu({ platform, response: CANCEL, fsOptions });
      await openItem(cancelled.menu, filePath).click();
      assert.deepEqual(cancelled.calls.openPath, [], `${ext} ran without asking`);
      const box = cancelled.calls.dialogs[0];
      assert.ok(box, `${ext} gave no warning`);
      assert.equal(box.type, 'warning');
      assert.deepEqual(box.buttons, ['Open', 'Cancel']);
      assert.equal(box.defaultId, CANCEL, 'Enter must not run it');
      assert.equal(box.cancelId, CANCEL, 'Escape must not run it');
      assert.equal(box.noLink, true);
      assert.match(box.message, new RegExp(`Open the program “tool\\${ext}”\\?`));
      assert.match(box.detail, /runs it with your user rights, outside Snotra’s sandbox/);

      const confirmed = createMenu({ platform, response: OPEN, fsOptions });
      await openItem(confirmed.menu, filePath).click();
      assert.deepEqual(confirmed.calls.openPath, [filePath], `${ext} did not open after "Open"`);
    }
  });

  test(`${platform}: an ordinary document opens directly, without a question (#649)`, async () => {
    for (const name of ['report.pdf', 'notes.md', 'photo.jpeg', 'data.csv', 'README']) {
      const { menu, calls } = createMenu({ platform, response: CANCEL });
      const result = await menu.buildTemplate(`/ws/${name}`)[0].click();
      assert.deepEqual(result, { opened: true }, name);
      assert.deepEqual(calls.dialogs, [], `${name} must not ask`);
      assert.deepEqual(calls.openPath, [`/ws/${name}`]);
    }
  });
}

test('the extension is compared case-insensitively (#649)', async () => {
  for (const [platform, filePath] of [['win32', 'C:\\ws\\SETUP.BAT'], ['darwin', '/ws/Run.COMMAND'], ['linux', '/ws/x.AppImage']]) {
    const { menu, calls } = createMenu({ platform });
    await openItem(menu, filePath).click();
    assert.equal(calls.dialogs.length, 1, filePath);
    assert.deepEqual(calls.openPath, []);
  }
});

test('Windows: trailing dots and spaces do not hide the type, and PATHEXT counts (#649)', async () => {
  for (const filePath of ['C:\\ws\\setup.bat.', 'C:\\ws\\setup.cmd ', 'C:\\ws\\tool.foo']) {
    const { menu, calls } = createMenu({ platform: 'win32', env: { PATHEXT: '.COM;.EXE;.FOO' } });
    await openItem(menu, filePath).click();
    assert.equal(calls.dialogs.length, 1, filePath);
    assert.deepEqual(calls.openPath, []);
  }
});

test('macOS and Linux: a regular file with an execute bit asks; on Windows the bit means nothing (#649)', async () => {
  for (const platform of ['darwin', 'linux']) {
    for (const mode of [0o755, 0o744, 0o701]) {
      const { menu, calls } = createMenu({ platform, fsOptions: { mode } });
      await openItem(menu, '/ws/build').click();
      assert.equal(calls.dialogs.length, 1, `${platform} ${mode.toString(8)}`);
      assert.deepEqual(calls.openPath, []);
    }
  }
  const windows = createMenu({ platform: 'win32', fsOptions: { mode: 0o777 } });
  await openItem(windows.menu, 'C:\\ws\\notes.txt').click();
  assert.deepEqual(windows.calls.dialogs, []);
  assert.deepEqual(windows.calls.openPath, ['C:\\ws\\notes.txt']);
});

test('a link counts as what it points to: a link to an .app bundle asks (#649)', async () => {
  const { menu, calls } = createMenu({
    platform: 'darwin',
    fsOptions: { folders: ['/ws/bundles/Tool.app'], links: { '/ws/notes': '/ws/bundles/Tool.app' } },
  });
  await openItem(menu, '/ws/notes').click();
  assert.equal(calls.dialogs.length, 1);
  assert.match(calls.dialogs[0].message, /“notes”/);
  assert.deepEqual(calls.openPath, []);
});

test('without a dialog a program is not run unasked (#649)', async () => {
  const { menu, calls } = createMenu({ platform: 'win32', withDialog: false });
  const result = await openItem(menu, 'C:\\ws\\setup.bat').click();
  assert.match(result.error, /dialog/i);
  assert.deepEqual(calls.openPath, []);
});

test('the warning speaks German with du (#649)', async () => {
  const { menu, calls } = createMenu({ platform: 'darwin', locale: 'de' });
  await menu.buildTemplate('/ws/start.command')[0].click();
  const box = calls.dialogs[0];
  assert.deepEqual(box.buttons, ['Öffnen', 'Abbrechen']);
  assert.match(box.message, /Das Programm „start\.command“ öffnen\?/);
  assert.match(box.detail, /mit deinen Benutzerrechten aus, außerhalb der Sandbox von Snotra/);
});

test('a failed Open shows an error box, in English and in German (#649)', async () => {
  for (const [locale, title] of [['en', /“scan\.xyz” could not be opened/], ['de', /„scan\.xyz“ konnte nicht geöffnet werden/]]) {
    const { menu, calls } = createMenu({ platform: 'darwin', openFailure: 'No application knows how to open it.', locale });
    const result = await menu.buildTemplate('/ws/scan.xyz')[0].click();
    assert.deepEqual(result, { error: 'No application knows how to open it.' });
    assert.equal(calls.dialogs.length, 1);
    assert.equal(calls.dialogs[0].type, 'error');
    assert.match(calls.dialogs[0].message, title);
    assert.match(calls.dialogs[0].detail, /\/ws\/scan\.xyz\n\nNo application knows how to open it\./);
    assert.equal(calls.warnings.length, 1, 'and it is still logged');
  }
});

test('Delete is guarded like Information: a dialog that throws does not reject the click (#649)', async () => {
  const warnings = [];
  const deleted = [];
  const menu = createFileContextMenu({
    Menu: { buildFromTemplate: (template) => ({ template, popup() {} }) },
    shell: { openPath: async () => '', showItemInFolder() {}, trashItem: async () => {} },
    // The window closes while the confirmation is up.
    dialog: { showMessageBox: async () => { throw new Error('Object has been destroyed'); } },
    platform: 'darwin',
    fs: fakeFs(),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  const template = menu.buildTemplate('/ws/a.txt', { onDeleted: (p) => deleted.push(p) });
  const deleteItem = template.find((item) => item.label === 'Delete…');
  const open = openItem(menu, '/ws/tool.command');

  await assert.doesNotReject(deleteItem.click());
  await assert.doesNotReject(open.click());
  assert.deepEqual(deleted, []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /could not be deleted: Object has been destroyed/);
  assert.match(warnings[1], /could not be opened: Object has been destroyed/);
});

test('with the real file system: an executable script asks, a plain text file does not (#649)', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-open-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'build');
  const text = path.join(dir, 'notes.txt');
  await fs.writeFile(script, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  await fs.writeFile(text, 'hi', { mode: 0o644 });
  const calls = { openPath: [], dialogs: [] };
  const menu = createFileContextMenu({
    Menu: { buildFromTemplate: (template) => ({ template, popup() {} }) },
    shell: { openPath: async (p) => { calls.openPath.push(p); return ''; }, showItemInFolder() {} },
    dialog: { showMessageBox: async (options) => { calls.dialogs.push(options); return { response: CANCEL }; } },
    platform: process.platform,
  });

  await menu.buildTemplate(script)[0].click();
  await menu.buildTemplate(text)[0].click();

  assert.equal(calls.dialogs.length, 1);
  assert.match(calls.dialogs[0].message, /“build”/);
  assert.deepEqual(calls.openPath, [text]);
});

test('a document with an execute bit opens by its type and does not ask (#649)', async () => {
  // exFAT, NTFS and SMB mounts and many zips give every file 0777.
  for (const platform of ['darwin', 'linux']) {
    const { menu, calls } = createMenu({ platform, fsOptions: { mode: 0o777 } });
    await openItem(menu, '/mnt/stick/report.pdf').click();
    assert.deepEqual(calls.dialogs, [], platform);
    assert.deepEqual(calls.openPath, ['/mnt/stick/report.pdf'], platform);
  }
});

test('Python scripts ask on every platform; Perl and Ruby on Windows (#649)', async () => {
  const cases = [
    ['win32', 'C:\\ws\\tool.py'], ['win32', 'C:\\ws\\tool.pyw'], ['win32', 'C:\\ws\\app.pyz'],
    ['win32', 'C:\\ws\\x.pl'], ['win32', 'C:\\ws\\x.rb'],
    ['darwin', '/ws/tool.py'], ['darwin', '/ws/tool.pyw'], ['linux', '/ws/tool.py'],
  ];
  for (const [platform, filePath] of cases) {
    const { menu, calls } = createMenu({ platform });
    await openItem(menu, filePath).click();
    assert.equal(calls.dialogs.length, 1, `${platform} ${filePath}`);
    assert.deepEqual(calls.openPath, [], `${platform} ${filePath}`);
  }
});
