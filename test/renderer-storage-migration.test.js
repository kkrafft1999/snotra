'use strict';

// The renderer's localStorage moves from file:// to snotra-app:// once per
// profile (#1012). The real move runs in e2e/renderer-origin.test.mjs; here
// the order of things around it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { migrateRendererStorage, MARKER_FILENAME, MIGRATED_KEYS } = require('../src/main/renderer-storage-migration');

async function profile(t, { store = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-move-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (store) await fs.mkdir(path.join(dir, 'Local Storage'));
  return dir;
}

/** A hidden window whose two origins hold `stores[origin]`. */
function fakeWindow(stores, { failOn = null } = {}) {
  const window = {
    destroyed: false,
    loads: [],
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; },
    webContents: {
      current: null,
      hash: '',
      async loadURL(url) {
        if (failOn && url.startsWith(failOn)) throw new Error('ERR_FAILED');
        window.loads.push(url);
        this.current = url.startsWith('file:') ? 'file' : 'app';
        this.hash = new URL(url).hash;
      },
      async executeJavaScript(code) {
        const localStorage = {
          getItem: (key) => stores[this.current][key] ?? null,
          setItem: (key, value) => { stores[this.current][key] = value; },
        };
        return new Function('localStorage', 'location', `return ${code};`)(localStorage, { hash: this.hash });
      },
    },
  };
  return window;
}

test('the appearance and the zoom move over, and what the new origin has wins', async (t) => {
  const dir = await profile(t);
  const stores = { file: { theme: 'dark', 'manual.zoom': '1.2', other: 'x' }, app: { 'manual.zoom': '0.9' } };
  const window = fakeWindow(stores);
  const result = await migrateRendererStorage({ createWindow: () => window, userDataDir: dir, fs });
  assert.deepEqual(result.moved.sort(), ['manual.zoom', 'theme']);
  assert.deepEqual(stores.app, { 'manual.zoom': '0.9', theme: 'dark' }, 'only the known keys, none overwritten');
  assert.equal(window.loads[0], pathToFileURL(path.join(dir, 'storage-carrier.html')).href, 'the file: page lies outside app.asar');
  await assert.rejects(fs.access(path.join(dir, 'storage-carrier.html')), 'and is gone afterwards');
  assert.equal(window.loads[1].split('#')[0], 'snotra-app://app/storage-carrier.html');
  assert.deepEqual(JSON.parse(decodeURIComponent(window.loads[1].split('#')[1])), { theme: 'dark', 'manual.zoom': '1.2' },
    'the values travel in the fragment, not in code');
  assert.equal(window.destroyed, false, 'the window stays until the app window is open');
  result.release();
  assert.equal(window.destroyed, true);
  const marker = JSON.parse(await fs.readFile(path.join(dir, MARKER_FILENAME), 'utf8'));
  assert.equal(marker.origin, 'snotra-app://app');
});

test('the read script asks for every key the move knows', async (t) => {
  const dir = await profile(t);
  const stores = { file: Object.fromEntries(MIGRATED_KEYS.map((key) => [key, `v-${key}`])), app: {} };
  const result = await migrateRendererStorage({ createWindow: () => fakeWindow(stores), userDataDir: dir, fs });
  assert.deepEqual(result.moved, [...MIGRATED_KEYS]);
  assert.deepEqual(stores.app, stores.file);
});

test('a value that looks like code stays a value', async (t) => {
  const dir = await profile(t);
  const tricky = "dark'); globalThis.ran = true; ('";
  const stores = { file: { theme: tricky }, app: {} };
  await migrateRendererStorage({ createWindow: () => fakeWindow(stores), userDataDir: dir, fs });
  assert.equal(stores.app.theme, tricky);
  assert.equal(globalThis.ran, undefined);
});

test('once done, it never runs again', async (t) => {
  const dir = await profile(t);
  await fs.writeFile(path.join(dir, MARKER_FILENAME), '{}');
  const result = await migrateRendererStorage({ createWindow: () => assert.fail('no window'), userDataDir: dir, fs });
  assert.equal(result.skipped, true);
  result.release();
});

test('a profile without a store gets no window, and the marker', async (t) => {
  const dir = await profile(t, { store: false });
  const result = await migrateRendererStorage({ createWindow: () => assert.fail('no window'), userDataDir: dir, fs });
  assert.deepEqual(result.moved, []);
  await fs.access(path.join(dir, MARKER_FILENAME));
});

test('a failed move warns, writes the marker and lets the start go on', async (t) => {
  const dir = await profile(t);
  const warnings = [];
  const window = fakeWindow({ file: {}, app: {} }, { failOn: 'file:' });
  const result = await migrateRendererStorage({
    createWindow: () => window, userDataDir: dir, fs, log: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  assert.deepEqual(result.moved, []);
  assert.match(warnings.join('\n'), /not carried over/);
  await fs.access(path.join(dir, MARKER_FILENAME));
  result.release();
  assert.equal(window.destroyed, true);
});

test('a move that hangs ends at the deadline', async (t) => {
  const dir = await profile(t);
  const window = fakeWindow({ file: {}, app: {} });
  window.webContents.loadURL = () => new Promise(() => {});
  const started = Date.now();
  const result = await migrateRendererStorage({ createWindow: () => window, userDataDir: dir, fs, log: { warn() {} }, deadlineMs: 50 });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(result.moved, []);
  result.release();
});
