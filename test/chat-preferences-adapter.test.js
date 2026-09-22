const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatPreferencesAdapter } = require('../src/main/adapters/chat-preferences-adapter');

const adapterFor = (prefs) =>
  createChatPreferencesAdapter({ uiPrefsStore: { readUIPrefs: async () => prefs } });

/**
 * The adapter is the only way the stored preferences reach the chat core, so
 * anything it drops is invisible everywhere else. That is how the interface
 * language went missing: `tool-display.js` has taken a `locale` since #289, the
 * engine passed one on — and it was always the default, because this object
 * never carried the stored value (#290).
 */
test('the interface language reaches the chat core', async () => {
  assert.equal((await adapterFor({ appLocale: 'de' }).read()).appLocale, 'de');
  assert.equal((await adapterFor({ appLocale: 'en' }).read()).appLocale, 'en');
  // Unset means the app default, and that is decided further in, not here.
  assert.equal((await adapterFor({}).read()).appLocale, undefined);
  assert.equal((await adapterFor({ appLocale: 42 }).read()).appLocale, undefined);
});

test('the base system prompt and the switched-off tools travel along', async () => {
  const prefs = await adapterFor({
    baseSystemPrompt: ' bleib knapp ',
    disabledTools: ['shell_execute', '', 7],
  }).read();
  assert.equal(prefs.baseSystemPrompt, ' bleib knapp ');
  assert.deepEqual(prefs.disabledTools, ['shell_execute']);
});

test('a switch only travels when it is explicitly off', async () => {
  const untouched = await adapterFor({}).read();
  assert.equal('environmentInfoEnabled' in untouched, false);
  assert.equal('memoryWorkspaceEnabled' in untouched, false);
  assert.equal('activeSkills' in untouched, false);

  const off = await adapterFor({
    environmentInfoEnabled: false,
    projectInstructionsEnabled: false,
    memoryWorkspaceEnabled: false,
    memoryUserEnabled: false,
    activeSkills: [],
  }).read();
  assert.equal(off.environmentInfoEnabled, false);
  assert.equal(off.projectInstructionsEnabled, false);
  assert.equal(off.memoryWorkspaceEnabled, false);
  assert.equal(off.memoryUserEnabled, false);
  assert.deepEqual(off.activeSkills, []);
});
