// Shell-/Clipboard-Kanaele (Issue #64).
//
// Hintergrund: Das Hauptfenster laeuft mit `sandbox: true`. Ein sandboxed
// Preload bekommt aus 'electron' kein `shell` und kein `clipboard`, ein
// direkter Aufruf dort scheitert still. Beides laeuft deshalb ueber den Main.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { registerShellHandlers, isOpenableUrl } = require('../src/main/ipc/shell-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');

function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Kein Handler für ${channel}`);
      return handler({}, ...args);
    },
  };
}

function setup({ openExternal, clipboard } = {}) {
  const opened = [];
  const ipcMain = makeIpcMain();
  registerShellHandlers({
    ipcMain,
    shell: {
      async openExternal(url) {
        opened.push(url);
        if (openExternal) return openExternal(url);
        return undefined;
      },
    },
    clipboard: clipboard === undefined ? { writeText() {} } : clipboard,
    REQ,
  });
  return { ipcMain, opened };
}

test('isOpenableUrl lässt nur http und https durch', () => {
  assert.equal(isOpenableUrl('https://github.com/kkrafft1999/snotra/releases'), true);
  assert.equal(isOpenableUrl('http://localhost:3000'), true);
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'ftp://example.com',
    'nicht mal eine URL',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isOpenableUrl(bad), false, String(bad));
  }
});

test('openExternal öffnet http- und https-Links über die Shell', async () => {
  const { ipcMain, opened } = setup();
  const url = 'https://github.com/kkrafft1999/snotra/releases/tag/v1.2.0';

  assert.deepEqual(await ipcMain.invoke(REQ.SHELL_OPEN_EXTERNAL, url), { ok: true });
  assert.deepEqual(opened, [url]);
});

test('openExternal weist andere Protokolle ab, ohne die Shell zu rufen', async () => {
  const { ipcMain, opened } = setup();

  const result = await ipcMain.invoke(REQ.SHELL_OPEN_EXTERNAL, 'file:///etc/passwd');
  assert.equal(result.ok, false);
  assert.match(result.error, /http/);
  assert.deepEqual(opened, [], 'die Shell darf gar nicht erst gerufen werden');
});

test('openExternal meldet einen Fehler der Shell zurück, statt still zu scheitern', async () => {
  const { ipcMain } = setup({
    openExternal() {
      throw new Error('Kein Standardbrowser gesetzt.');
    },
  });

  const result = await ipcMain.invoke(REQ.SHELL_OPEN_EXTERNAL, 'https://example.com');
  assert.deepEqual(result, { ok: false, error: 'Kein Standardbrowser gesetzt.' });
});

test('writeClipboardText schreibt Text und meldet fehlende Zwischenablage', async () => {
  const written = [];
  const { ipcMain } = setup({ clipboard: { writeText: (t) => written.push(t) } });

  assert.deepEqual(await ipcMain.invoke(REQ.SHELL_WRITE_CLIPBOARD_TEXT, 'hallo'), { ok: true });
  assert.deepEqual(written, ['hallo']);

  const ohne = setup({ clipboard: null });
  const result = await ohne.ipcMain.invoke(REQ.SHELL_WRITE_CLIPBOARD_TEXT, 'x');
  assert.equal(result.ok, false);
});

// Ab Electron 44 ist `clipboard.writeText` asynchron. Ohne `await` im Handler
// liefe die Ablehnung am try/catch vorbei: der Aufrufer bekaeme `ok: true`,
// obwohl nichts kopiert wurde, und der Fehler landete als unhandled rejection.
test('writeClipboardText meldet einen Fehler, wenn das Schreiben asynchron fehlschlaegt', async () => {
  const { ipcMain } = setup({
    clipboard: { writeText: () => Promise.reject(new Error('Zwischenablage gesperrt.')) },
  });

  const result = await ipcMain.invoke(REQ.SHELL_WRITE_CLIPBOARD_TEXT, 'hallo');
  assert.deepEqual(result, { ok: false, error: 'Zwischenablage gesperrt.' });
});

// Der Handler muss auf das Promise warten, sonst kann er den Erfolg gar nicht
// kennen. Wir loesen erst nach einem Tick auf und pruefen, dass die Antwort
// danach kommt.
test('writeClipboardText wartet auf das Promise von writeText', async () => {
  let resolveWrite;
  const written = [];
  const { ipcMain } = setup({
    clipboard: {
      writeText: (t) => new Promise((resolve) => {
        resolveWrite = () => {
          written.push(t);
          resolve();
        };
      }),
    },
  });

  const pending = ipcMain.invoke(REQ.SHELL_WRITE_CLIPBOARD_TEXT, 'spaet');
  assert.deepEqual(written, [], 'vor dem Aufloesen darf nichts geschrieben sein');
  resolveWrite();

  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(written, ['spaet']);
});

// Regressionssperre: genau dieser Import hat den Bug verursacht. Im sandboxed
// Preload existieren nur die hier erlaubten Member von 'electron'.
test('das Preload importiert nur Module, die es im Sandbox-Modus gibt', () => {
  const SANDBOX_SAFE = new Set([
    'contextBridge',
    'crashReporter',
    'ipcRenderer',
    'nativeImage',
    'sharedTexture',
    'webFrame',
    'webUtils',
  ]);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf8');
  const match = source.match(/const\s*\{([^}]+)\}\s*=\s*require\(\s*'electron'\s*\)/);
  assert.ok(match, 'Preload muss electron per Destructuring importieren');
  const imported = match[1]
    .split(',')
    .map((name) => name.split(':')[0].trim())
    .filter(Boolean);
  const forbidden = imported.filter((name) => !SANDBOX_SAFE.has(name));
  assert.deepEqual(
    forbidden,
    [],
    `Im sandboxed Preload nicht verfügbar: ${forbidden.join(', ')} — über IPC in den Main verlagern.`
  );
});

test('das erzeugte Preload-Bundle ist auf dem Stand der Quelle', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'bundle.js'), 'utf8');
  assert.match(bundle, /SHELL_OPEN_EXTERNAL/, 'npm run sync-vendor nach Preload-Änderungen ausführen');
  assert.doesNotMatch(bundle, /shell\.openExternal/);
});
