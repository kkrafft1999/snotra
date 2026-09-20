// Bilder aus dem Arbeitsordner, Main-Seite (Issue #244).
//
// Hier liegt die Vertrauensgrenze: Welcher Pfad aufgeloest wird, welcher nicht,
// und was ein Ergebnis ueberhaupt enthaelt. Deshalb gegen echte Dateien statt
// gegen ein nachgebautes fs — ein Symlink, der aus dem Workspace zeigt, ist nur
// als echter Symlink ein Beweis.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const {
  MAX_WORKSPACE_IMAGE_BYTES,
  WORKSPACE_IMAGE_ERRORS,
} = require('../src/shared/contracts/workspace-image');

/** Ein gueltiges 1x1-PNG — klein genug, um es im Test zu halten. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeFsService() {
  return createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
}

async function makeWorkspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-ws-image-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // `realpath`, weil /tmp unter macOS selbst ein Symlink ist: Ohne das wuerde
  // schon der Normalfall als Ausbruch gelesen.
  return fs.realpath(dir);
}

async function createSymlinkOrSkip(t, target, linkPath) {
  try {
    await fs.symlink(target, linkPath);
    return true;
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) {
      t.skip(`Symlinks werden auf dieser Plattform nicht unterstützt: ${e.code}`);
      return false;
    }
    throw e;
  }
}

test('ein PNG im Workspace kommt ueber den relativen und den absoluten Pfad', async (t) => {
  const root = await makeWorkspace(t);
  await fs.mkdir(path.join(root, 'bilder'));
  const file = path.join(root, 'bilder', 'plot.png');
  await fs.writeFile(file, PNG_1PX);
  const svc = makeFsService();

  const relativ = await svc.readWorkspaceImage(root, 'bilder/plot.png');
  assert.equal(relativ.ok, true);
  assert.equal(relativ.mime, 'image/png');
  assert.equal(relativ.base64, PNG_1PX.toString('base64'));
  assert.equal(relativ.size, PNG_1PX.length);
  assert.ok(relativ.mtimeMs > 0, 'die mtime kommt mit');

  // So schreibt ein Modell es in der Praxis meistens hin.
  const absolut = await svc.readWorkspaceImage(root, file);
  assert.equal(absolut.ok, true);
  assert.equal(absolut.base64, relativ.base64);

  // Windows schreibt Backslashes; `path.resolve` muss beides annehmen.
  const nativ = await svc.readWorkspaceImage(root, path.join('bilder', 'plot.png'));
  assert.equal(nativ.ok, true);
});

test('ohne geoeffneten Ordner gibt es nichts zu holen', async () => {
  const svc = makeFsService();
  assert.equal((await svc.readWorkspaceImage(null, 'x.png')).reason, WORKSPACE_IMAGE_ERRORS.NO_WORKSPACE);
  assert.equal((await svc.readWorkspaceImage('  ', 'x.png')).reason, WORKSPACE_IMAGE_ERRORS.NO_WORKSPACE);
});

test('Pfade ausserhalb des Workspace werden nicht geladen', async (t) => {
  const root = await makeWorkspace(t);
  const aussen = await makeWorkspace(t);
  await fs.writeFile(path.join(aussen, 'geheim.png'), PNG_1PX);
  const svc = makeFsService();

  for (const p of ['../geheim.png', path.join(aussen, 'geheim.png'), '..']) {
    const result = await svc.readWorkspaceImage(root, p);
    assert.equal(result.ok, false, p);
    assert.equal(result.reason, WORKSPACE_IMAGE_ERRORS.OUTSIDE_WORKSPACE, p);
  }
});

test('ein Symlink, der aus dem Workspace zeigt, faellt durch', async (t) => {
  const root = await makeWorkspace(t);
  const aussen = await makeWorkspace(t);
  const ziel = path.join(aussen, 'geheim.png');
  await fs.writeFile(ziel, PNG_1PX);
  const link = path.join(root, 'sieht-harmlos-aus.png');
  if (!(await createSymlinkOrSkip(t, ziel, link))) return;

  const svc = makeFsService();
  const result = await svc.readWorkspaceImage(root, 'sieht-harmlos-aus.png');
  // Lexikalisch liegt der Pfad im Workspace — nur `realpath` faengt das.
  assert.equal(result.ok, false);
  assert.equal(result.reason, WORKSPACE_IMAGE_ERRORS.OUTSIDE_WORKSPACE);
});

test('ein Symlink innerhalb des Workspace bleibt erlaubt', async (t) => {
  const root = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'echt.png'), PNG_1PX);
  const link = path.join(root, 'verweis.png');
  if (!(await createSymlinkOrSkip(t, path.join(root, 'echt.png'), link))) return;

  const result = await makeFsService().readWorkspaceImage(root, 'verweis.png');
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/png');
});

test('SVG und unbekannte Typen enden als Grund, nicht als Bild', async (t) => {
  const root = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'diagramm.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // Die Endung luegt: Inhalt ist Text, Name ist .png.
  await fs.writeFile(path.join(root, 'gelogen.png'), 'kein Bild');
  const svc = makeFsService();

  for (const name of ['diagramm.svg', 'gelogen.png']) {
    const result = await svc.readWorkspaceImage(root, name);
    assert.equal(result.ok, false, name);
    assert.equal(result.reason, WORKSPACE_IMAGE_ERRORS.UNSUPPORTED_TYPE, name);
  }
});

test('eine fehlende Datei und ein Ordner sind beide „nicht gefunden“', async (t) => {
  const root = await makeWorkspace(t);
  await fs.mkdir(path.join(root, 'bilder'));
  const svc = makeFsService();

  assert.equal((await svc.readWorkspaceImage(root, 'gibtsnicht.png')).reason, WORKSPACE_IMAGE_ERRORS.NOT_FOUND);
  assert.equal((await svc.readWorkspaceImage(root, 'bilder')).reason, WORKSPACE_IMAGE_ERRORS.NOT_FOUND);
  assert.equal((await svc.readWorkspaceImage(root, '')).reason, WORKSPACE_IMAGE_ERRORS.NOT_FOUND);
  assert.equal((await svc.readWorkspaceImage(root, null)).reason, WORKSPACE_IMAGE_ERRORS.NOT_FOUND);
});

test('ein haengender Symlink meldet nichts anderes als eine fehlende Datei', async (t) => {
  const root = await makeWorkspace(t);
  const link = path.join(root, 'ins-leere.png');
  if (!(await createSymlinkOrSkip(t, path.join(root, 'weg.png'), link))) return;

  const result = await makeFsService().readWorkspaceImage(root, 'ins-leere.png');
  assert.equal(result.reason, WORKSPACE_IMAGE_ERRORS.NOT_FOUND);
});

test('ueber dem Groessenlimit wird gar nicht erst gelesen', async (t) => {
  const root = await makeWorkspace(t);
  const gross = path.join(root, 'riesig.png');
  // Nur der Kopf ist echt; der Rest ist Fuellung bis knapp ueber das Limit.
  await fs.writeFile(gross, Buffer.concat([PNG_1PX, Buffer.alloc(MAX_WORKSPACE_IMAGE_BYTES)]));

  const result = await makeFsService().readWorkspaceImage(root, 'riesig.png');
  assert.equal(result.ok, false);
  assert.equal(result.reason, WORKSPACE_IMAGE_ERRORS.TOO_LARGE);
});
