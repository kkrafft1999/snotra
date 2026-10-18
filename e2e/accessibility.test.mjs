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
    const running = document.getAnimations();
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
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

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

  // Each section of the settings, the dialog only: the window behind it is
  // inert while it is open and was checked above.
  await openSettings(app, page);
  for (const panel of ['models', 'security', 'tools', 'skills', 'memory', 'general']) {
    await page.click(`.settings-nav-item[data-settings-panel="${panel}"]`);
    await poll(() => page.evaluate((key) => document.querySelector(`.settings-nav-item[data-settings-panel="${key}"]`)
      ?.getAttribute('aria-selected') === 'true', panel), { what: `settings section ${panel}` });
    await page.mouse.move(0, 0);
    await checkScreen(page, `settings › ${panel}`, findings, { context: '#modal-settings' });
  }
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
