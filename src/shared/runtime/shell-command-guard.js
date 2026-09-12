/**
 * Gesperrte Wirkungen fuer `shell_execute` (Issue #102, Konzept §9).
 *
 * Zweite Verteidigungslinie, ausdruecklich **kein** Schutzversprechen: das
 * Sicherheitskonzept stellt selbst fest, dass eine Liste verbotener
 * Zeichenfolgen nicht gegen Interpreter, Wrapper und zusammengesetzte Befehle
 * schuetzt (`base64 -d | sh` bleibt moeglich). Der eigentliche Schutz ist der
 * vollstaendig sichtbare Befehl plus menschliche Freigabe vor jedem Lauf.
 *
 * Gesperrt sind die drei im Konzept benannten Wirkungen: rekursives
 * Zwangsloeschen, Datentraegeroperationen und Umschreiben der Git-Historie.
 * Die Pruefung ist rein und ohne Laufzeitabhaengigkeiten, damit sie im Planer
 * (vor der Freigabekarte) und im Tool-Handler gleichermassen laeuft.
 */
'use strict';

const BLOCK_REASONS = Object.freeze({
  RECURSIVE_DELETE:
    'Rekursives Zwangslöschen ist in Snotra gesperrt. Lösche gezielt einzelne Pfade; '
    + 'ist der Befehl wirklich nötig, muss der Nutzer ihn selbst im Terminal ausführen.',
  DISK:
    'Datenträgeroperationen (Formatieren, Partitionieren, direktes Schreiben auf Geräte) sind in Snotra gesperrt. '
    + 'Ist der Befehl wirklich nötig, muss der Nutzer ihn selbst im Terminal ausführen.',
  GIT_HISTORY:
    'Das Umschreiben der Git-Historie (erzwungener Push, filter-branch, filter-repo) ist in Snotra gesperrt. '
    + 'Ist der Befehl wirklich nötig, muss der Nutzer ihn selbst im Terminal ausführen.',
});

/** Wrapper, die vor dem eigentlichen Befehl stehen duerfen. */
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'nohup', 'command', 'builtin', 'exec', 'time', 'nice', 'ionice', 'setsid',
  'xargs', 'timeout', 'stdbuf',
]);

/** Programme, die einen Datentraeger direkt bearbeiten. */
const DISK_COMMANDS = new Set([
  'mkfs', 'fdisk', 'sfdisk', 'cfdisk', 'parted', 'partprobe', 'diskpart', 'shred', 'wipefs',
  'badblocks', 'hdparm', 'newfs', 'format',
  // PowerShell-Cmdlets
  'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'set-partition',
]);

/** Unterbefehle von `diskutil`, die Daten vernichten. */
const DISKUTIL_DESTRUCTIVE = /^(erase|reformat|partitiondisk|zerodisk|randomdisk|secureerase)/i;

/** Erzwungener Push in jeder Schreibweise. */
const GIT_FORCE_PUSH = /^(-f|--force|--force-with-lease|--force-if-includes)(=.*)?$/i;

/** Zerlegt eine Befehlszeile grob in die einzeln laufenden Teile. */
function splitSegments(command) {
  return String(command).split(/&&|\|\||[\n;|&]/);
}

/** Programmname ohne Pfad und ohne Windows-Endung, klein geschrieben. */
function baseName(token) {
  const withoutPath = token.split(/[\\/]/).pop() || '';
  return withoutPath.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

/** Anfuehrungszeichen stoeren die Auswertung der Flags, nicht ihren Sinn. */
function unquote(token) {
  return token.replace(/^['"]|['"]$/g, '');
}

/** Kurzflags einer POSIX-Zeile zu einem Buchstabensatz zusammenziehen. */
function posixFlags(tokens) {
  const short = new Set();
  const long = new Set();
  for (const token of tokens) {
    if (token.startsWith('--')) {
      long.add(token.slice(2).split('=')[0].toLowerCase());
    } else if (token.startsWith('-') && token.length > 1) {
      for (const letter of token.slice(1)) short.add(letter);
    }
  }
  return { short, long };
}

function checkSegment(tokens) {
  // Fuehrende Variablenzuweisungen und Wrapper ueberspringen: `sudo rm -rf /`
  // und `FOO=1 rm -rf /` sind derselbe Befehl.
  let index = 0;
  let afterWrapper = false;
  while (index < tokens.length) {
    const token = unquote(tokens[index]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || WRAPPERS.has(baseName(token))) {
      index += 1;
      afterWrapper = true;
      continue;
    }
    // Flags des Wrappers gehoeren noch zu ihm: `xargs -0 rm -rf` fuehrt rm aus.
    if (afterWrapper && token.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  const rest = tokens.slice(index).map(unquote);
  if (rest.length === 0) return null;
  const name = baseName(rest[0]);
  const args = rest.slice(1);
  const flags = posixFlags(args);

  if (name === 'rm' || name === 'unlink') {
    const recursive = flags.short.has('r') || flags.short.has('R') || flags.long.has('recursive');
    const force = flags.short.has('f') || flags.long.has('force');
    if (recursive && force) return BLOCK_REASONS.RECURSIVE_DELETE;
  }
  if (name === 'del' || name === 'erase' || name === 'rd' || name === 'rmdir') {
    // Windows: /s ist die rekursive Form, sie loescht ganze Baeume.
    if (args.some((arg) => /^\/s$/i.test(arg))) return BLOCK_REASONS.RECURSIVE_DELETE;
  }
  if (name === 'remove-item' || name === 'ri') {
    const recursive = args.some((arg) => /^-recurse$/i.test(arg));
    const force = args.some((arg) => /^-force$/i.test(arg));
    if (recursive && force) return BLOCK_REASONS.RECURSIVE_DELETE;
  }
  if (DISK_COMMANDS.has(name) || /^mkfs\./i.test(name)) return BLOCK_REASONS.DISK;
  if (name === 'diskutil' && args.some((arg) => DISKUTIL_DESTRUCTIVE.test(arg))) {
    return BLOCK_REASONS.DISK;
  }
  if (name === 'dd' && args.some((arg) => /^of=\/dev\//i.test(arg))) return BLOCK_REASONS.DISK;
  if (name === 'git') {
    const sub = args.find((arg) => !arg.startsWith('-'));
    if (sub === 'filter-branch' || sub === 'filter-repo') return BLOCK_REASONS.GIT_HISTORY;
    if (sub === 'push' && args.some((arg) => GIT_FORCE_PUSH.test(arg))) return BLOCK_REASONS.GIT_HISTORY;
  }
  return null;
}

/**
 * Prueft eine Befehlszeile auf gesperrte Wirkungen.
 *
 * @param {string} command
 * @returns {{ blocked: boolean, reason?: string }}
 */
function checkShellCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return { blocked: false };
  for (const segment of splitSegments(command)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const reason = checkSegment(tokens);
    if (reason) return { blocked: true, reason };
  }
  return { blocked: false };
}

module.exports = { checkShellCommand, BLOCK_REASONS };
