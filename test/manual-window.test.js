// The help window (#790): the service that reads the bundled manual, and the
// controller that opens the window and answers its channels — run against
// stand-ins for Electron.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createManualService, manualWebUrl } = require('../src/main/services/manual-service');
const {
  createManualWindowController,
  isManualExternalUrl,
  isManualIpcSender,
  matchManualZoomShortcut,
} = require('../src/main/manual-window');
const { MANUAL_URL, RENDERER_URL, isManualRendererUrl, isTrustedRendererUrl } = require('../src/main/permissions');
const { MANUAL_REQUEST_CHANNELS: REQ, MANUAL_PUSH_CHANNELS: PUSH } = require('../src/shared/manual-channels');

function makeBundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-manual-svc-'));
  const index = {
    locales: {
      en: { nav: [{ slug: 'index', label: 'Overview' }], pages: { index: { title: 'Manual', description: 'All of it', chapter: null } } },
      de: { nav: [{ slug: 'index', label: 'Überblick' }], pages: { index: { title: 'Handbuch', description: 'Alles', chapter: null } } },
    },
  };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  for (const [locale, text] of [['en', 'Hello'], ['de', 'Hallo']]) {
    fs.mkdirSync(path.join(dir, 'pages', locale), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pages', locale, 'index.md'), text);
  }
  fs.mkdirSync(path.join(dir, 'screenshots'));
  fs.writeFileSync(path.join(dir, 'screenshots', 'overview.de.dark.webp'), Buffer.from('webp'));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'not for the help window');
  return dir;
}

test('the service reads pages by slug and screenshots by motif, nothing else', () => {
  const dir = makeBundle();
  try {
    const manual = createManualService({ fs, path, bundleDir: dir });
    assert.equal(manual.isAvailable(), true);
    assert.equal(manual.getIndex('de').nav[0].label, 'Überblick');
    assert.equal(manual.getIndex('fr').locale, 'en', 'an unknown language falls back to English');
    assert.equal(manual.getPage('de', 'index').markdown, 'Hallo');
    assert.equal(manual.getPage('en', 'index').title, 'Manual');
    assert.deepEqual(manual.getAllPages('de').map((page) => page.markdown), ['Hallo']);
    assert.throws(() => manual.getPage('en', '../secret'), /No manual page/);
    assert.throws(() => manual.getPage('en', 'constructor'), /No manual page/);
    assert.equal(manual.getScreenshot('overview', 'de', 'dark'), `data:image/webp;base64,${Buffer.from('webp').toString('base64')}`);
    assert.throws(() => manual.getScreenshot('../secret', 'de', 'dark'), /Invalid screenshot motif/);
    assert.throws(() => manual.getScreenshot('overview', 'en', 'dark'), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a bundle the service says so instead of throwing', () => {
  const manual = createManualService({ fs, path, bundleDir: path.join(os.tmpdir(), 'snotra-no-manual-here') });
  assert.equal(manual.isAvailable(), false);
});

test('web addresses of the manual, English at the root and German under /de/', () => {
  assert.equal(manualWebUrl('en'), 'https://docs.snotra-ai.dev/');
  assert.equal(manualWebUrl('de', 'safety/sandbox'), 'https://docs.snotra-ai.dev/de/safety/sandbox/');
  assert.equal(manualWebUrl('en', 'safety/choose-a-mode', 'steps'), 'https://docs.snotra-ai.dev/safety/choose-a-mode/#steps');
});

test('the help page is not the app page, and the app page is not the help page', () => {
  assert.equal(isManualRendererUrl(MANUAL_URL), true);
  assert.equal(isManualRendererUrl(`${MANUAL_URL}?page=index`), true);
  assert.equal(isManualRendererUrl(RENDERER_URL), false);
  assert.equal(isTrustedRendererUrl(MANUAL_URL), false, 'the app channels must refuse the help window');
  assert.equal(isManualRendererUrl(`${MANUAL_URL}.evil.html`), false);
});

test('only the top frame of the help page may call the manual channels', () => {
  assert.equal(isManualIpcSender({ senderFrame: { url: `${MANUAL_URL}?page=index`, parent: null } }), true);
  assert.equal(isManualIpcSender({ senderFrame: { url: RENDERER_URL, parent: null } }), false);
  assert.equal(isManualIpcSender({ senderFrame: { url: MANUAL_URL, parent: {} } }), false);
  assert.equal(isManualIpcSender({ senderFrame: null }), false);
});

test('links out of the manual: https only', () => {
  assert.equal(isManualExternalUrl('https://github.com/kkrafft1999/snotra'), true);
  assert.equal(isManualExternalUrl('http://example.com'), false);
  assert.equal(isManualExternalUrl('file:///etc/passwd'), false);
  assert.equal(isManualExternalUrl('javascript:alert(1)'), false);
  assert.equal(isManualExternalUrl(42), false);
});

test('Cmd/Ctrl with +, − and 0 zooms the page', () => {
  const key = (k, extra = {}) => ({ type: 'keyDown', key: k, ...extra });
  assert.equal(matchManualZoomShortcut(key('=', { meta: true }), 'darwin'), 'in');
  assert.equal(matchManualZoomShortcut(key('+', { meta: true }), 'darwin'), 'in');
  assert.equal(matchManualZoomShortcut(key('-', { meta: true }), 'darwin'), 'out');
  assert.equal(matchManualZoomShortcut(key('0', { control: true }), 'win32'), 'reset');
  assert.equal(matchManualZoomShortcut(key('0', { control: true }), 'darwin'), null);
  assert.equal(matchManualZoomShortcut(key('-', { meta: true, alt: true }), 'darwin'), null);
  assert.equal(matchManualZoomShortcut(key('-'), 'darwin'), null);
});

function makeController({ available = true } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), on() {} };
  const opened = [];
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.sent = [];
      this.destroyed = false;
      this.focused = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        send: (channel, payload) => this.sent.push([channel, payload]),
        setWindowOpenHandler: (fn) => { this.openHandler = fn; },
      });
      windows.push(this);
    }

    loadFile(file, options) { this.loaded = { file, options }; }
    close() { this.closedByController = true; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() {}
    focus() { this.focused += 1; }
  }
  const manual = {
    isAvailable: () => available,
    getIndex: (locale) => ({ locale }),
    getPage: (locale, slug) => ({ locale, slug }),
    getAllPages: (locale) => [{ locale, slug: 'index' }],
    getScreenshot: () => 'data:',
  };
  const controller = createManualWindowController({
    BrowserWindow: FakeWindow,
    ipcMain,
    shell: { openExternal: async (url) => { opened.push(url); } },
    app: { getVersion: () => '1.19.0' },
    manual,
    getLocale: () => 'de',
    log: { warn() {}, error() {} },
  });
  return { controller, handlers, opened, windows };
}

const fromHelp = { senderFrame: { url: MANUAL_URL, parent: null } };
const fromApp = { senderFrame: { url: RENDERER_URL, parent: null } };

test('the controller opens one window, and a second call turns the page there', () => {
  const { controller, windows } = makeController();
  const first = controller.open();
  assert.equal(windows.length, 1);
  assert.match(first.loaded.file, /src[\\/]renderer[\\/]manual\.html$/);
  assert.deepEqual(first.loaded.options, { query: { page: 'index' } });
  assert.match(first.options.webPreferences.preload, /manual-bundle\.js$/);
  assert.equal(first.options.webPreferences.sandbox, true);
  assert.equal(first.options.webPreferences.contextIsolation, true);

  controller.open({ slug: 'safety/sandbox', fragment: 'steps' });
  assert.equal(windows.length, 1);
  assert.equal(first.focused, 1);
  assert.deepEqual(first.sent, [[PUSH.NAVIGATE, { slug: 'safety/sandbox', fragment: 'steps' }]]);

  assert.equal(controller.isManualWindow(first), true);
  controller.stepHistory('back');
  controller.onLocaleChanged();
  assert.deepEqual(first.sent.slice(1), [[PUSH.HISTORY, 'back'], [PUSH.LOCALE, 'de']]);

  controller.close();
  assert.equal(first.closedByController, true, 'the app window takes the help window along');

  first.destroyed = true;
  first.emit('closed');
  controller.open();
  assert.equal(windows.length, 2, 'a closed window is opened anew');
});

test('without a bundled manual the web version opens instead', () => {
  const { controller, windows, opened } = makeController({ available: false });
  assert.equal(controller.open({ slug: 'safety/sandbox' }), null);
  assert.equal(windows.length, 0);
  assert.deepEqual(opened, ['https://docs.snotra-ai.dev/de/safety/sandbox/']);
});

test('the manual channels answer the help page and refuse the app window', async () => {
  const { handlers, opened } = makeController();
  assert.deepEqual(handlers.get(REQ.CONTEXT)(fromHelp), {
    locale: 'de', version: '1.19.0', webBase: 'https://docs.snotra-ai.dev/',
  });
  assert.deepEqual(await handlers.get(REQ.PAGE)(fromHelp, 'en', 'index'), { locale: 'en', slug: 'index' });
  assert.throws(() => handlers.get(REQ.PAGE)(fromApp, 'en', 'index'), /not the app window/);
  assert.deepEqual(handlers.get(REQ.PAGES)(fromHelp, 'de'), [{ locale: 'de', slug: 'index' }]);
  assert.throws(() => handlers.get(REQ.PAGES)(fromApp, 'de'), /not the app window/);
  assert.equal(await handlers.get(REQ.OPEN_EXTERNAL)(fromHelp, 'https://docs.snotra-ai.dev/'), true);
  assert.equal(await handlers.get(REQ.OPEN_EXTERNAL)(fromHelp, 'file:///etc/passwd'), false);
  assert.deepEqual(opened, ['https://docs.snotra-ai.dev/']);
});

test('the help window navigates nowhere and opens no windows of its own', () => {
  const { controller, opened } = makeController();
  const win = controller.open();
  let prevented = 0;
  win.webContents.emit('will-navigate', { preventDefault: () => { prevented += 1; } }, 'https://evil.example/');
  win.webContents.emit('will-navigate', { preventDefault: () => { prevented += 1; } }, `${MANUAL_URL}?page=index`);
  assert.equal(prevented, 1);
  assert.deepEqual(win.openHandler({ url: 'https://github.com/' }), { action: 'deny' });
  assert.deepEqual(win.openHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://github.com/']);
});

test('history and zoom keys go to the help page, ahead of the menu', () => {
  const { controller } = makeController();
  const win = controller.open();
  const press = (input) => {
    let prevented = false;
    win.webContents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', ...input });
    return prevented;
  };
  const back = process.platform === 'darwin' ? { meta: true, code: 'BracketLeft' } : { alt: true, code: 'ArrowLeft' };
  const zoomIn = process.platform === 'darwin' ? { meta: true, key: '=' } : { control: true, key: '=' };
  assert.equal(press(back), true);
  assert.equal(press(zoomIn), true);
  assert.equal(press({ key: 'a' }), false);
  assert.deepEqual(win.sent, [[PUSH.HISTORY, 'back'], [PUSH.ZOOM, 'in']]);
});
