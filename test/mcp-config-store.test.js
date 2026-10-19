// Persistenz der MCP-Server samt Secret-Trennung (Issue #108).
//
// safeStorage wird nachgebildet statt echt benutzt — auf einem CI-Runner gibt
// es keinen Schluesselbund. Die Attrappe verschluesselt sichtbar (Praefix),
// damit ein Test beweisen kann, dass in der Datei wirklich kein Klartext
// steht, und laesst sich abschalten, um den Fall „keine Verschluesselung
// verfuegbar" zu pruefen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { createStorageService } = require('../src/main/services/storage-service');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { removeTempDir } = require('./helpers/temp-dir');
const { ACCEPT_EVERY_RECEIPT, createTestConfirmations } = require('./helpers/confirmations');

const TOKEN = 'ghp_streng_geheim_1234567890';

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => {
      const text = buf.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('fremder Schlüssel');
      return text.slice(4);
    },
  };
}

async function makeStore(t, { encryption = true, confirmationReceipts = ACCEPT_EVERY_RECEIPT } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-mcp-'));
  t.after(() => removeTempDir(tmpDir));
  const storage = createStorageService({
    app: { getPath: () => tmpDir },
    safeStorage: fakeSafeStorage(encryption),
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions: 3,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
    confirmationReceipts,
  });
  return { storage, tmpDir, file: () => path.join(tmpDir, 'mcp-servers.json') };
}

const GITHUB = {
  id: 'github',
  label: 'GitHub',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: { value: TOKEN }, LANG: { secret: false, value: 'de_DE' } },
};

test('ein gespeicherter Server übersteht das erneute Lesen', async (t) => {
  const { storage } = await makeStore(t);
  assert.deepEqual((await storage.saveMcpServer(GITHUB)).ok, true);

  const [server] = await storage.readMcpServers();
  assert.equal(server.id, 'github');
  assert.equal(server.label, 'GitHub');
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.equal(server.enabled, true);
});

test('das Geheimnis steht nicht im Klartext in der Datei', async (t) => {
  const { storage, file } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);

  const raw = await fs.readFile(file(), 'utf8');
  assert.equal(raw.includes(TOKEN), false, 'der Token darf nirgends im Klartext stehen');
  assert.match(raw, /"enc"/);
  // Der abgewählte Wert steht bewusst lesbar da — das ist der Sinn des Opt-outs.
  assert.match(raw, /de_DE/);
});

test('die Anzeigeform verrät das Geheimnis nicht, den Klartextwert schon', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);

  const [server] = await storage.readMcpServers();
  assert.deepEqual(server.env, [
    { key: 'GITHUB_TOKEN', secret: true, hasValue: true },
    { key: 'LANG', secret: false, hasValue: true, value: 'de_DE' },
  ]);
  assert.equal(JSON.stringify(server).includes(TOKEN), false);
});

test('die Laufzeitform ist flach und entschlüsselt', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);

  const [server] = await storage.getMcpServersForRuntime();
  assert.deepEqual(server.env, { GITHUB_TOKEN: TOKEN, LANG: 'de_DE' });
});

test('ohne secret: false ist ein Wert geheim', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer({ id: 'x', command: 'npx', env: { IRGENDWAS: { value: 'ein_langer_wert' } } });
  const [server] = await storage.readMcpServers();
  assert.deepEqual(server.env, [{ key: 'IRGENDWAS', secret: true, hasValue: true }]);
});

test('keep behält das gespeicherte Geheimnis beim Ändern anderer Felder', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);

  // So verhält sich die Oberfläche: sie kennt den Token nicht und kann ihn
  // nicht zurücksenden — ohne keep wäre er beim Umbenennen weg.
  const result = await storage.saveMcpServer({
    ...GITHUB,
    label: 'GitHub (Arbeit)',
    env: { GITHUB_TOKEN: { keep: true }, LANG: { secret: false, value: 'en_US' } },
  });
  assert.equal(result.ok, true);

  const [server] = await storage.getMcpServersForRuntime();
  assert.equal(server.label, 'GitHub (Arbeit)');
  assert.equal(server.env.GITHUB_TOKEN, TOKEN, 'der Token muss erhalten bleiben');
  assert.equal(server.env.LANG, 'en_US');
});

// Until CR-B14-02 such an entry was dropped without a word — renaming a kept
// variable in the dialog lost the token that way.
test('a keep with nothing stored under its name is refused, not dropped', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  const result = await storage.saveMcpServer({ ...GITHUB, env: { GITHUB_PAT: { keep: true } } });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ key: 'mcp.error.envKeepMissing', params: { names: 'GITHUB_PAT' } }]);
  const [server] = await storage.getMcpServersForRuntime();
  assert.equal(server.env.GITHUB_TOKEN, TOKEN, 'the stored token is untouched');
});

test('a keep cannot flip a stored value between secret and plain text', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  const result = await storage.saveMcpServer({
    ...GITHUB,
    env: { GITHUB_TOKEN: { secret: false, keep: true }, LANG: { secret: true, keep: true } },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors,
    [{ key: 'mcp.error.envKeepChanged', params: { names: 'GITHUB_TOKEN, LANG' } }]);
  const [server] = await storage.getMcpServersForRuntime();
  assert.deepEqual(server.env, { GITHUB_TOKEN: TOKEN, LANG: 'de_DE' });
});

// An empty value has nothing to encrypt — `encryptIfPossible('')` gives null,
// which used to surface as "encrypted storage is not available".
test('an empty secret value counts as no value, never as missing encryption', async (t) => {
  for (const encryption of [true, false]) {
    const { storage } = await makeStore(t, { encryption });
    const result = await storage.saveMcpServer({ id: 'x', command: 'npx', env: { GITHUB_TOKEN: { value: '' } } });
    assert.equal(result.ok, true, `encryption ${encryption}: ${JSON.stringify(result.errors)}`);
    const [server] = await storage.readMcpServers();
    assert.deepEqual(server.env, [{ key: 'GITHUB_TOKEN', secret: false, hasValue: false, value: '' }]);
  }
});

test('an empty secret value never replaces a stored secret', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  const result = await storage.saveMcpServer({ ...GITHUB, env: { GITHUB_TOKEN: { secret: true, value: '' } } });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ key: 'mcp.error.envSecretEmpty', params: { names: 'GITHUB_TOKEN' } }]);
  const [server] = await storage.getMcpServersForRuntime();
  assert.equal(server.env.GITHUB_TOKEN, TOKEN);
});

test('ein zweites Speichern ersetzt den Server, statt ihn zu verdoppeln', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  await storage.saveMcpServer({ ...GITHUB, label: 'Neu', env: { GITHUB_TOKEN: { keep: true } } });

  const servers = await storage.readMcpServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].label, 'Neu');
});

// "Add server" with an id that exists used to replace that server — and drop
// its token and its switch with it (CR-B14-03).
test('a new server with a taken identifier is refused, the existing one stays', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer({ ...GITHUB, enabled: false });
  const result = await storage.saveMcpServer({ id: 'GitHub', command: 'uvx', create: true });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ key: 'mcp.error.idExists', params: { id: 'github' } }]);
  const [server] = await storage.getMcpServersForRuntime();
  assert.equal(server.command, 'npx');
  assert.equal(server.enabled, false);
  assert.equal(server.env.GITHUB_TOKEN, TOKEN);

  assert.equal((await storage.saveMcpServer({ id: 'files', command: 'npx', create: true })).ok, true);
  // Without the flag a save still replaces by id — editing and the import
  // rely on that.
  assert.equal((await storage.saveMcpServer({ id: 'github', command: 'uvx' })).ok, true);
  assert.equal((await storage.readMcpServers()).find((s) => s.id === 'github').command, 'uvx');
});

test('mehrere Server bleiben nebeneinander bestehen', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  await storage.saveMcpServer({ id: 'files', command: 'npx', args: ['-y', 'server-filesystem'] });

  assert.deepEqual((await storage.readMcpServers()).map((s) => s.id), ['files', 'github']);
});

test('ein ungültiger Server wird gar nicht erst geschrieben', async (t) => {
  const { storage } = await makeStore(t);
  const result = await storage.saveMcpServer({ id: 'ohne kommando' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(await storage.readMcpServers(), []);
});

test('löschen entfernt genau einen Server', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  await storage.saveMcpServer({ id: 'files', command: 'npx' });

  assert.equal((await storage.deleteMcpServer('github')).ok, true);
  assert.deepEqual((await storage.readMcpServers()).map((s) => s.id), ['files']);

  const nochmal = await storage.deleteMcpServer('github');
  assert.equal(nochmal.ok, false);
  assert.deepEqual(nochmal.errors, [{ key: 'mcp.error.unknownServer', params: { id: 'github' } }]);
});

test('ausschalten übersteht das Speichern', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer({ ...GITHUB, enabled: false, env: {} });
  assert.equal((await storage.readMcpServers())[0].enabled, false);
});

test('getMcpSecretValues liefert nur die verschlüsselten Werte', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  assert.deepEqual(await storage.getMcpSecretValues(), [TOKEN], 'de_DE ist kein Geheimnis');
});

test('ohne verfügbare Verschlüsselung wird ein Geheimnis nicht gespeichert', async (t) => {
  const { storage, file } = await makeStore(t, { encryption: false });
  const result = await storage.saveMcpServer(GITHUB);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors,
    [{ key: 'mcp.error.noSecureStorage', params: { names: 'GITHUB_TOKEN' } }]);
  // Die Meldung nennt den Schlüssel, niemals den Wert.
  assert.equal(JSON.stringify(result.errors).includes(TOKEN), false);
  await assert.rejects(() => fs.readFile(file(), 'utf8'), 'es darf gar keine Datei entstehen');
});

test('ohne Verschlüsselung lassen sich Klartextwerte weiterhin speichern', async (t) => {
  const { storage } = await makeStore(t, { encryption: false });
  const result = await storage.saveMcpServer({
    id: 'files',
    command: 'npx',
    env: { LANG: { secret: false, value: 'de_DE' } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual((await storage.getMcpServersForRuntime())[0].env, { LANG: 'de_DE' });
});

test('ein nicht entschlüsselbarer Wert lässt den Server trotzdem laufen', async (t) => {
  const { storage, file } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);

  // Fremder safeStorage-Schlüssel, z. B. nach einem Benutzerwechsel.
  const data = JSON.parse(await fs.readFile(file(), 'utf8'));
  data.servers[0].env.GITHUB_TOKEN.enc = Buffer.from('kaputt', 'utf8').toString('base64');
  await fs.writeFile(file(), JSON.stringify(data), 'utf8');

  const [server] = await storage.getMcpServersForRuntime();
  assert.equal(server.id, 'github');
  assert.equal(server.env.GITHUB_TOKEN, undefined, 'der unlesbare Wert fällt weg');
  assert.equal(server.env.LANG, 'de_DE', 'die übrigen bleiben');
});

test('eine kaputte Konfigurationsdatei ergibt eine leere Liste statt eines Absturzes', async (t) => {
  const { storage, file } = await makeStore(t);
  await fs.writeFile(file(), '{kein json', 'utf8');
  assert.deepEqual(await storage.readMcpServers(), []);
  assert.deepEqual(await storage.getMcpServersForRuntime(), []);
});

// --- Tool-Katalog (Issue #170) -------------------------------------------

test('der Tool-Katalog wird fortgeschrieben, ohne env anzufassen', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);

  const result = await storage.updateMcpServerKnownTools('github', ['search', 'create_issue', 'search']);
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);

  const [server] = await storage.readMcpServers();
  assert.deepEqual(server.knownTools, ['search', 'create_issue'], 'Reihenfolge des Servers, ohne Dopplung');
  const token = server.env.find((entry) => entry.key === 'GITHUB_TOKEN');
  assert.equal(token.secret, true);
  assert.equal(token.hasValue, true, 'das Geheimnis darf der Katalog nicht kosten');
});

test('ein unveraenderter Katalog schreibt die Datei nicht neu', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  await storage.updateMcpServerKnownTools('github', ['search']);

  const zweite = await storage.updateMcpServerKnownTools('github', ['search']);
  assert.equal(zweite.changed, false);
});

test('ein leerer Katalog und ein unbekannter Server aendern nichts', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  await storage.updateMcpServerKnownTools('github', ['search']);

  assert.equal((await storage.updateMcpServerKnownTools('github', [])).ok, false);
  assert.equal((await storage.updateMcpServerKnownTools('fremd', ['x'])).ok, false);

  const [server] = await storage.readMcpServers();
  assert.deepEqual(server.knownTools, ['search'], 'der bekannte Katalog bleibt stehen');
});

test('das Speichern aus dem Formular loescht den Katalog nicht', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  await storage.updateMcpServerKnownTools('github', ['search', 'create_issue']);

  // Das Formular kennt die Tools nicht, wenn der Server nicht laeuft.
  await storage.saveMcpServer({ ...GITHUB, label: 'GitHub (neu)', env: { GITHUB_TOKEN: { secret: true, keep: true } } });

  const [server] = await storage.readMcpServers();
  assert.equal(server.label, 'GitHub (neu)');
  assert.deepEqual(server.knownTools, ['search', 'create_issue']);
});

// --- Remote servers (#341) ---------------------------------------------------

const BEARER = 'Bearer sk-remote-geheim-1234567890';
const REMOTE = {
  id: 'remote',
  label: 'Remote',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: { value: BEARER }, 'X-Team': { secret: false, value: 'core' } },
};

test('a remote server stores its secret headers encrypted and shows them masked (#341)', async (t) => {
  const { storage, file } = await makeStore(t);
  assert.equal((await storage.saveMcpServer(REMOTE)).ok, true);

  const raw = await fs.readFile(file(), 'utf8');
  assert.equal(raw.includes('sk-remote-geheim'), false, 'the token never sits in the file in plain text');
  assert.match(raw, /core/);

  const [shown] = await storage.readMcpServers();
  assert.equal(shown.transport, 'http');
  assert.equal(shown.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(shown.headers, [
    { key: 'Authorization', secret: true, hasValue: true },
    { key: 'X-Team', secret: false, hasValue: true, value: 'core' },
  ]);
  assert.equal(JSON.stringify(shown).includes('sk-remote-geheim'), false);

  const [runtime] = await storage.getMcpServersForRuntime();
  assert.deepEqual(runtime.headers, { Authorization: BEARER, 'X-Team': 'core' });
  assert.deepEqual(await storage.getMcpSecretValues(), [BEARER]);
});

test('without encryption a secret header is not stored at all (#341)', async (t) => {
  const { storage } = await makeStore(t, { encryption: false });
  const result = await storage.saveMcpServer(REMOTE);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ key: 'mcp.error.noSecureStorage', params: { names: 'Authorization' } }]);
  assert.deepEqual(await storage.readMcpServers(), []);
});

test('a save without a transport keeps the stored one, its address and headers (B16 on #341)', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(REMOTE);
  // What a form that only knows stdio sends when the switch is flipped.
  const result = await storage.saveMcpServer({ id: 'remote', label: 'Remote', command: '', args: [], enabled: false, env: {} });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const [shown] = await storage.readMcpServers();
  assert.equal(shown.transport, 'http');
  assert.equal(shown.url, 'https://mcp.example.com/mcp');
  assert.equal(shown.enabled, false);
  assert.deepEqual((await storage.getMcpServersForRuntime())[0].headers, { Authorization: BEARER, 'X-Team': 'core' });
});

test('keep holds a stored secret header while other fields change (#341)', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(REMOTE);
  const result = await storage.saveMcpServer({
    ...REMOTE,
    label: 'Renamed',
    headers: { Authorization: { secret: true, keep: true } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual((await storage.getMcpServersForRuntime())[0].headers, { Authorization: BEARER });
  const missing = await storage.saveMcpServer({ ...REMOTE, headers: { 'X-Other': { secret: true, keep: true } } });
  assert.deepEqual(missing.errors, [{ key: 'mcp.error.headerKeepMissing', params: { names: 'X-Other' } }]);
});

test('a changed address switches the server off and forgets its tools (#341)', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer({ ...REMOTE, enabled: true });
  await storage.updateMcpServerKnownTools('remote', ['echo', 'add']);

  // The same address keeps both.
  assert.equal((await storage.saveMcpServer({ ...REMOTE, label: 'Same place', enabled: true })).endpointChanged, false);
  let [shown] = await storage.readMcpServers();
  assert.equal(shown.enabled, true);
  assert.deepEqual(shown.knownTools, ['echo', 'add']);

  const moved = await storage.saveMcpServer({ ...REMOTE, url: 'https://other.example.com/mcp', enabled: true, knownTools: ['echo'] });
  assert.equal(moved.ok, true);
  assert.equal(moved.endpointChanged, true);
  [shown] = await storage.readMcpServers();
  assert.equal(shown.url, 'https://other.example.com/mcp');
  assert.equal(shown.enabled, false);
  assert.deepEqual(shown.knownTools, []);
});

test('switching a server between local and remote counts as a changed endpoint (#341)', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  await storage.updateMcpServerKnownTools('github', ['search']);
  const result = await storage.saveMcpServer({ ...REMOTE, id: 'github' });
  assert.equal(result.endpointChanged, true);
  const [shown] = await storage.readMcpServers();
  assert.equal(shown.transport, 'http');
  assert.equal(shown.enabled, false);
  assert.deepEqual(shown.knownTools, []);
  assert.deepEqual(shown.env, [], 'the environment of the local process does not travel along');
});

// --- A local command needs a person at the machine (#1104) ---

const { CONFIRMATION_ACTIONS } = require('../src/application/permissions/user-confirmation');
const { validateMcpServerInput } = require('../src/shared/contracts/mcp');
const { mcpLaunchSubject } = require('../src/main/services/mcp-launch-confirmation');

/** A store wired like the composition root: it redeems only the receipts of `confirmations`. */
async function makeGuardedStore(t) {
  const confirmations = createTestConfirmations();
  const made = await makeStore(t, { confirmationReceipts: confirmations.storeReceipts });
  /** Options for `saveMcpServer` as if the person had allowed exactly this launch. */
  const allowed = (input) => {
    const { value, env } = validateMcpServerInput(input);
    return confirmations.confirmed(CONFIRMATION_ACTIONS.MCP_LAUNCH, mcpLaunchSubject(value, env));
  };
  return { ...made, allowed, confirmed: confirmations.confirmed };
}

test('a new local server is refused without a receipt, and nothing is written (#1104)', async (t) => {
  const { storage, file } = await makeGuardedStore(t);
  const result = await storage.saveMcpServer(GITHUB);
  assert.equal(result.ok, false);
  assert.equal(result.notConfirmed, true);
  assert.equal(result.errors[0].key, 'mcp.error.launchNotConfirmed');
  await assert.rejects(fs.readFile(file()), { code: 'ENOENT' });
  assert.deepEqual(await storage.readMcpServers(), []);
});

test('a receipt for exactly this launch stores the server, and is good once (#1104)', async (t) => {
  const { storage, allowed } = await makeGuardedStore(t);
  const options = allowed(GITHUB);
  assert.equal((await storage.saveMcpServer(GITHUB, options)).ok, true);
  assert.deepEqual((await storage.readMcpServers()).map((s) => s.id), ['github']);
  // The same receipt again, for a changed command: spent.
  const changed = { ...GITHUB, args: ['-y', 'something-else'], env: { GITHUB_TOKEN: { keep: true } } };
  assert.equal((await storage.saveMcpServer(changed, options)).ok, false);
});

test('a receipt for another launch, or for another action, stores nothing (#1104)', async (t) => {
  const { storage, allowed, confirmed } = await makeGuardedStore(t);
  const other = { ...GITHUB, command: 'node', args: ['harmless.js'] };
  assert.equal((await storage.saveMcpServer(GITHUB, allowed(other))).ok, false);
  assert.equal((await storage.saveMcpServer(GITHUB, confirmed(CONFIRMATION_ACTIONS.SHELL_EXECUTION))).ok, false);
  assert.equal((await storage.saveMcpServer(GITHUB, { confirmation: { forged: true } })).ok, false);
  assert.deepEqual(await storage.readMcpServers(), []);
});

test('switching off and on, renaming and the tool catalogue need no receipt; a changed command does (#1104)', async (t) => {
  const { storage, allowed } = await makeGuardedStore(t);
  assert.equal((await storage.saveMcpServer(GITHUB, allowed(GITHUB))).ok, true);
  const kept = { ...GITHUB, env: { GITHUB_TOKEN: { keep: true }, LANG: { secret: false, value: 'de_DE' } } };

  assert.equal((await storage.saveMcpServer({ ...kept, enabled: false })).ok, true);
  assert.equal((await storage.saveMcpServer({ ...kept, enabled: true })).ok, true);
  assert.equal((await storage.saveMcpServer({ ...kept, knownTools: ['search'] })).ok, true);
  assert.equal((await storage.saveMcpServer({ ...kept, label: 'GitHub (work)' })).ok, true);

  for (const changed of [
    { ...kept, command: 'node' },
    { ...kept, args: ['-y', '@evil/server'] },
    { ...kept, cwd: '/tmp' },
    { ...kept, env: { ...kept.env, NODE_OPTIONS: { secret: false, value: '--require /tmp/x.js' } } },
    { ...kept, env: { ...kept.env, LANG: { secret: false, value: 'en_US' } } },
    { ...kept, env: { ...kept.env, GITHUB_TOKEN: { value: 'ghp_new' } } },
  ]) {
    assert.equal((await storage.saveMcpServer(changed)).ok, false, JSON.stringify(changed));
  }
  const [stored] = await storage.readMcpServers();
  assert.equal(stored.command, 'npx');
  assert.equal(stored.label, 'GitHub (work)');
});

test('a remote server starts no process and needs no receipt (#1104)', async (t) => {
  const { storage } = await makeGuardedStore(t);
  assert.equal((await storage.saveMcpServer(REMOTE)).ok, true);
});

test('turning a remote server into a local one needs a receipt (#1104)', async (t) => {
  const { storage } = await makeGuardedStore(t);
  assert.equal((await storage.saveMcpServer(REMOTE)).ok, true);
  const local = { id: REMOTE.id, label: REMOTE.label, transport: 'stdio', command: 'npx', args: ['x'] };
  assert.equal((await storage.saveMcpServer(local)).ok, false);
});

test('the settings decide from the masked list what the store decides from the file (#1104)', async (t) => {
  const { createMcpSettings } = require('../src/main/services/mcp-settings');
  const { storage, confirmed } = await makeGuardedStore(t);
  const settings = createMcpSettings({
    mcpService: { setServers() {}, connect: async () => null, describeConnections: () => [] },
    mcpAdapter: { describeSkippedTools: () => [] },
    mcpConfigStore: storage,
    mcpSecrets: storage,
    ownSecrets: { readMcpSecrets: async () => [] },
    uiPrefsStore: storage,
  });

  const asked = await settings.launchConfirmation(GITHUB);
  assert.deepEqual(asked.server, {
    label: 'GitHub', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], cwd: '', envKeys: ['GITHUB_TOKEN', 'LANG'],
  });
  const options = confirmed(CONFIRMATION_ACTIONS.MCP_LAUNCH, asked.subject);
  assert.equal((await settings.save(GITHUB, options)).ok, true);

  // What the window sends back for a switch or a rename: kept secrets, the plain value as shown.
  const [listed] = await storage.readMcpServers();
  const toggled = {
    id: listed.id, label: 'Renamed', transport: listed.transport, command: listed.command, args: listed.args,
    cwd: listed.cwd, env: { GITHUB_TOKEN: { keep: true }, LANG: { keep: true, secret: false } }, enabled: false,
  };
  assert.equal(await settings.launchConfirmation(toggled), null);
  assert.equal((await settings.save(toggled)).ok, true);
  assert.notEqual(await settings.launchConfirmation({ ...toggled, args: ['other'] }), null);
});

test('an add with a taken identifier asks nothing; the store refuses it as taken (#1104)', async (t) => {
  const { createMcpSettings } = require('../src/main/services/mcp-settings');
  const { storage, allowed } = await makeGuardedStore(t);
  assert.equal((await storage.saveMcpServer(GITHUB, allowed(GITHUB))).ok, true);
  const settings = createMcpSettings({
    mcpService: { setServers() {} }, mcpAdapter: {}, mcpConfigStore: storage, mcpSecrets: storage,
    ownSecrets: { readMcpSecrets: async () => [] }, uiPrefsStore: storage,
  });
  const add = { ...GITHUB, command: 'node', create: true };
  assert.equal(await settings.launchConfirmation(add), null);
  assert.equal((await settings.save(add)).errors[0].key, 'mcp.error.idExists');
});
