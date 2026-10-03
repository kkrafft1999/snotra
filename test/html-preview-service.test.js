// The main side of the HTML view (#479): what a page may load, where its
// links lead, and how its view is kept — against fakes of Electron's session,
// WebContentsView and the file system. Whether Chromium really runs the page
// in isolation is the smoke test's part (`e2e/smoke.test.mjs`).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createHtmlPreviewService,
  HTML_PREVIEW_SCHEME_PRIVILEGES,
  previewUrl,
  parsePreviewUrl,
} = require('../src/main/services/html-preview-service');
const {
  HTML_PREVIEW_PARTITION,
  MAX_HTML_PREVIEW_BYTES,
} = require('../src/shared/contracts/html-preview');

const ROOT = '/ws';
const PAGE = '/ws/site/index.html';
const BLOCKED_PUSH_WAIT_MS = 130;

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeEnvironment({ files = {}, zoom = 1, root = ROOT } = {}) {
  const pushed = [];
  const external = [];
  const openedPaths = [];
  const views = [];
  let clock = 10_000;
  let hostCount = 0;
  let nextContentsId = 100;

  const ses = {
    handlers: {},
    protocol: { handle(scheme, fn) { ses.scheme = scheme; ses.serve = fn; } },
    webRequest: { onBeforeRequest(fn) { ses.beforeRequest = fn; } },
    setPermissionRequestHandler(fn) { ses.permissionRequest = fn; },
    setPermissionCheckHandler(fn) { ses.permissionCheck = fn; },
    setDevicePermissionHandler(fn) { ses.deviceCheck = fn; },
    on(event, fn) { ses.handlers[event] = fn; },
    setSpellCheckerEnabled(value) { ses.spellChecker = value; },
    setProxy(config) { ses.proxy = config; return Promise.resolve(); },
  };
  const session = {
    fromPartition(name) {
      session.partition = name;
      return ses;
    },
  };

  class FakeContents extends EventEmitter {
    constructor() {
      super();
      this.id = nextContentsId++;
      this.loaded = [];
      this.closed = false;
      this.crashed = 0;
      this.focused = 0;
      this.scroll = [0, 0];
      this.stuck = false;
      this.isolated = [];
    }
    loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    setWebRTCIPHandlingPolicy(policy) { this.webrtc = policy; }
    executeJavaScriptInIsolatedWorld(worldId, scripts) {
      this.isolated.push({ worldId, code: scripts[0].code });
      return this.stuck ? new Promise(() => {}) : Promise.resolve(this.scroll);
    }
    forcefullyCrashRenderer() { this.crashed += 1; }
    focus() { this.focused += 1; }
    close() { this.closed = true; }
    isDestroyed() { return this.closed; }
  }

  class FakeView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeContents();
      this.bounds = null;
      this.visible = null;
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
    setBackgroundColor(color) { this.background = color; }
  }

  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.webContents.getZoomFactor = () => zoom;
  win.webContents.focus = () => { win.focused = (win.focused ?? 0) + 1; };
  win.isDestroyed = () => false;
  win.contentView = {
    children: [],
    addChildView(view) { this.children.push(view); },
    removeChildView(view) { this.children = this.children.filter((child) => child !== view); },
  };

  const inside = (absPath) => absPath.startsWith(`${root}/`);
  const service = createHtmlPreviewService({
    session,
    WebContentsView: FakeView,
    shell: {
      openExternal: async (url) => { external.push(url); },
      openPath: async (absPath) => { openedPaths.push(absPath); return ''; },
    },
    getMainWindow: () => win,
    getWorkspaceRoot: () => root,
    readWorkspaceFile: async (workspaceRoot, absPath, maxBytes) => {
      if (!inside(absPath)) return { reason: 'outside-workspace' };
      const file = files[absPath];
      if (!file) return { reason: 'not-found' };
      if (file.outside) return { reason: 'outside-workspace' };
      const buffer = Buffer.from(file.content);
      if (buffer.length > maxBytes) return { reason: 'too-large', size: buffer.length };
      return { buffer, stats: { size: buffer.length, mtimeMs: file.mtimeMs ?? 1 } };
    },
    resolveCheckedWorkspacePath: async (absPath) => (inside(absPath) ? { absPath } : { error: 'outside' }),
    stat: async (absPath) => {
      const file = files[absPath];
      if (!file) throw new Error('ENOENT');
      return { size: Buffer.byteLength(file.content), mtimeMs: file.mtimeMs ?? 1, isFile: () => true };
    },
    push: (payload) => pushed.push(payload),
    platform: 'darwin',
    now: () => clock,
    newHost: () => (++hostCount).toString(16).padStart(32, '0'),
    log: { warn() {}, error() {} },
  });

  return {
    service,
    files,
    pushed,
    external,
    openedPaths,
    views,
    ses,
    session,
    win,
    tick(ms) { clock += ms; },
    request(url, method = 'GET') { return ses.serve({ url, method }); },
    gesture(view, type = 'mouseUp') { view.webContents.emit('input-event', {}, { type }); },
    events(type) { return pushed.filter((event) => event.type === type); },
  };
}

function siteFiles() {
  return {
    [PAGE]: { content: '<!doctype html><link rel="stylesheet" href="style.css"><p>Hi</p>' },
    '/ws/site/style.css': { content: 'p { color: red }' },
    '/ws/site/other.html': { content: '<p>Other</p>' },
  };
}

async function openedPage(options = {}) {
  const env = fakeEnvironment({ files: siteFiles(), ...options });
  const result = await env.service.open(PAGE);
  assert.equal(result.ok, true);
  return { env, result, view: env.views[0], contents: env.views[0].webContents };
}

// ── Scheme and URLs ────────────────────────────────────────────────────────

test('the scheme is standard and secure, but bypasses no CSP and has no service workers', () => {
  assert.equal(HTML_PREVIEW_SCHEME_PRIVILEGES.scheme, 'snotra-html');
  const { privileges } = HTML_PREVIEW_SCHEME_PRIVILEGES;
  assert.equal(privileges.standard, true);
  assert.equal(privileges.secure, true);
  assert.equal(privileges.bypassCSP, undefined);
  assert.equal(privileges.allowServiceWorkers, undefined);
});

test('a URL carries the absolute path, and comes back to it', () => {
  const url = previewUrl('abc', '/Users/me/my site/index.html', 'darwin');
  assert.equal(url, 'snotra-html://abc/Users/me/my%20site/index.html');
  assert.deepEqual(parsePreviewUrl(url, 'darwin'), { host: 'abc', absPath: '/Users/me/my site/index.html', fragment: '' });

  const win = previewUrl('abc', 'C:\\Users\\me\\index.html', 'win32');
  assert.equal(win, 'snotra-html://abc/C%3A/Users/me/index.html');
  assert.equal(parsePreviewUrl(`${win}#part`, 'win32').absPath, 'C:\\Users\\me\\index.html');
  assert.equal(parsePreviewUrl(`${win}#part`, 'win32').fragment, 'part');
  // A UNC share has no place in the scheme.
  assert.equal(previewUrl('abc', '\\\\server\\share\\x.html', 'win32'), null);
});

test('climbing out resolves to a path outside, never one clamped to the folder', () => {
  const page = previewUrl('abc', '/ws/site/index.html', 'darwin');
  const climbed = new URL('../../../etc/passwd', page).href;
  assert.equal(parsePreviewUrl(climbed, 'darwin').absPath, '/etc/passwd');
  // An encoded separator cannot smuggle a path segment in.
  assert.equal(parsePreviewUrl('snotra-html://abc/ws/a%2F..%2F..%2Fetc', 'darwin').absPath, null);
  assert.equal(parsePreviewUrl('https://abc/ws/x.html', 'darwin'), null);
});

// ── Opening a page ─────────────────────────────────────────────────────────

test('without an open folder, outside of it, missing or too large, no view is made', async () => {
  const big = 'x'.repeat(MAX_HTML_PREVIEW_BYTES + 1);
  const env = fakeEnvironment({ files: { '/ws/big.html': { content: big } } });
  assert.deepEqual(await env.service.open('/elsewhere/x.html'), { ok: false, reason: 'outside-workspace' });
  assert.deepEqual(await env.service.open('/ws/none.html'), { ok: false, reason: 'not-found' });
  assert.deepEqual(await env.service.open('/ws/big.html'), { ok: false, reason: 'too-large', size: big.length });
  assert.deepEqual(await env.service.open('/ws/notes.txt'), { ok: false, reason: 'not-found' });
  assert.equal(env.views.length, 0);

  const noFolder = fakeEnvironment({ root: '' });
  assert.deepEqual(await noFolder.service.open(PAGE), { ok: false, reason: 'no-workspace' });
});

test('a page gets a view of its own: own session, no preload, sandboxed, no Node', async () => {
  const { env, result, view, contents } = await openedPage();
  assert.equal(result.id, '1'.padStart(32, '0'));
  assert.equal(result.size, Buffer.byteLength(siteFiles()[PAGE].content));
  assert.equal(env.session.partition, HTML_PREVIEW_PARTITION);
  assert.ok(!HTML_PREVIEW_PARTITION.startsWith('persist:'), 'kept in memory only');

  const prefs = view.options.webPreferences;
  assert.equal(prefs.session, env.ses);
  assert.equal(prefs.preload, undefined);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.disableDialogs, true);
  assert.equal(prefs.devTools, false);
  assert.equal(contents.webrtc, 'disable_non_proxied_udp');

  // Laid over the window, hidden until the renderer says where.
  assert.deepEqual(env.win.contentView.children, [view]);
  assert.equal(view.visible, false);
  assert.deepEqual(contents.loaded, ['snotra-html://00000000000000000000000000000001/ws/site/index.html']);
});

test('the session refuses every permission, every download, and goes through a proxy that leads nowhere', async () => {
  const { env } = await openedPage();
  let granted = null;
  env.ses.permissionRequest(null, 'media', (answer) => { granted = answer; });
  assert.equal(granted, false);
  assert.equal(env.ses.permissionCheck(null, 'clipboard-read'), false);
  assert.equal(env.ses.deviceCheck({}), false);
  assert.equal(env.ses.spellChecker, false);
  assert.equal(env.ses.proxy.mode, 'fixed_servers');
  assert.match(env.ses.proxy.proxyRules, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('a fragment from the link goes along with the first load', async () => {
  const env = fakeEnvironment({ files: siteFiles() });
  await env.service.open(PAGE, { fragment: 'teil 2' });
  assert.match(env.views[0].webContents.loaded[0], /index\.html#teil%202$/);
});

// ── What the page gets ─────────────────────────────────────────────────────

test('the page and its files come with their type, never sniffed, never cached', async () => {
  const { env, result } = await openedPage();
  const base = `snotra-html://${result.id}/ws/site/`;
  const page = await env.request(`${base}index.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const css = await env.request(`${base}style.css`);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(await css.text(), 'p { color: red }');
  assert.equal((await env.request(`${base}style.css`, 'POST')).status, 405);
});

test('outside, missing and too large are refused and listed', async () => {
  const files = { ...siteFiles(), '/ws/site/huge.png': { content: 'x'.repeat(10 * 1024 * 1024 + 1) }, '/ws/site/link.css': { content: '', outside: true } };
  const env = fakeEnvironment({ files });
  const { id } = await env.service.open(PAGE);
  const base = `snotra-html://${id}/ws/site/`;
  assert.equal((await env.request(new URL('../../../etc/passwd', base).href)).status, 403);
  assert.equal((await env.request(`${base}link.css`)).status, 403);
  assert.equal((await env.request(`${base}gone.js`)).status, 404);
  assert.equal((await env.request(`${base}huge.png`)).status, 413);
  // Another page's host gets nothing.
  assert.equal((await env.request('snotra-html://ffff/ws/site/index.html')).status, 404);
  await settle(BLOCKED_PUSH_WAIT_MS);
  const [last] = env.events('blocked').slice(-1);
  assert.deepEqual(last.entries, [
    { url: '/etc/passwd', reason: 'outside-workspace' },
    { url: 'site/link.css', reason: 'outside-workspace' },
    { url: 'site/gone.js', reason: 'not-found' },
    { url: 'site/huge.png', reason: 'too-large' },
  ]);
  assert.equal(last.total, 4);
});

test('nothing leaves the machine: the network is cancelled and listed, local schemes pass', async () => {
  const { env, result, contents } = await openedPage();
  const answer = (url) => {
    let response;
    env.ses.beforeRequest({ url, webContentsId: contents.id }, (value) => { response = value; });
    return response;
  };
  assert.deepEqual(answer('https://cdn.example.com/lib.js'), { cancel: true });
  assert.deepEqual(answer('wss://socket.example.com/'), { cancel: true });
  assert.deepEqual(answer('http://localhost:8080/api'), { cancel: true });
  assert.deepEqual(answer('file:///etc/passwd'), { cancel: true });
  assert.deepEqual(answer(`snotra-html://${result.id}/ws/site/style.css`), {});
  assert.deepEqual(answer('data:text/plain,hi'), {});
  assert.deepEqual(answer('blob:snotra-html://x/1'), {});
  // The same request twice is listed once.
  answer('https://cdn.example.com/lib.js');
  await settle(BLOCKED_PUSH_WAIT_MS);
  const [last] = env.events('blocked').slice(-1);
  assert.deepEqual(last.entries.map((entry) => entry.reason), ['network', 'network', 'network', 'outside-workspace']);
  assert.equal(last.total, 4);
});

test('a download is refused and listed', async () => {
  const { env, contents } = await openedPage();
  let prevented = false;
  env.ses.handlers['will-download']({ preventDefault() { prevented = true; } }, { getURL: () => 'blob:x' }, contents);
  assert.equal(prevented, true);
  await settle(BLOCKED_PUSH_WAIT_MS);
  assert.deepEqual(env.events('blocked').slice(-1)[0].entries, [{ url: 'blob:x', reason: 'download' }]);
});

test('a new document starts with an empty list', async () => {
  const { env, contents } = await openedPage();
  env.ses.beforeRequest({ url: 'https://a.example/', webContentsId: contents.id }, () => {});
  await settle(BLOCKED_PUSH_WAIT_MS);
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(env.events('blocked').slice(-1)[0], { id: env.service.openPages[0], type: 'blocked', entries: [], total: 0 });
});

// ── Where the page may go ──────────────────────────────────────────────────

test('popups are always denied; a click opens the web in the browser and a local file in the preview', async () => {
  const { env, result, contents } = await openedPage();
  env.gesture(env.views[0]);
  assert.deepEqual(contents.openHandler({ url: 'https://example.com/docs' }), { action: 'deny' });
  await settle();
  assert.deepEqual(env.external, ['https://example.com/docs']);

  env.gesture(env.views[0], 'rawKeyDown');
  assert.deepEqual(contents.openHandler({ url: `snotra-html://${result.id}/ws/site/other.html#top` }), { action: 'deny' });
  assert.deepEqual(env.events('open-file'), [{ id: result.id, type: 'open-file', path: '/ws/site/other.html', fragment: 'top' }]);
});

test('without a click nothing leads out, and the attempt is listed', async () => {
  const { env, result, contents } = await openedPage();
  contents.openHandler({ url: 'https://evil.example/?data=secret' });
  // A click long ago does not count.
  env.gesture(env.views[0]);
  env.tick(5000);
  const details = { url: `snotra-html://${result.id}/ws/site/other.html`, isMainFrame: true, preventDefault() { this.prevented = true; } };
  contents.emit('will-frame-navigate', details);
  assert.equal(details.prevented, true);
  await settle(BLOCKED_PUSH_WAIT_MS);
  assert.deepEqual(env.external, []);
  assert.deepEqual(env.events('open-file'), []);
  assert.deepEqual(env.events('blocked').slice(-1)[0].entries, [
    { url: 'https://evil.example/?data=secret', reason: 'navigation' },
    { url: 'site/other.html', reason: 'navigation' },
  ]);
});

test('one click opens one thing', async () => {
  const { env, contents } = await openedPage();
  env.gesture(env.views[0]);
  contents.openHandler({ url: 'https://one.example/' });
  contents.openHandler({ url: 'https://two.example/' });
  await settle();
  assert.deepEqual(env.external, ['https://one.example/']);
});

test('the page may reload itself and fill its frames locally, nothing else', async () => {
  const { env, result, contents } = await openedPage();
  const navigate = (url, isMainFrame) => {
    const details = { url, isMainFrame, preventDefault() { this.prevented = true; } };
    contents.emit('will-frame-navigate', details);
    return details.prevented === true;
  };
  assert.equal(navigate(`snotra-html://${result.id}/ws/site/index.html`, true), false, 'a reload of itself');
  assert.equal(navigate(`snotra-html://${result.id}/ws/site/other.html`, false), false, 'a local frame');
  assert.equal(navigate('about:blank', false), false);
  assert.equal(navigate('https://frame.example/', false), true);
  assert.equal(navigate('snotra-html://other-host/ws/site/other.html', false), true);
});

test('F6 hands the keyboard back to the app, Tab stays with the page', async () => {
  const { env, result, contents } = await openedPage();
  const press = (input) => {
    let prevented = false;
    contents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', ...input });
    return prevented;
  };
  assert.equal(press({ key: 'Tab' }), false);
  assert.equal(press({ key: 'F6', control: true }), false);
  assert.equal(press({ key: 'F6', shift: true }), true);
  assert.equal(env.win.focused, 1);
  assert.deepEqual(env.events('focus-leave'), [{ id: result.id, type: 'focus-leave', reverse: true }]);
});

// ── The view ───────────────────────────────────────────────────────────────

test('bounds come in CSS pixels and go out in window coordinates; nothing sane hides the view', async () => {
  const { env, result, view } = await openedPage({ zoom: 1.25 });
  assert.deepEqual(env.service.setBounds(result.id, { x: 100, y: 40, width: 400, height: 300 }), { ok: true, visible: true });
  assert.deepEqual(view.bounds, { x: 125, y: 50, width: 500, height: 375 });
  assert.equal(view.visible, true);
  assert.deepEqual(env.service.setBounds(result.id, null), { ok: true, visible: false });
  assert.equal(view.visible, false);
  env.service.setBounds(result.id, { x: 1, y: 1, width: Number.NaN, height: 10 });
  assert.equal(view.visible, false);
  assert.deepEqual(env.service.setBounds('nope', { x: 0, y: 0, width: 1, height: 1 }), { ok: false });
});

test('a reload keeps the scroll position; a page that does not answer gets a fresh process', async () => {
  const { env, result, contents } = await openedPage();
  contents.scroll = [0, 480];
  await env.service.reload(result.id);
  assert.equal(contents.loaded.length, 2);
  contents.emit('did-finish-load');
  assert.equal(contents.isolated.at(-1).code, 'window.scrollTo(0, 480)');
  assert.notEqual(contents.isolated.at(-1).worldId, 0, 'not in the page\'s own world');

  contents.stuck = true;
  await env.service.reload(result.id);
  assert.equal(contents.crashed, 1);
  assert.equal(contents.loaded.length, 3);
  // The process it ended on purpose is no news.
  contents.emit('render-process-gone', {}, { reason: 'killed' });
  assert.deepEqual(env.events('gone'), []);
  contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.deepEqual(env.events('gone'), [{ id: result.id, type: 'gone', reason: 'crashed' }]);
});

test('a check reloads only when the page, a file it loaded or a file it missed changed', async () => {
  const { env, result, contents } = await openedPage();
  const base = `snotra-html://${result.id}/ws/site/`;
  await env.request(`${base}index.html`);
  await env.request(`${base}style.css`);
  await env.request(`${base}later.js`);

  assert.deepEqual(await env.service.check(result.id), {
    ok: true, reloaded: false, size: Buffer.byteLength(env.files[PAGE].content), mtimeMs: 1,
  });
  assert.equal(contents.loaded.length, 1);

  env.files['/ws/site/style.css'] = { content: 'p { color: blue }', mtimeMs: 2 };
  assert.equal((await env.service.check(result.id)).reloaded, true);
  assert.equal(contents.loaded.length, 2);

  await env.request(`${base}index.html`);
  await env.request(`${base}style.css`);
  await env.request(`${base}later.js`);
  env.files['/ws/site/later.js'] = { content: 'console.log(1)' };
  assert.equal((await env.service.check(result.id)).reloaded, true);

  delete env.files[PAGE];
  assert.deepEqual(await env.service.check(result.id), { ok: false, reason: 'not-found' });
  env.files[PAGE] = { content: 'x'.repeat(MAX_HTML_PREVIEW_BYTES + 1) };
  assert.equal((await env.service.check(result.id)).reason, 'too-large');
});

test('closing takes the view off the window and ends the page', async () => {
  const { env, result, view, contents } = await openedPage();
  assert.deepEqual(env.service.close(result.id), { ok: true });
  assert.deepEqual(env.win.contentView.children, []);
  assert.equal(contents.closed, true);
  assert.deepEqual(env.service.openPages, []);
  // A late request of the closed page gets nothing.
  assert.equal((await env.request(`snotra-html://${result.id}/ws/site/index.html`)).status, 404);
  assert.deepEqual(env.service.setBounds(result.id, { x: 0, y: 0, width: 10, height: 10 }), { ok: false });
  assert.equal(view.visible, false);
});

test('when the app window reloads, its pages go with it', async () => {
  const { env } = await openedPage();
  await env.service.open('/ws/site/other.html');
  env.win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(env.service.openPages, []);
  assert.deepEqual(env.win.contentView.children, []);
});

test('focus goes into the page on request', async () => {
  const { env, result, contents } = await openedPage();
  assert.deepEqual(env.service.focus(result.id), { ok: true });
  assert.equal(contents.focused, 1);
});

test('"Open in browser" hands over HTML files of the folder only', async () => {
  const env = fakeEnvironment({ files: siteFiles() });
  assert.deepEqual(await env.service.openInBrowser(PAGE), { ok: true });
  assert.deepEqual(env.openedPaths, [PAGE]);
  assert.equal((await env.service.openInBrowser('/elsewhere/x.html')).ok, false);
  assert.equal((await env.service.openInBrowser('/ws/run.sh')).ok, false);
  assert.deepEqual(env.openedPaths, [PAGE]);
});
