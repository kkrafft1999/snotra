// An automated accessibility pass over the main screens (#999, AR-24).
//
// axe-core checks the real window — Chromium's layout and computed colours,
// which happy-dom has neither of — against WCAG 2.1 A and AA, in the light and
// in the dark theme: the welcome page of a fresh profile, the workspace with a
// file in the preview and a finished chat turn, and each section of the
// settings. It does not replace the screen-reader pass of the release
// checklist (docs/release.md); axe finds what can be computed, not what is
// confusing to hear.
//
// A finding that needs more than a small fix gets an issue of its own and an
// entry in KNOWN with its link, so that it is excluded by name and not by
// switching a rule off for the whole app.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';
import { axeViolations, describeViolations } from './helpers/axe.mjs';

const THEMES = ['light', 'dark'];

/**
 * Findings excluded on purpose: a rule id and what the element has to show —
 * a selector its target contains, or a piece of its markup — nothing broader;
 * and the issue that carries it, or why it is not a defect.
 */
const KNOWN = [
  {
    // A long folder name is cut in the middle to fit the sidebar
    // ("snotra-a…-LkeQPU"); the button's name carries it in full. axe reads
    // the cut text as a label of its own.
    rule: 'label-content-name-mismatch', target: '#btn-workspace',
    why: 'middle ellipsis of the folder name',
  },
];

const known = (violation) => KNOWN.some((k) => k.rule === violation.rule
  && (k.target ? violation.target.includes(k.target) : violation.html.startsWith(k.html)));

/**
 * Sets the theme the way ThemeManager.js does, and ends the colour transitions
 * it starts. Buttons and segmented options fade their colours over 150 ms; a
 * window the runner throttles or hides does not advance them, so after a fixed
 * wait axe could still read the old theme's ink on the new ground (#1118).
 * Finishing every running animation makes the check independent of time.
 */
async function useTheme(page, theme) {
  return page.evaluate((value) => {
    if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    void document.body.offsetHeight; // style and layout up to date, so the transitions exist
    // The theme's transitions end at once; a looping one — the pairing's waiting
    // dots (#1110) — has no end, and only its colour matters here.
    const running = document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
    for (const animation of running) animation.finish();
    return running.length;
  }, theme);
}

/** Checks one screen in both themes and collects what it finds under `name`. */
async function checkScreen(page, name, findings, options = {}) {
  for (const theme of THEMES) {
    await useTheme(page, theme);
    for (const violation of await axeViolations(page, options)) {
      if (!known(violation)) findings.push({ screen: `${name} (${theme})`, ...violation });
    }
  }
}

function assertClean(findings) {
  if (process.env.SNOTRA_AXE_REPORT) {
    console.log(JSON.stringify(findings, null, 1));
    return;
  }
  const byScreen = Map.groupBy(findings, (f) => f.screen);
  assert.equal(findings.length, 0, [...byScreen].map(([screen, list]) => `${screen}:\n${describeViolations(list)}`).join('\n'));
}

const shown = (page, id) => page.evaluate((key) => {
  const el = document.getElementById(key);
  return Boolean(el) && !el.classList.contains('hidden') && !el.hidden;
}, id);

/**
 * Waits until the window has taken in what main sends after the first paint.
 * Until then the markup carries its static stand-ins: the sidebar divider
 * has no `aria-valuenow` before the widths arrive, and the permission pill
 * keeps a generic name that does not contain its label yet. A slow runner
 * met axe in between (macOS CI, 2026-10-17); that is a moment of the start,
 * not the state a user works in.
 */
async function waitForSettledWindow(page) {
  await poll(() => page.evaluate(() => {
    const pill = document.getElementById('btn-chat-tool-mode');
    const label = document.getElementById('chat-tool-mode-label')?.textContent.trim() ?? '';
    return document.getElementById('divider').hasAttribute('aria-valuenow')
      && Boolean(label) && (pill.getAttribute('aria-label') ?? '').includes(label);
  }), { what: 'the window settled after start (divider width, permission pill)' });
}

async function openSettings(app, page) {
  await poll(async () => {
    if (await shown(page, 'modal-settings')) return true;
    await app.evaluate(({ Menu }) => {
      for (const top of Menu.getApplicationMenu().items) {
        const item = top.submenu?.items.find((entry) => /^(Settings|Einstellungen)…$/.test(entry.label ?? ''));
        if (item) { item.click(); return; }
      }
    });
    return false;
  }, { what: 'settings dialog' });
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled), { what: 'settings loaded' });
}

test('the welcome page and the help window pass axe, light and dark', { timeout: 120000 }, async (t) => {
  const userDataDir = await makeTempDir('snotra-a11y-fresh-');
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  const snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));
  const { app, page } = snotra;
  await poll(() => shown(page, 'welcome'), { what: 'welcome page' });
  await waitForSettledWindow(page);

  const findings = [];
  await checkScreen(page, 'welcome', findings);

  const opened = app.waitForEvent('window');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('help.manual').click());
  const help = await opened;
  await poll(() => help.evaluate(() => Boolean(document.querySelector('.manual-nav [aria-current="page"]'))
    && Boolean(document.querySelector('#manual-doc h1'))), { what: 'the help window with its overview' });
  await checkScreen(help, 'help window', findings);
  assertClean(findings);
});

test('the workspace and every settings section pass axe, light and dark; System follows the OS', { timeout: 240000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-a11y-');
  const userDataDir = await makeTempDir('snotra-a11y-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Garden notes\n\nTomatoes go out after the last frost.\n', 'utf8');
  await writeFile(path.join(workspace, 'beds.md'), '- Bed 1: tomatoes\n- Bed 2: beans\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  // Developer mode on (#1213), so that Settings › Remote access is there to be checked.
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en', developerMode: true }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { app, page } = snotra;
  const findings = [];

  // The workspace: tree, a Markdown file in the preview, one finished turn.
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length >= 2),
    { what: 'drawn tree' });
  await page.evaluate(() => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === 'README.md').click();
  });
  await poll(() => page.evaluate(() => document.querySelector('.md-doc h1')?.textContent === 'Garden notes'),
    { what: 'README in the preview' });
  model.queueAnswer({ match: 'A11Y-1', text: 'Plant them **after mid-May**; the soil needs to be warm.' });
  await sendChat(page, 'A11Y-1 When do the tomatoes go out?', { t });
  await poll(() => page.evaluate(() => document.getElementById('chat-messages').textContent.includes('mid-May')
    && !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'the answer, finished' });
  await waitForSettledWindow(page);
  await page.mouse.move(0, 0);
  await checkScreen(page, 'workspace', findings);
  // The phone in the title bar, connected and keeping awake (#1196).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents
    .send('remote:presence', { connected: true, keepingAwake: true }));
  await poll(() => shown(page, 'titlebar-remote'), { what: 'the phone in the title bar' });
  await checkScreen(page, 'workspace › phone connected', findings, { context: '#titlebar' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents
    .send('remote:presence', { connected: false, keepingAwake: false }));

  // The same chat with a turn from the phone (#1197): the question marked
  // under its bubble, the step and the folded card marked after their text.
  // It comes as main tells the window of a phone's turn.
  const chatId = (await page.evaluate(() => window.electronAPI.getChatHistory()))?.activeChatId;
  assert.ok(chatId, 'the chat on screen has an id');
  const phone = { kind: 'relay', client: 'iPhone' };
  const route = { chatId, runId: 'a11y-phone-run' };
  const toWindow = (channel, payload) => app.evaluate(({ BrowserWindow }, [c, p]) => {
    BrowserWindow.getAllWindows()[0].webContents.send(c, p);
  }, [channel, payload]);
  await toWindow('chat:turn-started', { ...route, content: 'A11Y-2 And the beans?', origin: phone });
  await toWindow('chat:tool-line', { ...route, phase: 'start', callIndex: 0, tool: 'read_file_text', category: 'read', line: 'Reading beds.md' });
  await toWindow('toolApproval:request', {
    contractVersion: 1, requestId: 'a11y-phone-card', tool: 'read_file_text', riskClasses: ['read'],
    targets: [], reason: '', mode: 'ask-all', sessionAllowed: false, chatId,
  });
  await toWindow('toolApproval:resolved', { requestId: 'a11y-phone-card', response: 'allow-once', invalidated: false, reason: null, by: phone });
  await toWindow('chat:tool-line', { ...route, phase: 'done', callIndex: 0, tool: 'read_file_text', category: 'read', line: 'Read beds.md', answeredBy: phone });
  await toWindow('chat:delta', { ...route, text: 'Beans go into bed 2.' });
  await poll(() => page.evaluate(() => Boolean(document.querySelector('#chat-messages .chat-msg-origin'))
    && Boolean(document.querySelector('#chat-messages .chat-tool-line .chat-origin-tag'))
    && Boolean(document.querySelector('#chat-messages .chat-approval-card__toggle .chat-origin-tag'))),
  { what: 'the marks of the phone\'s turn' });
  await page.evaluate(() => { document.querySelector('#chat-messages .chat-msg.assistant:last-of-type .chat-tool-log')?.setAttribute('open', ''); });
  await waitForSettledWindow(page);
  await checkScreen(page, 'workspace with a turn from the phone', findings, { context: '#chat-messages' });
  await toWindow('chat:progress', { ...route, type: 'run-end' });
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'the phone\'s turn, ended' });

  // Each section of the settings, the dialog only: the window behind it is
  // inert while it is open and was checked above.
  await openSettings(app, page);
  for (const panel of ['models', 'security', 'tools', 'skills', 'memory', 'remote', 'general']) {
    await page.click(`.settings-nav-item[data-settings-panel="${panel}"]`);
    await poll(() => page.evaluate((key) => document.querySelector(`.settings-nav-item[data-settings-panel="${key}"]`)
      ?.getAttribute('aria-selected') === 'true', panel), { what: `settings section ${panel}` });
    await page.mouse.move(0, 0);
    await checkScreen(page, `settings › ${panel}`, findings, { context: '#modal-settings' });
  }

  // Remote access (#1110) in the states main pushes once pairing is open —
  // it is closed in this build, so they come as main would send them.
  await page.click('.settings-nav-item[data-settings-panel="remote"]');
  const quiet = { encryptionAvailable: true, phone: null, code: null, words: null, replacing: false, reason: null, locked: false };
  const square = Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => ((x * y + x) % 3 ? '0' : '1')).join(''));
  const remoteStates = {
    code: { ...quiet, state: 'code', code: { display: '0111-EP9D-ZH4Q-PYT4-HWWF', qr: 'snotra-pair:v1/relay.snotra-ai.dev/0111EP9DZH4QPYT4HWWF', expiresAt: Date.now() + 240000, modules: square } },
    confirm: { ...quiet, state: 'confirm', words: ['coffeecake', 'groundhog', 'maestro', 'kangaroo', 'ozone', 'oncoming'] },
    stopped: { ...quiet, state: 'stopped', reason: 'mac' },
    // Last: its Remove phone opens the question checked below.
    paired: { ...quiet, state: 'paired', phone: { pairedAt: Date.now() - 86400000, connected: true } },
  };
  for (const [name, state] of Object.entries(remoteStates)) {
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('remote:state', s), state);
    await poll(() => page.evaluate(() => !!document.querySelector('#settings-remote-body .ra-card')), { what: `remote access: ${name}` });
    await page.mouse.move(0, 0);
    await checkScreen(page, `settings › remote › ${name}`, findings, { context: '#modal-settings' });
  }
  await page.click('#settings-remote-body [data-action="remove"]');
  await checkScreen(page, 'settings › remote › remove?', findings, { context: '#modal-settings' });
  // Back to General, which the check below works on.
  await page.click('.settings-nav-item[data-settings-panel="general"]');
  assertClean(findings);

  // "System" (#999), reached with the keyboard on the page left open above:
  // the arrow keys walk the appearance from Light over Dark to System, the
  // focus ring shows where they are, and the page then follows the OS.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.focus('input[name="app-theme"]:checked');
  assert.equal(await page.evaluate(() => document.activeElement.value), 'light');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const focused = await page.evaluate(() => {
    const radio = document.activeElement;
    return { value: radio.value, checked: radio.checked, ring: getComputedStyle(radio.closest('label')).outlineStyle };
  });
  assert.deepEqual(focused, { value: 'system', checked: true, ring: 'solid' });
  const shownTheme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme') ?? 'light');
  await poll(async () => (await shownTheme()) === 'light', { what: 'System on a light OS: light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await poll(async () => (await shownTheme()) === 'dark', { what: 'the OS turns dark: the page follows' });
  await page.emulateMedia({ colorScheme: 'light' });
  await poll(async () => (await shownTheme()) === 'light', { what: 'and back' });
  assert.equal(await page.evaluate(() => localStorage.getItem('theme')), 'system');
});
