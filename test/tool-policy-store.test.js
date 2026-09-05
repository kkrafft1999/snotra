// Signierter Policy-Speicher (Issue #66, Konzept §7): Standard, Migration,
// Signatur, Manipulation, fehlende Verschlüsselung, Regeln und Reset.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createToolPolicyStore, POLICY_FILENAME, POLICY_KEY_FILENAME } = require('../src/main/services/tool-policy-store');

function makeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad cipher');
      return s.slice(4);
    },
  };
}

async function makeStore(t, { available = true, legacyPrefs } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-policy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const uiPrefsPath = path.join(dir, 'ui-preferences.json');
  if (legacyPrefs) await fs.writeFile(uiPrefsPath, JSON.stringify(legacyPrefs), 'utf8');
  const store = createToolPolicyStore({
    app: { getPath: () => dir },
    safeStorage: makeSafeStorage(available),
    fs,
    path,
    crypto,
    uiPrefsPath,
    log: { warn() {} },
    now: () => 1000,
  });
  return { dir, store, uiPrefsPath };
}

test('Erststart legt eine signierte Standard-Policy mit Modus smart an', async (t) => {
  const { dir, store } = await makeStore(t);
  const state = await store.read();
  assert.equal(state.mode, 'smart');
  assert.deepEqual(state.rules, []);
  assert.deepEqual(state.sensitivePathPatterns, []);
  assert.equal(state.integrity, 'ok');
  assert.equal(state.encryptionAvailable, true);
  assert.equal(state.legacyWriteMigrated, false);
  assert.equal(state.policyVersion, '0:ok');

  const file = JSON.parse(await fs.readFile(path.join(dir, POLICY_FILENAME), 'utf8'));
  assert.equal(file.version, 1);
  assert.match(file.signature, /^[0-9a-f]{64}$/);
  const key = await fs.readFile(path.join(dir, POLICY_KEY_FILENAME), 'utf8');
  assert.equal(Buffer.from(key, 'base64').toString('utf8').startsWith('enc:'), true, 'Schlüssel liegt nur verschlüsselt');
});

test('Migration: beide Altwerte von allowWorkspaceWrite werden zu smart und setzen den Hinweis', async (t) => {
  for (const legacy of [true, false]) {
    const { store } = await makeStore(t, { legacyPrefs: { allowWorkspaceWrite: legacy } });
    const state = await store.read();
    assert.equal(state.mode, 'smart', `allowWorkspaceWrite=${legacy}`);
    assert.equal(state.legacyWriteMigrated, true);
    const cleared = await store.clearLegacyMigrationNotice();
    assert.equal(cleared.legacyWriteMigrated, false);
  }
  const { store } = await makeStore(t, { legacyPrefs: { appLocale: 'de' } });
  assert.equal((await store.read()).legacyWriteMigrated, false, 'ohne Altwert kein Hinweis');
});

test('Änderungen erhöhen die Revision und bleiben signiert lesbar', async (t) => {
  const { store } = await makeStore(t);
  const afterMode = await store.setMode('ask-all');
  assert.equal(afterMode.ok, true);
  assert.equal(afterMode.mode, 'ask-all');
  assert.equal(afterMode.revision, 1);

  const added = await store.addRule({ effect: 'deny', tool: 'write_file_text', pathPattern: 'src/**' });
  assert.equal(added.ok, true);
  assert.equal(added.rules.length, 1);
  assert.equal(added.rules[0].effect, 'deny');
  assert.match(added.rules[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(added.rules[0].createdAt, 1000);

  const patterns = await store.setSensitivePathPatterns(['personal/**', '**', 'personal/**']);
  assert.deepEqual(patterns.sensitivePathPatterns, ['personal/**']);

  const reread = await store.read();
  assert.equal(reread.integrity, 'ok');
  assert.equal(reread.mode, 'ask-all');
  assert.equal(reread.revision, 3);
  assert.equal(reread.policyVersion, '3:ok');

  const removed = await store.removeRule(added.rules[0].id);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.rules, []);
  assert.equal((await store.removeRule('gibt-es-nicht')).ok, false);
});

test('Workspace-Regeln hängen an der kanonischen Wurzel und lassen sich getrennt zurücksetzen', async (t) => {
  const { store } = await makeStore(t);
  await store.addRule({ effect: 'deny', scope: 'workspace', root: '/a', tool: 'edit_file' });
  await store.addRule({ effect: 'deny', scope: 'workspace', root: '/b', tool: 'edit_file' });
  await store.addRule({ effect: 'deny', scope: 'global', tool: 'apply_patch' });
  let state = await store.read();
  assert.deepEqual(Object.keys(state.workspaceRules).sort(), ['/a', '/b']);
  assert.equal(state.rules.length, 3);

  state = await store.resetWorkspaceRules('/a');
  assert.deepEqual(Object.keys(state.workspaceRules), ['/b']);
  assert.equal(state.globalRules.length, 1);

  await store.setMode('auto');
  state = await store.resetAll();
  assert.equal(state.mode, 'smart');
  assert.deepEqual(state.rules, []);
  assert.deepEqual(state.sensitivePathPatterns, []);
});

test('manipulierte Datei: Fail-safe behält Sperren und Muster, verwirft Erlaubnisse und Auto', async (t) => {
  const { dir, store } = await makeStore(t);
  await store.setMode('auto');
  await store.addRule({ effect: 'allow', riskClass: 'write' });
  await store.addRule({ effect: 'deny', tool: 'apply_patch' });
  await store.setSensitivePathPatterns(['personal/**']);

  const filePath = path.join(dir, POLICY_FILENAME);
  const file = JSON.parse(await fs.readFile(filePath, 'utf8'));
  // Ein Werkzeug „bessert“ die Datei blind nach: gleiche Regeln, anderer Text.
  file.payload.mode = 'auto';
  file.payload.globalRules.push({ id: 'evil', effect: 'allow', riskClass: 'read', scope: 'global', pathPattern: '**' });
  await fs.writeFile(filePath, JSON.stringify(file), 'utf8');

  const state = await store.read();
  assert.equal(state.integrity, 'invalid');
  assert.equal(state.mode, 'smart');
  assert.deepEqual(state.rules.map((r) => r.effect), ['deny']);
  assert.deepEqual(state.sensitivePathPatterns, ['personal/**']);
  assert.equal(state.policyVersion.endsWith(':invalid'), true);

  // Die nächste Änderung schreibt wieder signiert und heilt den Zustand.
  const healed = await store.setMode('ask-all');
  assert.equal(healed.ok, true);
  assert.equal((await store.read()).integrity, 'ok');
});

test('unsignierte oder kaputte Datei löst ebenfalls Fail-safe aus', async (t) => {
  const { dir, store } = await makeStore(t);
  const filePath = path.join(dir, POLICY_FILENAME);
  await fs.writeFile(filePath, JSON.stringify({ version: 1, payload: { mode: 'auto', globalRules: [{ id: 'd', effect: 'deny', tool: 'x' }] } }), 'utf8');
  let state = await store.read();
  assert.equal(state.integrity, 'unsigned');
  assert.equal(state.mode, 'smart');
  assert.equal(state.rules.length, 1);

  await fs.writeFile(filePath, '{ kaputt', 'utf8');
  state = await store.read();
  assert.equal(state.integrity, 'invalid');
  assert.equal(state.mode, 'smart');
  assert.deepEqual(state.rules, []);
});

test('ohne safeStorage: kein Auto, keine dauerhaften Erlaubnisse, Sperren funktionieren', async (t) => {
  const { store } = await makeStore(t, { available: false });
  const state = await store.read();
  assert.equal(state.encryptionAvailable, false);
  assert.equal(state.integrity, 'unsigned');
  assert.equal(state.mode, 'smart');

  const auto = await store.setMode('auto');
  assert.equal(auto.ok, false);
  assert.match(auto.error, /verschlüsselt/);
  const allow = await store.addRule({ effect: 'allow', riskClass: 'read' });
  assert.equal(allow.ok, false);
  const deny = await store.addRule({ effect: 'deny', riskClass: 'external' });
  assert.equal(deny.ok, true);
  assert.equal((await store.read()).rules.length, 1);
  assert.equal((await store.setMode('ask-all')).mode, 'ask-all');
});

test('ungültige Regeln werden abgewiesen, gleiche IDs nicht doppelt vergeben', async (t) => {
  const { store } = await makeStore(t);
  assert.equal((await store.addRule({ effect: 'allow', riskClass: 'delete' })).ok, false);
  assert.equal((await store.addRule({ effect: 'deny' })).ok, false);
  assert.equal((await store.addRule({ id: 'fix', effect: 'deny', tool: 'a' })).ok, true);
  assert.equal((await store.addRule({ id: 'fix', effect: 'deny', tool: 'b' })).ok, false);
  assert.equal((await store.findRule('fix')).tool, 'a');
  assert.equal(await store.findRule('nope'), null);
});
