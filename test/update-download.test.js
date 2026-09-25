// Download des Update-Pakets (Issue #232).
//
// Die drei Dinge, die hier schiefgehen koennen und beim Nutzer teuer waeren:
// von der falschen Adresse laden, eine abgeschnittene Datei fuer fertig halten,
// und nach einem Abbruch einen Torso liegen lassen, der beim naechsten Mal als
// fertiger Download durchginge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { translateMessage } = require('../src/shared/i18n');

// Main hands over keys since #353; the German wording is checked through the
// catalogue.
const de = (message) => translateMessage('de', message);

const {
  createUpdateDownloader,
  isAllowedAssetUrl,
  safeFileName,
} = require('../src/main/services/update-download');

const GITHUB_URL = 'https://objects.githubusercontent.com/snotra.dmg';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-dl-test-'));
}

/** Antwort, die `chunks` als Web-Stream liefert — so wie fetch es tut. */
function makeResponse(chunks, { ok = true, status = 200, contentLength } = {}) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const headers = new Map([['content-length', String(contentLength ?? total)]]);
  return {
    ok,
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    body: Readable.toWeb(Readable.from(chunks)),
  };
}

test('isAllowedAssetUrl laesst nur HTTPS bei GitHub zu', () => {
  assert.equal(isAllowedAssetUrl('https://github.com/a/b/releases/download/v1/x.dmg'), true);
  assert.equal(isAllowedAssetUrl('https://objects.githubusercontent.com/x.dmg'), true);
  assert.equal(isAllowedAssetUrl('http://github.com/x.dmg'), false, 'kein HTTP');
  assert.equal(isAllowedAssetUrl('https://github.com.angreifer.example/x.dmg'), false);
  assert.equal(isAllowedAssetUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedAssetUrl('nicht mal eine URL'), false);
});

test('safeFileName entfernt Pfadanteile aus dem fremden Namen', () => {
  assert.equal(safeFileName('Snotra-AI-1.8.0-mac-arm64.dmg'), 'Snotra-AI-1.8.0-mac-arm64.dmg');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('/abs/olut/x y.dmg'), 'x_y.dmg');
  assert.equal(safeFileName(''), 'snotra-update.bin');
});

test('ein vollstaendiger Download landet auf der Platte und meldet Fortschritt', async () => {
  const tempDir = makeTempDir();
  const chunks = [Buffer.alloc(1024, 1), Buffer.alloc(2048, 2)];
  const downloader = createUpdateDownloader({
    tempDir,
    fetchImpl: async () => makeResponse(chunks),
  });

  const seen = [];
  const result = await downloader.download({
    asset: { url: GITHUB_URL, name: 'snotra.dmg', size: 3072 },
    version: '1.8.0',
    onProgress: (p) => seen.push(p),
  });

  assert.equal(result.ok, true);
  assert.equal(result.bytes, 3072);
  assert.equal(path.basename(result.filePath), 'snotra.dmg');
  assert.equal(fs.statSync(result.filePath).size, 3072);
  assert.deepEqual(downloader.getReady(), {
    filePath: result.filePath, version: '1.8.0', assetName: 'snotra.dmg', bytes: 3072,
  });
  // Mindestens Anfang und Ende; die Zwischenstaende sind zeitlich gedrosselt.
  assert.ok(seen.length >= 2, `Fortschritt gemeldet: ${seen.length}`);
  assert.equal(seen.at(-1).receivedBytes, 3072);
  assert.equal(seen.at(-1).totalBytes, 3072);

  await downloader.discard();
});

test('eine fremde Adresse wird gar nicht erst abgerufen', async () => {
  const tempDir = makeTempDir();
  let called = false;
  const downloader = createUpdateDownloader({
    tempDir,
    fetchImpl: async () => { called = true; return makeResponse([Buffer.alloc(8)]); },
  });

  const result = await downloader.download({
    asset: { url: 'https://angreifer.example/snotra.dmg', name: 'snotra.dmg', size: 8 },
    version: '1.8.0',
  });

  assert.equal(result.ok, false);
  assert.match(de(result.error), /GitHub-Releases/);
  assert.equal(called, false, 'es darf kein Abruf stattgefunden haben');
});

test('eine abgeschnittene Antwort gilt als Fehler, nicht als fertiger Download', async () => {
  const tempDir = makeTempDir();
  const downloader = createUpdateDownloader({
    tempDir,
    // Der Server verspricht 3072 Bytes und liefert 1024.
    fetchImpl: async () => makeResponse([Buffer.alloc(1024, 3)], { contentLength: 3072 }),
  });

  const result = await downloader.download({
    asset: { url: GITHUB_URL, name: 'snotra.dmg', size: 3072 },
    version: '1.8.0',
  });

  assert.equal(result.ok, false);
  assert.match(de(result.error), /unvollständig/);
  assert.equal(downloader.getReady(), null);
  assert.equal(fs.existsSync(downloader.getWorkDir()), false, 'der Torso muss weg sein');
});

test('HTTP-Fehler werden gemeldet statt geworfen', async () => {
  const tempDir = makeTempDir();
  const downloader = createUpdateDownloader({
    tempDir,
    fetchImpl: async () => makeResponse([], { ok: false, status: 404 }),
  });

  const result = await downloader.download({
    asset: { url: GITHUB_URL, name: 'snotra.dmg', size: 1 },
    version: '1.8.0',
  });
  assert.equal(result.ok, false);
  assert.match(de(result.error), /HTTP 404/);
});

test('cancel bricht den laufenden Download ab und raeumt auf', async () => {
  const tempDir = makeTempDir();
  const downloader = createUpdateDownloader({
    tempDir,
    fetchImpl: async (_url, options) => {
      // Ein Strom, der erst endet, wenn der Abbruch kommt.
      const stream = new Readable({ read() {} });
      stream.push(Buffer.alloc(512, 9));
      options.signal.addEventListener('abort', () => stream.destroy(new Error('aborted')));
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(1 << 20) },
        body: Readable.toWeb(stream),
      };
    },
  });

  const pending = downloader.download({
    asset: { url: GITHUB_URL, name: 'snotra.dmg', size: 1 << 20 },
    version: '1.8.0',
  });
  // Dem Download einen Tick geben, damit der Controller steht.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(downloader.cancel(), true);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  assert.equal(downloader.getReady(), null);
  assert.equal(fs.existsSync(downloader.getWorkDir()), false);
  assert.equal(downloader.cancel(), false, 'ohne laufenden Download passiert nichts');
});

test('discard loescht die geladene Datei wieder', async () => {
  const tempDir = makeTempDir();
  const downloader = createUpdateDownloader({
    tempDir,
    fetchImpl: async () => makeResponse([Buffer.alloc(64, 4)]),
  });
  await downloader.download({
    asset: { url: GITHUB_URL, name: 'snotra.dmg', size: 64 },
    version: '1.8.0',
  });
  assert.ok(downloader.getReady());

  await downloader.discard();
  assert.equal(downloader.getReady(), null);
  assert.equal(fs.existsSync(downloader.getWorkDir()), false);
});

test('ein neuer Lauf raeumt Reste des vorigen weg', async () => {
  const tempDir = makeTempDir();
  const downloader = createUpdateDownloader({
    tempDir,
    fetchImpl: async () => makeResponse([Buffer.alloc(32, 5)]),
  });
  await fsp.mkdir(downloader.getWorkDir(), { recursive: true });
  const leftover = path.join(downloader.getWorkDir(), 'alt.partial');
  await fsp.writeFile(leftover, 'Rest');

  await downloader.download({
    asset: { url: GITHUB_URL, name: 'snotra.dmg', size: 32 },
    version: '1.8.0',
  });

  assert.equal(fs.existsSync(leftover), false);
  await downloader.discard();
});
