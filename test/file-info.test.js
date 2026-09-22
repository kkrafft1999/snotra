const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFileInfo,
  createDefaultAppResolver,
  formatFields,
  formatSize,
  formatTimestamp,
  groupDigits,
} = require('../src/main/services/file-info');

/** Minimaler Stat-Doppelgänger — nur das, was describe() anfasst. */
function statLike({ size = 0, mtime = null, birthtime = null, directory = false, symlink = false } = {}) {
  return {
    size,
    mtime,
    birthtime,
    isDirectory: () => directory,
    isSymbolicLink: () => symlink,
  };
}

function fsStub(map) {
  return {
    lstat: async (p) => {
      if (!(p in map)) throw new Error(`ENOENT: ${p}`);
      return map[p].lstat;
    },
    stat: async (p) => {
      if (!map[p]?.stat) throw new Error(`ENOENT: ${p}`);
      return map[p].stat;
    },
    readdir: async (p) => {
      if (!map[p]?.entries) throw new Error(`ENOTDIR: ${p}`);
      return map[p].entries;
    },
    readlink: async (p) => map[p]?.link ?? '',
    readFile: async (p) => {
      if (!map[p]?.content) throw new Error(`ENOENT: ${p}`);
      return map[p].content;
    },
  };
}

const noApp = { resolve: async () => null };

test('groupDigits: Punkte auf Deutsch, Kommas auf Englisch (#292)', () => {
  assert.equal(groupDigits(0, 'de'), '0');
  assert.equal(groupDigits(999, 'de'), '999');
  assert.equal(groupDigits(1000, 'de'), '1.000');
  assert.equal(groupDigits(1468006, 'de'), '1.468.006');

  assert.equal(groupDigits(1000, 'en'), '1,000');
  assert.equal(groupDigits(1468006, 'en'), '1,468,006');
});

test('formatSize: lesbar plus exakt, unter 1 KB nur die Byte-Zahl (#123)', () => {
  assert.equal(formatSize(1468006, 'de'), '1,4 MB (1.468.006 Bytes)');
  assert.equal(formatSize(0, 'de'), '0 Bytes');
  assert.equal(formatSize(1, 'de'), '1 Byte');
  assert.equal(formatSize(512, 'de'), '512 Bytes');
  assert.equal(formatSize(1024, 'de'), '1,0 KB (1.024 Bytes)');
});

test('formatSize: auf Englisch wandern Trennzeichen und Einheit mit (#292)', () => {
  assert.equal(formatSize(1468006, 'en'), '1.4 MB (1,468,006 bytes)');
  assert.equal(formatSize(0, 'en'), '0 bytes');
  assert.equal(formatSize(1, 'en'), '1 byte');
  assert.equal(formatSize(512, 'en'), '512 bytes');
  assert.equal(formatSize(1024, 'en'), '1.0 KB (1,024 bytes)');
});

test('formatSize: unbrauchbare Werte werden „unbekannt“, nicht NaN (#123)', () => {
  assert.equal(formatSize(undefined, 'de'), 'unbekannt');
  assert.equal(formatSize(NaN, 'de'), 'unbekannt');
  assert.equal(formatSize(-1, 'de'), 'unbekannt');
  assert.equal(formatSize(NaN, 'en'), 'unknown');
});

test('formatTimestamp: deutsches Datum, kein „Invalid Date“ (#123)', () => {
  assert.equal(formatTimestamp(new Date(2026, 8, 21, 14, 32), 'de'), '21.09.2026, 14:32');
  assert.equal(formatTimestamp(new Date(2026, 0, 5, 9, 7), 'de'), '05.01.2026, 09:07');
  // birthtime ist unter Linux/ext4 oft 0 bzw. die Epoche.
  assert.equal(formatTimestamp(new Date(0), 'de'), 'unbekannt');
  assert.equal(formatTimestamp(null, 'de'), 'unbekannt');
  assert.equal(formatTimestamp(undefined, 'de'), 'unbekannt');
  assert.equal(formatTimestamp(new Date('quatsch'), 'de'), 'unbekannt');
});

test('formatTimestamp: englisch in ISO-Reihenfolge, damit der Tag eindeutig bleibt (#292)', () => {
  assert.equal(formatTimestamp(new Date(2026, 8, 21, 14, 32), 'en'), '2026-09-21, 14:32');
  assert.equal(formatTimestamp(new Date(2026, 0, 5, 9, 7), 'en'), '2026-01-05, 09:07');
  assert.equal(formatTimestamp(new Date(0), 'en'), 'unknown');
  assert.equal(formatTimestamp(null, 'en'), 'unknown');
});

test('formatFields: eine Zeile je Feld, Label mit Doppelpunkt', () => {
  assert.equal(formatFields([['Name', 'a.txt'], ['Pfad', '/ws/a.txt']]), 'Name: a.txt\nPfad: /ws/a.txt');
});

test('describe für eine Datei: Name, Pfad, Typ, Größe, Daten, Öffnen mit (#123)', async () => {
  const fs = fsStub({
    '/ws/notiz.md': {
      lstat: statLike({ size: 1468006, mtime: new Date(2026, 8, 21, 14, 32), birthtime: new Date(2026, 8, 20, 9, 1) }),
    },
  });
  const info = createFileInfo({ fs, defaultAppResolver: { resolve: async () => 'TextEdit' } });
  const result = await info.describe('/ws/notiz.md', { locale: 'de' });
  assert.deepEqual(result.fields, [
    ['Name', 'notiz.md'],
    ['Pfad', '/ws/notiz.md'],
    ['Typ', 'Datei (.md)'],
    ['Größe', '1,4 MB (1.468.006 Bytes)'],
    ['Geändert', '21.09.2026, 14:32'],
    ['Erstellt', '20.09.2026, 09:01'],
    ['Öffnen mit', 'TextEdit'],
  ]);
  assert.equal(result.name, 'notiz.md');
  assert.equal(result.path, '/ws/notiz.md');
});

test('describe auf Englisch: Feldnamen, Typ, Zahlen und Datum wandern mit (#292)', async () => {
  const fs = fsStub({
    '/ws/notiz.md': {
      lstat: statLike({ size: 1468006, mtime: new Date(2026, 8, 21, 14, 32), birthtime: new Date(2026, 8, 20, 9, 1) }),
    },
  });
  const info = createFileInfo({ fs, defaultAppResolver: { resolve: async () => 'TextEdit' } });
  assert.deepEqual((await info.describe('/ws/notiz.md', { locale: 'en' })).fields, [
    ['Name', 'notiz.md'],
    ['Path', '/ws/notiz.md'],
    ['Type', 'File (.md)'],
    ['Size', '1.4 MB (1,468,006 bytes)'],
    ['Modified', '2026-09-21, 14:32'],
    ['Created', '2026-09-20, 09:01'],
    ['Opens with', 'TextEdit'],
  ]);
  // Ohne Angabe gilt die Voreinstellung des Katalogs, nicht die letzte Wahl.
  assert.deepEqual(
    (await info.describe('/ws/notiz.md')).fields,
    (await info.describe('/ws/notiz.md', { locale: 'en' })).fields,
  );
});

test('describe für einen Ordner: Anzahl direkter Einträge statt Größe, kein „Öffnen mit“ (#123)', async () => {
  const fs = fsStub({
    '/ws/unterlagen': {
      lstat: statLike({ directory: true, mtime: new Date(2026, 8, 21, 8, 0), birthtime: new Date(2026, 7, 1, 12, 0) }),
      entries: ['a', 'b', 'c'],
    },
  });
  const info = createFileInfo({ fs, defaultAppResolver: noApp });
  const result = await info.describe('/ws/unterlagen', { isDirectory: true, locale: 'de' });
  assert.deepEqual(result.fields, [
    ['Name', 'unterlagen'],
    ['Pfad', '/ws/unterlagen'],
    ['Typ', 'Ordner'],
    ['Inhalt', '3 Einträge (direkt)'],
    ['Geändert', '21.09.2026, 08:00'],
    ['Erstellt', '01.08.2026, 12:00'],
  ]);

  const english = await info.describe('/ws/unterlagen', { isDirectory: true, locale: 'en' });
  assert.deepEqual(english.fields[2], ['Type', 'Folder']);
  assert.deepEqual(english.fields[3], ['Contents', '3 entries (direct)']);
});

test('describe: der Zähler folgt dem Numerus, in beiden Sprachen (#292)', async () => {
  const fs = fsStub({ '/ws/einer': { lstat: statLike({ directory: true }), entries: ['a'] } });
  const info = createFileInfo({ fs, defaultAppResolver: noApp });
  const contents = async (locale) => (await info.describe('/ws/einer', { isDirectory: true, locale }))
    .fields[3][1];
  assert.equal(await contents('de'), '1 Eintrag (direkt)');
  assert.equal(await contents('en'), '1 entry (direct)');
});

test('describe: nicht lesbares Verzeichnis meldet „unbekannt“ statt zu werfen (#123)', async () => {
  const fs = fsStub({ '/ws/gesperrt': { lstat: statLike({ directory: true }) } });
  const info = createFileInfo({ fs, defaultAppResolver: noApp });
  const result = await info.describe('/ws/gesperrt', { isDirectory: true, locale: 'de' });
  assert.deepEqual(result.fields.find(([l]) => l === 'Inhalt'), ['Inhalt', 'unbekannt']);
  const english = await info.describe('/ws/gesperrt', { isDirectory: true, locale: 'en' });
  assert.deepEqual(english.fields.find(([l]) => l === 'Contents'), ['Contents', 'unknown']);
});

test('describe: Symlink nennt das Ziel, Größe kommt vom Ziel (#123)', async () => {
  const fs = fsStub({
    '/ws/link': {
      lstat: statLike({ symlink: true, size: 12 }),
      stat: statLike({ size: 2048, mtime: new Date(2026, 8, 1, 10, 0) }),
      link: '../ziel.txt',
    },
  });
  const info = createFileInfo({ fs, defaultAppResolver: noApp });
  const result = await info.describe('/ws/link', { locale: 'de' });
  assert.deepEqual(result.fields[2], ['Typ', 'Verknüpfung → ../ziel.txt auf Datei']);
  assert.deepEqual(result.fields[3], ['Größe', '2,0 KB (2.048 Bytes)']);

  const english = await info.describe('/ws/link', { locale: 'en' });
  assert.deepEqual(english.fields[2], ['Type', 'Symlink → ../ziel.txt, to a file']);
  assert.deepEqual(english.fields[3], ['Size', '2.0 KB (2,048 bytes)']);
});

test('describe: toter Symlink bleibt auskunftsfähig, Größe „unbekannt“ (#123)', async () => {
  const fs = fsStub({
    '/ws/tot': { lstat: statLike({ symlink: true, mtime: new Date(2026, 8, 2, 11, 0) }), link: '/weg' },
  });
  const info = createFileInfo({ fs, defaultAppResolver: noApp });
  const result = await info.describe('/ws/tot', { locale: 'de' });
  assert.deepEqual(result.fields[2], ['Typ', 'Verknüpfung → /weg (Ziel nicht erreichbar)']);
  assert.deepEqual(result.fields[3], ['Größe', 'unbekannt']);
  assert.deepEqual(result.fields.at(-1), ['Öffnen mit', 'unbekannt']);

  const english = await info.describe('/ws/tot', { locale: 'en' });
  assert.deepEqual(english.fields[2], ['Type', 'Symlink → /weg (target unreachable)']);
});

test('describe: ein Symlink ohne lesbares Ziel bleibt ein ganzer Satz (#292)', async () => {
  // readlink liefert '' — ein „→“ ins Leere sähe nach einem Fehler aus.
  const fs = fsStub({ '/ws/ohne': { lstat: statLike({ symlink: true }), stat: statLike({ size: 8 }) } });
  const info = createFileInfo({ fs, defaultAppResolver: noApp });
  assert.deepEqual((await info.describe('/ws/ohne', { locale: 'de' })).fields[2], ['Typ', 'Verknüpfung auf Datei']);
  assert.deepEqual((await info.describe('/ws/ohne', { locale: 'en' })).fields[2], ['Type', 'Symlink to a file']);
});

test('describe: fehlgeschlagenes stat liefert error statt einer Exception (#123)', async () => {
  const info = createFileInfo({ fs: fsStub({}), defaultAppResolver: noApp });
  const result = await info.describe('/ws/weg.txt');
  assert.match(result.error, /ENOENT/);
  assert.equal(result.fields, undefined);
});

test('describe: nicht ermittelbares Standardprogramm wird „unbekannt“ (#123)', async () => {
  const fs = fsStub({ '/ws/a.bin': { lstat: statLike({ size: 4 }) } });
  const info = createFileInfo({ fs, defaultAppResolver: { resolve: async () => null } });
  const result = await info.describe('/ws/a.bin', { locale: 'de' });
  assert.deepEqual(result.fields.at(-1), ['Öffnen mit', 'unbekannt']);
  assert.deepEqual(result.fields[2], ['Typ', 'Datei (.bin)']);
});

test('describe: Datei ohne Endung bekommt keinen leeren Klammerzusatz', async () => {
  const fs = fsStub({ '/ws/LICENSE': { lstat: statLike({ size: 10 }) } });
  const info = createFileInfo({ fs, defaultAppResolver: noApp });
  assert.deepEqual((await info.describe('/ws/LICENSE', { locale: 'de' })).fields[2], ['Typ', 'Datei']);
  assert.deepEqual((await info.describe('/ws/LICENSE', { locale: 'en' })).fields[2], ['Type', 'File']);
});

test('Standardprogramm macOS: NSWorkspace statt Finder, Ergebnis ohne „.app“ (#123)', async () => {
  const calls = [];
  const resolver = createDefaultAppResolver({
    platform: 'darwin',
    execFile: (cmd, args, opts, cb) => {
      calls.push({ cmd, args });
      cb(null, 'TextEdit.app\n');
    },
  });
  assert.equal(await resolver.resolve('/ws/a.md'), 'TextEdit');
  assert.equal(calls[0].cmd, 'osascript');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  const script = calls[0].args[3];
  assert.match(script, /URLForApplicationToOpenURL/);
  // Kein Apple Event an den Finder — das bräuchte die Automatisierungs-Freigabe.
  assert.doesNotMatch(script, /tell application/);
  assert.match(script, /"\/ws\/a\.md"/);
});

test('Standardprogramm macOS: Sonderzeichen im Pfad bleiben im Skript gültig (#123)', async () => {
  let script = '';
  const resolver = createDefaultAppResolver({
    platform: 'darwin',
    execFile: (cmd, args, opts, cb) => {
      script = args[3];
      cb(null, 'Preview.app');
    },
  });
  await resolver.resolve('/ws/a"b\\c.md');
  // Das eingebettete Literal muss sich wieder als genau dieser Pfad lesen lassen.
  const literal = script.match(/fileURLWithPath\((".*?[^\\]")\)/)[1];
  assert.equal(JSON.parse(literal), '/ws/a"b\\c.md');
});

test('Standardprogramm Windows: CRLF wird normalisiert, .exe fällt weg', async () => {
  const resolver = createDefaultAppResolver({
    platform: 'win32',
    execFile: (cmd, args, opts, cb) => {
      assert.equal(opts.env.SNOTRA_EXT, '.md');
      cb(null, 'C:\\Program Files\\Notepad++\\notepad++.exe\r\n');
    },
  });
  assert.equal(await resolver.resolve('C:\\ws\\a.md'), 'notepad++');
});

test('Standardprogramm Windows: Datei ohne Endung startet gar keinen Prozess', async () => {
  let started = false;
  const resolver = createDefaultAppResolver({
    platform: 'win32',
    execFile: () => { started = true; },
  });
  assert.equal(await resolver.resolve('C:\\ws\\LIESMICH'), null);
  assert.equal(started, false);
});

test('Standardprogramm Linux: xdg-mime plus Name= aus dem .desktop-Eintrag', async () => {
  const resolver = createDefaultAppResolver({
    platform: 'linux',
    homedir: () => '/home/k',
    execFile: (cmd, args, opts, cb) => {
      if (args[1] === 'filetype') return cb(null, 'text/markdown\n');
      return cb(null, 'org.gnome.gedit.desktop\n');
    },
  });
  const tried = [];
  const fs = {
    readFile: async (p) => {
      tried.push(p);
      if (p === '/home/k/.local/share/applications/org.gnome.gedit.desktop') return '[Desktop Entry]\nName=Texteditor\n';
      throw new Error('ENOENT');
    },
  };
  assert.equal(await resolver.resolve('/ws/a.md', { fs }), 'Texteditor');
  // Linux-Pfade bleiben Linux-Pfade, auch wenn der Test unter Windows läuft.
  assert.deepEqual(tried, ['/home/k/.local/share/applications/org.gnome.gedit.desktop']);
});

test('Standardprogramm Linux: die Suchpfade sind auch unter Windows POSIX-Pfade (#123)', async () => {
  const resolver = createDefaultAppResolver({
    platform: 'linux',
    homedir: () => '/home/k',
    execFile: (cmd, args, opts, cb) => cb(null, args[1] === 'filetype' ? 'text/plain' : 'nano.desktop'),
  });
  const tried = [];
  const fs = { readFile: async (p) => { tried.push(p); throw new Error('ENOENT'); } };
  await resolver.resolve('/ws/a.txt', { fs });
  assert.deepEqual(tried, [
    '/home/k/.local/share/applications/nano.desktop',
    '/usr/share/applications/nano.desktop',
    '/usr/local/share/applications/nano.desktop',
  ]);
  assert.equal(tried.some((p) => p.includes('\\')), false);
});

test('Standardprogramm Linux: ohne .desktop-Datei bleibt die Kennung als Notnagel', async () => {
  const resolver = createDefaultAppResolver({
    platform: 'linux',
    homedir: () => '/home/k',
    execFile: (cmd, args, opts, cb) => cb(null, args[1] === 'filetype' ? 'text/plain' : 'nano.desktop'),
  });
  const fs = { readFile: async () => { throw new Error('ENOENT'); } };
  assert.equal(await resolver.resolve('/ws/a.txt', { fs }), 'nano');
});

test('Standardprogramm: Fehler des Kindprozesses endet als null, nicht als Exception', async () => {
  const resolver = createDefaultAppResolver({
    platform: 'darwin',
    execFile: (cmd, args, opts, cb) => cb(new Error('killed')),
  });
  assert.equal(await resolver.resolve('/ws/a.md'), null);
});

test('Standardprogramm: der Aufruf bekommt ein Timeout mit (#123)', async () => {
  let options = null;
  const resolver = createDefaultAppResolver({
    platform: 'darwin',
    timeoutMs: 900,
    execFile: (cmd, args, opts, cb) => {
      options = opts;
      cb(null, 'Pages.app');
    },
  });
  await resolver.resolve('/ws/a.pages');
  assert.equal(options.timeout, 900);
  assert.equal(options.windowsHide, true);
});

test('Standardprogramm: ein hängender Kindprozess blockiert nicht ewig (#123)', async () => {
  const resolver = createDefaultAppResolver({
    platform: 'darwin',
    timeoutMs: 5,
    execFile: () => {}, // Callback kommt nie
  });
  assert.equal(await resolver.resolve('/ws/a.md'), null);
});

test('Standardprogramm: wirft execFile selbst, wird geloggt statt geworfen', async () => {
  const warnings = [];
  const resolver = createDefaultAppResolver({
    platform: 'darwin',
    execFile: () => { throw new Error('spawn ENOENT'); },
    logger: { warn: (...a) => warnings.push(a.join(' ')) },
  });
  assert.equal(await resolver.resolve('/ws/a.md'), null);
  assert.match(warnings.join(' '), /spawn ENOENT/);
});
