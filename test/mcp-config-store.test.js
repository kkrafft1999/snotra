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

async function makeStore(t, { encryption = true } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-mcp-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const storage = createStorageService({
    app: { getPath: () => tmpDir },
    safeStorage: fakeSafeStorage(encryption),
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions: 3,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
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

test('keep auf einen unbekannten Schlüssel legt nichts an', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer({ id: 'x', command: 'npx', env: { NEU: { keep: true } } });
  const [server] = await storage.getMcpServersForRuntime();
  assert.deepEqual(server.env, {});
});

test('ein zweites Speichern ersetzt den Server, statt ihn zu verdoppeln', async (t) => {
  const { storage } = await makeStore(t);
  await storage.saveMcpServer(GITHUB);
  await storage.saveMcpServer({ ...GITHUB, label: 'Neu', env: { GITHUB_TOKEN: { keep: true } } });

  const servers = await storage.readMcpServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].label, 'Neu');
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
  assert.match(nochmal.errors.join(' '), /Unbekannter MCP-Server/);
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
  assert.match(result.errors.join(' '), /GITHUB_TOKEN/);
  // Die Meldung nennt den Schlüssel, niemals den Wert.
  assert.equal(result.errors.join(' ').includes(TOKEN), false);
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
