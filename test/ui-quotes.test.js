const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MENU_PATHS, fillUiQuotes, menuPath } = require('../src/shared/i18n/ui-quotes');
const { MESSAGES } = require('../src/shared/i18n');
const {
  PERMISSION_DENIAL_REASONS,
  PERMISSION_DENIED_TOOL_RESULT_MESSAGES,
} = require('../src/shared/contracts/tool-permissions');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

/**
 * Model-facing text quotes a settings page so the user can find it (#294).
 * The sentence around it stays English (#276) — that line is guarded by
 * `test/model-prompt-language.test.js`; what is guarded here is the other
 * half: the quotation says what the interface says, in the language the
 * interface is currently speaking.
 */

test('a quoted path is built from entries the settings dialog really renders', () => {
  // Every key that `index.html` hangs on a node. A path assembled from
  // anything else would be a second list, free to drift away from the
  // navigation it claims to name.
  const rendered = new Set([...INDEX_HTML.matchAll(/data-i18n="([\w.]+)"/g)].map((m) => m[1]));
  const strays = [];
  for (const [name, keys] of Object.entries(MENU_PATHS)) {
    for (const key of keys) {
      if (!rendered.has(key)) strays.push(`${name}: ${key}`);
    }
  }
  assert.deepEqual(strays, [], 'menu path built from a key the interface does not show');
});

test('every path reads in both languages, and the two differ', () => {
  for (const name of Object.keys(MENU_PATHS)) {
    const en = menuPath('en', name);
    const de = menuPath('de', name);
    for (const [locale, value] of [['en', en], ['de', de]]) {
      assert.ok(value.trim(), `${name} (${locale}) is empty`);
      assert.equal(value.includes('.'), false, `${name} (${locale}) still carries a raw key: ${value}`);
    }
  }
  assert.equal(menuPath('en', 'settings.tools'), 'Settings › Tools');
  assert.equal(menuPath('de', 'settings.tools'), 'Einstellungen › Tools');
  assert.equal(menuPath('en', 'settings.memory'), 'Settings › Memory');
  assert.equal(menuPath('de', 'settings.memory'), 'Einstellungen › Gedächtnis');
  // Three levels deep, and the last step is a control rather than a page.
  assert.equal(menuPath('de', 'settings.skills.suggestions'), 'Einstellungen › Skills › Vorschläge im Chat');
});

test('the sentence stays English, only the quotation follows the language', () => {
  const raw = PERMISSION_DENIED_TOOL_RESULT_MESSAGES[PERMISSION_DENIAL_REASONS.TOOL_DISABLED];
  assert.match(raw, /\{menu:settings\.tools\}/, 'the table carries the placeholder, not a fixed language');
  assert.equal(
    fillUiQuotes('en', raw),
    'Tool is switched off. The user can enable it under "Settings › Tools".'
  );
  assert.equal(
    fillUiQuotes('de', raw),
    'Tool is switched off. The user can enable it under "Einstellungen › Tools".'
  );
});

test('a single label is quoted as it stands', () => {
  const raw = 'Mode {label:permissions.mode.smart} asks before a change.';
  assert.equal(fillUiQuotes('en', raw), 'Mode Smart asks before a change.');
  assert.equal(fillUiQuotes('de', raw), 'Mode Intelligent asks before a change.');
});

test('an unknown name stays visible instead of vanishing', () => {
  assert.equal(fillUiQuotes('en', 'See {menu:settings.tulls}.'), 'See {menu:settings.tulls}.');
  assert.equal(fillUiQuotes('en', 'Mode {label:no.such.key}.'), 'Mode {label:no.such.key}.');
  assert.equal(fillUiQuotes('en', 'nothing to fill'), 'nothing to fill');
  assert.equal(fillUiQuotes('en', null), null);
});

/**
 * The system skills go into the system prompt as they are. A quotation left in
 * one language there would be the same defect as before #294, only further from
 * the code.
 */
test('the system skills quote through the placeholder, not in one fixed language', () => {
  const dir = path.join(ROOT, 'system-skills');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/Einstellungen\s*›/.test(text)) offenders.push(`${name}: German menu path`);
    if (/Settings\s*[›>]\s*\w/.test(text)) offenders.push(`${name}: English menu path`);
    if (/\bIntelligent\b|\bImmer fragen\b/.test(text)) offenders.push(`${name}: German mode name`);
    for (const m of text.matchAll(/\{menu:([\w.]+)\}/g)) {
      if (!MENU_PATHS[m[1]]) offenders.push(`${name}: unknown path ${m[1]}`);
    }
    for (const m of text.matchAll(/\{label:([\w.]+)\}/g)) {
      if (!Object.prototype.hasOwnProperty.call(MESSAGES.en, m[1])) {
        offenders.push(`${name}: unknown label ${m[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a settings page quoted in a fixed language');
});

test('both catalogues know every key a path is built from', () => {
  const missing = [];
  for (const keys of Object.values(MENU_PATHS)) {
    for (const key of keys) {
      for (const locale of ['en', 'de']) {
        if (!Object.prototype.hasOwnProperty.call(MESSAGES[locale], key)) missing.push(`${locale}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'menu path points at an entry that does not exist');
});
