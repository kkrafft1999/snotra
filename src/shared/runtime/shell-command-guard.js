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
    'Forced recursive deletion is blocked in Snotra. Delete individual paths instead; '
    + 'if the command is really needed, the user has to run it in a terminal themselves.',
  DISK:
    'Disk operations (formatting, partitioning, writing to devices directly) are blocked in Snotra. '
    + 'If the command is really needed, the user has to run it in a terminal themselves.',
  GIT_HISTORY:
    'Rewriting Git history (force push, filter-branch, filter-repo) is blocked in Snotra. '
    + 'If the command is really needed, the user has to run it in a terminal themselves.',
});

/**
 * Wrappers that run the command after them. Their own arguments are not
 * always flags (`timeout 60 rm -rf x`, `sudo -u bob rm -rf x`), so behind a
 * wrapper every later word is tried as the start of the command (CR-B03-03).
 */
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'nohup', 'command', 'builtin', 'exec', 'time', 'nice', 'ionice', 'setsid',
  'xargs', 'timeout', 'stdbuf',
]);

/** Reserved words in front of a command: `do rm -rf "$d"` runs rm (CR-B03-03). */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);

/** Programme, die einen Datentraeger direkt bearbeiten. */
const DISK_COMMANDS = new Set([
  'mkfs', 'fdisk', 'sfdisk', 'cfdisk', 'parted', 'partprobe', 'diskpart', 'shred', 'wipefs',
  'badblocks', 'hdparm', 'newfs', 'format',
  // PowerShell-Cmdlets
  'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'set-partition',
]);

/** Unterbefehle von `diskutil`, die Daten vernichten. */
const DISKUTIL_DESTRUCTIVE = /^(erase|reformat|partitiondisk|zerodisk|randomdisk|secureerase)/i;

/**
 * `rm` and its relatives. In PowerShell — the default shell on Windows —
 * `rm`, `ri`, `del`, `erase`, `rd` and `rmdir` are all aliases of
 * `Remove-Item` and take `-Recurse` and `-Force` (CR-B03-03).
 */
const REMOVE_COMMANDS = new Set(['rm', 'unlink', 'ri', 'del', 'erase', 'rd', 'rmdir', 'remove-item']);
/** cmd.exe: `/s` deletes whole trees on its own. */
const CMD_TREE_DELETE = new Set(['del', 'erase', 'rd', 'rmdir']);

/** Erzwungener Push in jeder Schreibweise. */
const GIT_FORCE_PUSH = /^(-f|--force|--force-with-lease|--force-if-includes)(=.*)?$/i;
/** `-uf`: a cluster of git push's short flags with `-f` among them. */
const GIT_FORCE_CLUSTER = /^-[uvqnd46]*f[uvqnd46f]*$/;
/** Options in front of git's subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/**
 * Zerlegt eine Befehlszeile grob in die einzeln laufenden Teile — also auch
 * an Subshells und Befehlsersetzungen (`(…)`, `$(…)`, Backticks).
 */
function splitSegments(command) {
  return String(command).split(/&&|\|\||[\n;|&()`]/);
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

/**
 * Whether `arg` is the PowerShell switch `name`: `true`/`false` for its value,
 * `null` when it is something else. PowerShell accepts any unambiguous
 * prefix (`-Rec`, `-r`; `-fo`, since `-f` would also be `-Filter`), any case,
 * and an explicit value (`-Force:$true`).
 */
function powerShellSwitch(arg, name, minLength) {
  const match = /^-([a-z]+)(?::\$?(true|false))?$/i.exec(arg);
  if (!match) return null;
  const given = match[1].toLowerCase();
  if (given.length < minLength || !name.startsWith(given)) return null;
  return match[2]?.toLowerCase() !== 'false';
}

function checkRemove(name, args) {
  if (CMD_TREE_DELETE.has(name) && args.some((arg) => /^\/s$/i.test(arg))) {
    return BLOCK_REASONS.RECURSIVE_DELETE;
  }
  const recurse = (arg) => powerShellSwitch(arg, 'recurse', 1);
  const force = (arg) => powerShellSwitch(arg, 'force', 2);
  // `-Force` is a switch, not the letters F, o, r, c, e.
  const flags = posixFlags(args.filter((arg) => recurse(arg) === null && force(arg) === null));
  const recursive = flags.short.has('r') || flags.short.has('R') || flags.long.has('recursive')
    || args.some((arg) => recurse(arg) === true);
  const forced = flags.short.has('f') || flags.long.has('force') || args.some((arg) => force(arg) === true);
  return recursive && forced ? BLOCK_REASONS.RECURSIVE_DELETE : null;
}

function checkGit(args) {
  // `git -C repo push --force`: options in front of the subcommand, some of
  // them with a value, are not the subcommand (CR-B03-03).
  let index = 0;
  while (index < args.length) {
    if (GIT_VALUE_OPTIONS.has(args[index])) index += 2;
    else if (args[index].startsWith('-')) index += 1;
    else break;
  }
  const sub = args[index];
  const rest = args.slice(index + 1);
  if (sub === 'filter-branch' || sub === 'filter-repo') return BLOCK_REASONS.GIT_HISTORY;
  if (sub === 'push') {
    // `+main` in a refspec forces that one ref.
    const forced = rest.some((arg) => GIT_FORCE_PUSH.test(arg) || GIT_FORCE_CLUSTER.test(arg)
      || /^\+[^+]/.test(arg));
    if (forced) return BLOCK_REASONS.GIT_HISTORY;
  }
  return null;
}

/** The command that starts at `rest[0]`. */
function checkCommand(rest) {
  if (rest.length === 0) return null;
  const name = baseName(rest[0]);
  const args = rest.slice(1);

  if (REMOVE_COMMANDS.has(name)) {
    const reason = checkRemove(name, args);
    if (reason) return reason;
  }
  if (DISK_COMMANDS.has(name) || /^mkfs\./i.test(name)) return BLOCK_REASONS.DISK;
  if (name === 'diskutil' && args.some((arg) => DISKUTIL_DESTRUCTIVE.test(arg))) {
    return BLOCK_REASONS.DISK;
  }
  if (name === 'dd' && args.some((arg) => /^of=\/dev\//i.test(arg))) return BLOCK_REASONS.DISK;
  if (name === 'git') return checkGit(args);
  return null;
}

function checkSegment(tokens) {
  // Fuehrende Variablenzuweisungen, Schluesselwoerter und Wrapper
  // ueberspringen: `sudo rm -rf /`, `FOO=1 rm -rf /` und `then rm -rf /` sind
  // derselbe Befehl.
  let index = 0;
  let afterWrapper = false;
  while (index < tokens.length) {
    const token = unquote(tokens[index]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || KEYWORDS.has(token)) {
      index += 1;
      continue;
    }
    if (WRAPPERS.has(baseName(token))) {
      index += 1;
      afterWrapper = true;
      continue;
    }
    break;
  }
  const rest = tokens.slice(index).map(unquote);
  if (!afterWrapper) return checkCommand(rest);
  for (let start = 0; start < rest.length; start += 1) {
    const reason = checkCommand(rest.slice(start));
    if (reason) return reason;
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
