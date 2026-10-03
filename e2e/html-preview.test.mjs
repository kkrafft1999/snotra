// HTML files as live pages in the running app (#479): the page runs in a view
// of its own, cannot reach the app, sends nothing over the network, loads its
// own files and nothing outside the folder, follows its links only after a
// click, reloads when a file changes, and a page stuck in an endless loop
// leaves the app responsive.
//
// The page is not in the app's window, so Playwright's `page` does not see it.
// The test reaches it through the main process: its WebContents runs the
// probes, and `sendInputEvent` clicks in it the way a mouse would. A local
// HTTP server stands in for "the internet" — it must never hear from the page.
//
// No `alert()` in the probe: Playwright attaches to the page's WebContents as
// well and fails on the dialog Electron suppresses (`disableDialogs`). That
// setting is pinned in test/html-preview-service.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12" fill="#00759E"/></svg>';

function hostilePage(leak) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Probe</title>
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="${leak}/remote.css">
<script src="${leak}/remote.js"></script>
<style>@font-face { font-family: Remote; src: url(${leak}/font.woff2); } h1 { font-family: Remote, sans-serif; }</style>
</head><body style="height: 4000px">
<h1 id="title">Seite</h1>
<img id="logo" src="img/logo.svg" alt="">
<img src="${leak}/pixel.png" alt="">
<img src="../../../../../../../../etc/hosts" alt="">
<img src="fehlt.png" alt="">
<p><a id="local" href="zweite.html#teil">Weiter</a> <a id="external" href="https://example.com/docs">Doku</a></p>
<script src="app.js"></script>
<script>
  const probes = {};
  probes.electronAPI = typeof window.electronAPI;
  probes.require = typeof window.require;
  probes.process = typeof window.process;
  probes.ownTop = window.top === window && window.parent === window;
  probes.appTree = (() => { try { return !!window.top.document.getElementById('tree-container'); } catch (e) { return 'threw'; } })();
  probes.popup = (() => { try { return window.open('${leak}/popup') === null; } catch (e) { return 'threw'; } })();
  fetch('${leak}/api').then(() => { probes.fetch = 'reached'; }, () => { probes.fetch = 'blocked'; });
  fetch('daten.json').then((r) => r.json()).then((j) => { probes.local = j.ok; }, (e) => { probes.local = String(e); });
  try { navigator.sendBeacon('${leak}/beacon', 'x'); } catch (e) {}
  try { new WebSocket('${leak.replace('http', 'ws')}/socket'); } catch (e) {}
  window.__probes = probes;
</script>
</body></html>`;
}

test('HTML preview: isolated, offline, local files only, links, reload, endless loop', { timeout: 180000 }, async (t) => {
  // "The internet": counts every request that reaches it.
  const leaks = [];
  const server = http.createServer((req, res) => {
    leaks.push(req.url);
    res.end('leaked');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const leak = `http://127.0.0.1:${server.address().port}`;

  const model = await startFakeModel();
  const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-html-'));
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-html-userdata-'));
  const site = path.join(workspace, 'site');
  await mkdir(path.join(site, 'img'), { recursive: true });
  await writeFile(path.join(site, 'probe.html'), hostilePage(leak), 'utf8');
  await writeFile(path.join(site, 'style.css'), '#title { color: rgb(1, 2, 3); }', 'utf8');
  await writeFile(path.join(site, 'app.js'), 'window.__appJs = true;', 'utf8');
  await writeFile(path.join(site, 'daten.json'), '{"ok": true}', 'utf8');
  await writeFile(path.join(site, 'img', 'logo.svg'), LOGO_SVG, 'utf8');
  await writeFile(path.join(site, 'zweite.html'), '<!doctype html><h1 id="teil">Zweite Seite</h1>', 'utf8');
  await writeFile(path.join(site, 'schleife.html'), '<!doctype html><p>Schleife</p><script>for (;;) {}</script>', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
    server.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });
  const { page, app } = snotra;
  const readOpenedLinks = await snotra.captureExternalLinks();
  const started = Date.now();
  const step = (name) => t.diagnostic(`${String(Date.now() - started).padStart(6)} ms  ${name}`);

  // ── Helpers through the main process ─────────────────────────────────────
  const previewState = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const views = win.contentView.children.filter((view) => view.webContents?.getURL().startsWith('snotra-html:'));
    return views.map((view) => ({
      url: view.webContents.getURL(),
      visible: view.getVisible(),
      bounds: view.getBounds(),
      window: win.getContentBounds(),
    }));
  });
  const inPage = (code) => app.evaluate(async ({ webContents }, source) => {
    const contents = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('snotra-html:'));
    if (!contents) return { missing: true };
    try {
      return { value: await contents.executeJavaScript(source) };
    } catch (err) {
      return { error: String(err?.message ?? err) };
    }
  }, code);
  // A real click: mouse down and up at the middle of the element.
  const clickInPage = (selector) => app.evaluate(async ({ webContents, BrowserWindow }, sel) => {
    BrowserWindow.getAllWindows()[0].focus();
    const contents = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('snotra-html:'));
    const box = await contents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      })()`
    );
    const [x, y] = box.map(Math.round);
    contents.focus();
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return [x, y];
  }, selector);
  const openInTree = async (...names) => {
    for (const name of names) {
      await poll(() => page.evaluate((label) => {
        const row = [...document.querySelectorAll('#tree-container .tree-item')]
          .find((el) => el.querySelector('.label')?.textContent === label);
        if (!row) return false;
        row.click();
        return true;
      }, name), { what: `${name} im Baum` });
    }
  };
  const header = () => page.evaluate(() => ({
    name: document.getElementById('preview-filename').textContent,
    view: document.querySelector('#preview-body > .file-view')?.dataset.view ?? null,
    notice: document.querySelector('.html-view__notice-text--blocked')?.textContent ?? '',
    noticeHidden: document.querySelector('.html-view__notice')?.hidden ?? true,
  }));

  // ── The page runs, in isolation ──────────────────────────────────────────
  await openInTree('site', 'probe.html');
  const probes = await poll(async () => {
    const result = await inPage('window.__probes && window.__probes.fetch && window.__probes.local !== undefined ? window.__probes : null');
    return result.value ?? null;
  }, { what: 'Proben der Seite' });
  assert.equal(probes.electronAPI, 'undefined', 'no preload bridge');
  assert.equal(probes.require, 'undefined', 'no Node');
  assert.equal(probes.process, 'undefined', 'no Node');
  assert.equal(probes.ownTop, true, 'the page is its own top: no parent document');
  assert.equal(probes.appTree, false, 'the app DOM is out of reach');
  assert.equal(probes.popup, true, 'no popup');
  assert.equal(probes.fetch, 'blocked');
  assert.equal(probes.local, true, 'a local JSON file is fetched');
  step('Seite laeuft isoliert');

  const looks = await inPage(`({
    color: getComputedStyle(document.getElementById('title')).color,
    appJs: window.__appJs === true,
    logo: document.getElementById('logo').naturalWidth,
  })`);
  assert.deepEqual(looks.value, { color: 'rgb(1, 2, 3)', appJs: true, logo: 24 });

  const [view] = await previewState();
  assert.equal(view.visible, true);
  assert.ok(view.bounds.width > 100 && view.bounds.height > 100, JSON.stringify(view.bounds));
  assert.ok(view.bounds.x + view.bounds.width <= view.window.width + 1, 'inside the window');
  assert.deepEqual(await header().then((h) => [h.name, h.view]), ['probe.html', 'html']);

  // ── Nothing went out, and the notice says what was blocked ───────────────
  const notice = await poll(async () => {
    const h = await header();
    return !h.noticeHidden && /blockiert/.test(h.notice) ? h.notice : null;
  }, { what: 'Hinweis auf blockierte Anfragen' });
  assert.match(notice, /^\d+ Anfragen blockiert\./);
  await page.click('.html-view__notice-row--blocked .html-view__notice-button');
  const listed = await page.evaluate(() => [...document.querySelectorAll('.html-view__blocked-item')]
    .map((row) => `${row.querySelector('.html-view__blocked-reason').textContent} ${row.querySelector('.html-view__blocked-url').textContent}`));
  for (const expected of [
    `Netzwerk ${leak}/remote.css`, `Netzwerk ${leak}/remote.js`, `Netzwerk ${leak}/pixel.png`,
    `Netzwerk ${leak}/api`, `Fehlt site/fehlt.png`, 'Außerhalb des Ordners /etc/hosts',
  ]) {
    assert.ok(listed.includes(expected), `${expected} in ${JSON.stringify(listed)}`);
  }
  assert.deepEqual(leaks, [], 'no request reached the network');
  step('nichts ins Netz, Hinweis mit Liste');

  // ── While a dialog of the app is open, the page is hidden ────────────────
  // The dialog's own opening is the smoke test's; here only its layer counts.
  await page.evaluate(() => document.getElementById('modal-settings').classList.remove('hidden'));
  await poll(async () => (await previewState())[0]?.visible === false || null, { what: 'Seite unter dem Dialog verborgen' });
  await page.evaluate(() => document.getElementById('modal-settings').classList.add('hidden'));
  await poll(async () => (await previewState())[0]?.visible === true || null, { what: 'Seite nach dem Dialog zurueck' });
  step('Dialog verdeckt die Seite nicht');

  // ── A change on disk reloads, the scroll position stays ──────────────────
  await inPage('window.scrollTo(0, 600)');
  await writeFile(path.join(site, 'style.css'), '#title { color: rgb(4, 5, 6); }', 'utf8');
  const reloaded = await poll(async () => {
    const result = await inPage(`[getComputedStyle(document.getElementById('title')).color, window.scrollY]`);
    return result.value?.[0] === 'rgb(4, 5, 6)' ? result.value : null;
  }, { what: 'neu geladene Seite nach geaendertem Stylesheet' });
  assert.ok(Math.abs(reloaded[1] - 600) < 50, `scroll kept: ${reloaded[1]}`);
  step('Aenderung auf der Platte laedt neu');

  // ── Links: without a click nothing, with a click the right place ─────────
  await inPage(`location.href = '${leak}/scripted'`);
  await inPage(`location.href = 'zweite.html'`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal((await header()).name, 'probe.html', 'a scripted navigation went nowhere');
  assert.deepEqual(await readOpenedLinks(), []);

  await clickInPage('#external');
  await poll(async () => ((await readOpenedLinks()).length ? true : null), { what: 'externer Link im Browser' });
  assert.deepEqual(await readOpenedLinks(), ['https://example.com/docs']);
  assert.match((await previewState())[0].url, /probe\.html$/, 'the page stays where it is');

  await clickInPage('#local');
  await poll(async () => ((await header()).name === 'zweite.html' ? true : null), { what: 'lokaler Link in der Vorschau' });
  const selected = await page.evaluate(() => document.querySelector('#tree-container .tree-item.active .label')?.textContent ?? null);
  assert.equal(selected, 'zweite.html', 'the tree follows');
  await poll(async () => {
    const state = await previewState();
    return state.length === 1 && state[0].url.endsWith('zweite.html#teil') ? true : null;
  }, { what: 'zweite Seite mit Fragment, die erste geschlossen' });
  assert.deepEqual(leaks, []);
  step('Links folgen nur dem Klick');

  // ── F6 hands the keyboard back ───────────────────────────────────────────
  await page.focus('.html-view__stage');
  await app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith('snotra-html:'));
    contents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'F6', shift: false });
  });
  await poll(() => page.evaluate(() => !document.activeElement?.classList.contains('html-view__stage') || null),
    { what: 'Fokus nach F6 wieder in der App' });

  // ── An endless loop leaves the app responsive ────────────────────────────
  await openInTree('schleife.html');
  await poll(async () => ((await previewState())[0]?.url.endsWith('schleife.html') ? true : null), { what: 'Schleifenseite' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = Date.now();
  const labels = await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length);
  assert.ok(labels > 0);
  assert.ok(Date.now() - before < 2000, 'the app answers while the page loops');
  await page.evaluate(() => document.querySelector('.html-tools__reload').click());
  await openInTree('zweite.html');
  await poll(async () => {
    const state = await previewState();
    return state.length === 1 && state[0].url.endsWith('zweite.html') ? true : null;
  }, { what: 'Schleifenseite geschlossen' });
  step('Endlosschleife haelt die App nicht auf');

  // ── Source, and back ─────────────────────────────────────────────────────
  await page.evaluate(() => document.querySelector('.file-view-mode-switch input[value="source"]').click());
  await poll(async () => (await previewState())[0]?.visible === false || null, { what: 'Seite in der Quelltextansicht verborgen' });
  assert.match(await page.textContent('#preview-content'), /Zweite Seite/);
  assert.deepEqual(leaks, [], 'still nothing on the network');
});
