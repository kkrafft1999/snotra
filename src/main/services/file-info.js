'use strict';

/**
 * „Informationen“ für einen Eintrag im Dateibaum (Issue #123).
 *
 * Sammelt Name, Pfad, Typ, Größe und Datumsangaben zu einem bereits gegen den
 * Workspace geprüften absoluten Pfad und formatiert sie als Klartext für den
 * nativen Dialog im `file-context-menu`.
 *
 * Zwei Dinge sind hier bewusst vorsichtig gelöst:
 *
 * - **Kein rekursives Zählen.** Ein Ordner zeigt die Anzahl seiner *direkten*
 *   Einträge. Alles darunter zu summieren kann bei `node_modules` beliebig
 *   teuer werden, und niemand wartet dafür auf einen Dialog.
 * - **„Öffnen mit“ ist best effort.** Electron kennt das Standardprogramm
 *   nicht; es kostet je Plattform einen Kindprozess. Der läuft mit hartem
 *   Timeout, und *jeder* Fehlschlag endet als „unbekannt“ — der Rest der
 *   Anzeige hängt nie daran.
 */

const nodePath = require('path');
const { execFile: nodeExecFile } = require('child_process');
const { formatBytesDe } = require('../../shared/runtime/format-bytes');

const UNKNOWN = 'unbekannt';
const DEFAULT_APP_TIMEOUT_MS = 1500;

/** 1468006 → „1.468.006“ (deutsche Tausenderpunkte, ohne Intl/ICU-Abhängigkeit). */
function groupDigitsDe(value) {
  const digits = String(Math.trunc(Math.abs(value)));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += '.';
    out += digits[i];
  }
  return value < 0 ? `-${out}` : out;
}

/**
 * Lesbar **und** exakt: „1,4 MB (1.468.006 Bytes)“. Unter 1 KB wäre die
 * Klammer eine Wiederholung, deshalb dort nur die Byte-Zahl.
 */
function formatSizeDe(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return UNKNOWN;
  const exact = `${groupDigitsDe(bytes)} ${bytes === 1 ? 'Byte' : 'Bytes'}`;
  if (bytes < 1024) return exact;
  return `${formatBytesDe(bytes)} (${exact})`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * „21.09.2026, 14:32“ — bewusst von Hand statt über `toLocaleString`, damit
 * die Ausgabe nicht von der ICU-Ausstattung der jeweiligen Node-Version
 * abhängt. `birthtime` ist unter Linux/ext4 oft 0 bzw. die Epoche; solche
 * Werte gelten als unbekannt, statt als „01.01.1970“ zu erscheinen.
 */
function formatTimestampDe(value) {
  if (value === null || value === undefined) return UNKNOWN;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return UNKNOWN;
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`
    + `, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Endung ohne Punkt, kleingeschrieben; '' für Dotfiles und Namen ohne Endung. */
function extensionOf(absPath) {
  const ext = nodePath.extname(nodePath.basename(absPath));
  return ext.startsWith('.') ? ext.slice(1).toLowerCase() : '';
}

/**
 * macOS-Abfrage über **NSWorkspace**, nicht über den Finder.
 *
 * Die naheliegende Variante `tell application "Finder" to …` schickt ein
 * Apple Event und braucht deshalb die Automatisierungs-Freigabe: Beim ersten
 * Aufruf poppt „Snotra AI möchte Finder steuern“, und bis geantwortet wird,
 * hängt der Aufruf im Timeout — gemessen am 2026-09-21, dauerhaft
 * „unbekannt“, wenn niemand zustimmt. Für eine Info-Zeile ist das zu teuer.
 * `URLForApplicationToOpenURL:` fragt dieselbe Launch-Services-Datenbank
 * direkt, ohne Freigabe und in rund 70 ms.
 */
function macDefaultAppScript(absPath) {
  // JSON.stringify liefert ein gültiges JS-String-Literal samt Escaping.
  return "ObjC.import('AppKit');"
    + `var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(${JSON.stringify(absPath)}));`
    + " u ? ObjC.unwrap(u.lastPathComponent) : ''";
}

/** Windows-CI-Falle: PowerShell und `xdg-mime` liefern CRLF. */
function firstLine(stdout) {
  return String(stdout ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

const WINDOWS_ASSOC_SCRIPT = [
  '$sig = \'[DllImport("shlwapi.dll", CharSet=CharSet.Unicode)] public static extern int',
  'AssocQueryString(int f, int s, string a, string e, System.Text.StringBuilder o, ref int c);\';',
  'Add-Type -MemberDefinition $sig -Name Assoc -Namespace Win32 | Out-Null;',
  '$sb = New-Object System.Text.StringBuilder 1024; $len = 1024;',
  // 0 = ASSOCF_NONE, 2 = ASSOCSTR_EXECUTABLE
  '[void][Win32.Assoc]::AssocQueryString(0, 2, $env:SNOTRA_EXT, $null, $sb, [ref]$len);',
  '$sb.ToString()',
].join(' ');

const LINUX_DESKTOP_DIRS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
];

/**
 * Ermittelt das Standardprogramm für eine Datei — je Plattform ein kurzer
 * Kindprozess mit Timeout. Liefert `null`, sobald irgendetwas nicht klappt.
 */
function createDefaultAppResolver({
  platform = process.platform,
  execFile = nodeExecFile,
  env = process.env,
  homedir = null,
  timeoutMs = DEFAULT_APP_TIMEOUT_MS,
  logger = console,
} = {}) {
  function run(command, args, options = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      // Doppelt gesichert: execFile bringt ein eigenes Timeout mit, der Timer
      // hier fängt den Fall, dass der Callback trotzdem ausbleibt.
      const timer = setTimeout(() => done(null), timeoutMs + 250);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        execFile(
          command,
          args,
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, ...options },
          (err, stdout) => {
            clearTimeout(timer);
            done(err ? null : firstLine(stdout));
          },
        );
      } catch (err) {
        clearTimeout(timer);
        logger.warn?.('Standardprogramm konnte nicht ermittelt werden:', err?.message ?? err);
        done(null);
      }
    });
  }

  async function onMacOs(absPath) {
    const name = await run('osascript', ['-l', 'JavaScript', '-e', macDefaultAppScript(absPath)]);
    if (!name) return null;
    return name.replace(/\.app$/i, '') || null;
  }

  async function onWindows(absPath) {
    const ext = nodePath.extname(absPath);
    if (!ext) return null;
    const out = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ASSOC_SCRIPT],
      { env: { ...env, SNOTRA_EXT: ext } },
    );
    // AssocQueryString liefert den vollen Pfad der EXE; ohne Zuordnung nichts.
    if (!out) return null;
    const exe = nodePath.win32.basename(out).replace(/\.exe$/i, '');
    return exe || null;
  }

  async function onLinux(absPath, { fs }) {
    const mime = await run('xdg-mime', ['query', 'filetype', absPath]);
    if (!mime) return null;
    const desktopId = await run('xdg-mime', ['query', 'default', mime]);
    if (!desktopId) return null;
    const home = typeof homedir === 'function' ? homedir() : env.HOME;
    const dirs = [
      ...(home ? [nodePath.join(home, '.local', 'share', 'applications')] : []),
      ...LINUX_DESKTOP_DIRS,
    ];
    for (const dir of dirs) {
      try {
        // eslint-disable-next-line no-await-in-loop -- die Liste ist drei Einträge lang
        const content = await fs.readFile(nodePath.join(dir, desktopId), 'utf8');
        const name = content.split(/\r?\n/).find((line) => line.startsWith('Name='));
        if (name) return name.slice('Name='.length).trim() || null;
      } catch {
        // Nächstes Verzeichnis; ein fehlender .desktop-Eintrag ist kein Fehler.
      }
    }
    return desktopId.replace(/\.desktop$/i, '') || null;
  }

  async function resolve(absPath, { fs } = {}) {
    try {
      if (platform === 'darwin') return await onMacOs(absPath);
      if (platform === 'win32') return await onWindows(absPath);
      return await onLinux(absPath, { fs });
    } catch (err) {
      logger.warn?.('Standardprogramm konnte nicht ermittelt werden:', err?.message ?? err);
      return null;
    }
  }

  return { resolve };
}

/**
 * Setzt die Felder des Dialogs zusammen. `fs` ist die Promise-API
 * (`require('fs').promises`) und wird injiziert, damit der Test ohne echtes
 * Dateisystem auskommt.
 */
function createFileInfo({
  fs = require('fs').promises,
  platform = process.platform,
  execFile = nodeExecFile,
  env = process.env,
  homedir = null,
  timeoutMs = DEFAULT_APP_TIMEOUT_MS,
  logger = console,
  defaultAppResolver = null,
} = {}) {
  const resolver = defaultAppResolver
    || createDefaultAppResolver({ platform, execFile, env, homedir, timeoutMs, logger });

  async function countEntries(absPath) {
    try {
      const entries = await fs.readdir(absPath);
      return entries.length;
    } catch {
      return null;
    }
  }

  async function symlinkTarget(absPath) {
    try {
      return await fs.readlink(absPath);
    } catch {
      return null;
    }
  }

  /**
   * @returns {Promise<{fields: Array<[string,string]>, name: string, path: string}|{error: string}>}
   */
  async function describe(absPath, { isDirectory = false } = {}) {
    let link = null;
    try {
      link = await fs.lstat(absPath);
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }

    // Symlinks: Typ kommt aus lstat, Größe und Datum vom Ziel. Ist das Ziel
    // weg, bleibt lstat die Quelle — sonst hätte ein toter Link gar keine Info.
    const isSymlink = typeof link.isSymbolicLink === 'function' && link.isSymbolicLink();
    let stats = link;
    let brokenLink = false;
    if (isSymlink) {
      try {
        stats = await fs.stat(absPath);
      } catch {
        brokenLink = true;
      }
    }

    const directory = typeof stats.isDirectory === 'function' ? stats.isDirectory() : isDirectory;
    const name = nodePath.basename(absPath);
    const ext = extensionOf(absPath);

    let type = directory ? 'Ordner' : 'Datei';
    if (!directory && ext) type += ` (.${ext})`;
    if (isSymlink) {
      const target = await symlinkTarget(absPath);
      type = `Verknüpfung${target ? ` → ${target}` : ''}`
        + (brokenLink ? ' (Ziel nicht erreichbar)' : ` auf ${directory ? 'Ordner' : 'Datei'}`);
    }

    const fields = [
      ['Name', name],
      ['Pfad', absPath],
      ['Typ', type],
    ];

    if (directory) {
      const count = await countEntries(absPath);
      fields.push([
        'Inhalt',
        count === null ? UNKNOWN : `${groupDigitsDe(count)} ${count === 1 ? 'Eintrag' : 'Einträge'} (direkt)`,
      ]);
    } else {
      fields.push(['Größe', brokenLink ? UNKNOWN : formatSizeDe(stats.size)]);
    }

    fields.push(['Geändert', formatTimestampDe(stats.mtime)]);
    fields.push(['Erstellt', formatTimestampDe(stats.birthtime)]);

    if (!directory) {
      const app = brokenLink ? null : await resolver.resolve(absPath, { fs });
      fields.push(['Öffnen mit', app || UNKNOWN]);
    }

    return { name, path: absPath, fields };
  }

  return { describe };
}

/**
 * Feldliste → Detailtext des Dialogs. Eine Zeile je Feld, ohne Einrückung:
 * native Dialoge setzen proportional, ausgerichtete Spalten gäbe es hier
 * ohnehin nicht, sie würden nur als unregelmäßige Lücken auffallen.
 */
function formatFields(fields) {
  return fields.map(([label, value]) => `${label}: ${value}`).join('\n');
}

module.exports = {
  createFileInfo,
  createDefaultAppResolver,
  formatFields,
  formatSizeDe,
  formatTimestampDe,
  groupDigitsDe,
  UNKNOWN,
};
