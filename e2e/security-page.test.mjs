// Settings › Security in the running app (#448, #449): the page reads main's
// overview, shows six rows, follows a session approval granted on a card and a
// new workspace default, opens the rule form in place and switches a tool at
// once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const PENDING = '#chat-messages .chat-approval-card[data-state="pending"]';

function ask(page, question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

async function openSecurityPage(app, page) {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-security').click());
  await poll(() => page.evaluate(() => document.querySelectorAll('#settings-security-rows .settings-security-row').length === 6),
    { what: 'six rows' });
}

/** Where the keyboard is, for a failure message that says more than "false". */
const focusInfo = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el ? `${el.tagName.toLowerCase()}#${el.id || ''}.${el.className || ''}[${el.dataset?.riskClass || el.dataset?.securityLink || ''}]` : 'none';
});

/**
 * Focus an element, make sure it has the focus, then press Enter on it. The
 * page redraws its rows after a change, so every attempt focuses the element
 * that is there now — a button replaced in between would never get it (#469).
 */
async function pressEnterOn(page, selector) {
  await poll(() => page.evaluate((sel) => {
    const target = document.querySelector(sel);
    if (!target) return false;
    if (document.activeElement !== target) target.focus();
    return document.activeElement === target;
  }, selector), { what: `focus on ${selector}` });
  await page.keyboard.press('Enter');
}

const rowText = (page, riskClass) => page.evaluate((cls) =>
  document.querySelector(`.settings-security-row[data-risk-class="${cls}"] .settings-security-row__toggle`)?.textContent ?? '', riskClass);

test('the Security page shows main\'s state and follows it', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-security-'));
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-security-userdata-'));
  await writeFile(path.join(workspace, 'README.md'), 'one\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });
  const { app, page } = snotra;
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  // A change allowed for the session shows up as an exception of its row.
  model.queueAnswer({ match: 'README', toolCalls: [{ name: 'edit_file', arguments: { relative_path: 'README.md', old_string: 'one', new_string: 'two' } }] });
  await ask(page, 'Change the README please.');
  await poll(() => page.evaluate((selector) => {
    const button = [...document.querySelectorAll(selector)].at(-1)?.querySelector('button[data-response="allow-session"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, PENDING), { what: 'card with "allow for this session"', timeoutMs: 30_000 });
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });

  await openSecurityPage(app, page);
  const overview = await page.evaluate(() => window.electronAPI.getSecurityOverview());
  assert.equal(overview.workspace.root.endsWith(path.basename(workspace)), true);
  assert.equal(overview.defaultMode, 'smart');
  assert.deepEqual(overview.classes.map((c) => c.riskClass), ['read', 'read-sensitive', 'write', 'delete', 'execute', 'external']);
  assert.match(await rowText(page, 'read'), /Runs/);
  assert.match(await rowText(page, 'write'), /1 session allowance/);
  assert.match(await rowText(page, 'write'), /Asks/);
  // Nothing that matches an approval reaches the renderer.
  const grant = overview.classes.find((c) => c.riskClass === 'write').sessionGrants[0];
  assert.equal('scopeKey' in grant, false);

  // A new default for the folder: the page follows, the chat on screen is named.
  await page.evaluate(() => document.querySelector('#settings-security-mode-options input[value="ask-all"]').click());
  // The choice is saved once its status says so; until then the control
  // keeps the focus for itself (WorkspaceModeSetting.js).
  await poll(() => page.evaluate(() => document.getElementById('status-security-mode').classList.contains('is-visible')),
    { what: 'default saved' });
  await poll(async () => /Asks/.test(await rowText(page, 'read')), { what: 'read row asks' });
  const summary = await page.evaluate(() => document.getElementById('settings-security-summary').textContent);
  assert.match(summary, /asks before reading/);
  assert.match(await page.evaluate(() => document.getElementById('settings-security-other-chats').textContent), /runs on Smart/);

  // Keyboard: open a row with Enter, follow its link to the card it names.
  await pressEnterOn(page, '.settings-security-row__toggle[data-risk-class="write"]');
  try {
    await poll(() => page.evaluate(() =>
      document.querySelector('.settings-security-row__toggle[data-risk-class="write"]').getAttribute('aria-expanded') === 'true'),
    { what: 'write row opened by Enter' });
  } catch (error) {
    throw new Error(`${error.message}; focus is on ${await focusInfo(page)}`);
  }
  // The rule form opens in place, prefilled, and Escape gives the keyboard
  // back to the button that opened it (#449).
  await pressEnterOn(page, '.settings-security-row[data-risk-class="write"] [data-rule-add="deny"]');
  const form = await poll(() => page.evaluate(() => {
    const inRow = document.querySelector('.settings-security-row[data-risk-class="write"] #settings-rule-form');
    return inRow ? {
      effect: document.getElementById('rule-effect').value,
      riskClass: document.getElementById('rule-class').value,
      focus: document.activeElement?.id,
    } : null;
  }), { what: 'rule form in the write row' });
  assert.deepEqual(form, { effect: 'deny', riskClass: 'write', focus: 'rule-pattern' });
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => document.activeElement?.dataset?.ruleAdd === 'deny'
    && !document.querySelector('.settings-security-row #settings-rule-form')), { what: 'form closed, focus back' });
  assert.equal(await page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')), true,
    'Escape in the form closes the form, not the dialog');

  // A tool switch applies at once — no "Apply".
  const editSwitch = '.settings-security-row[data-risk-class="write"] input[data-tool-switch="edit_file"]';
  await page.locator(editSwitch).click();
  await poll(async () => (await page.evaluate(() => window.electronAPI.getUIPrefs())).disabledTools?.includes('edit_file'),
    { what: 'edit_file switched off in the preferences' });
  await poll(async () => /3 tools on/.test(await rowText(page, 'write')), { what: 'the row counts one tool less' });
  await page.locator(editSwitch).click();
  await poll(async () => !(await page.evaluate(() => window.electronAPI.getUIPrefs())).disabledTools?.includes('edit_file'),
    { what: 'edit_file back on' });
});
