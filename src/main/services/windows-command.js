'use strict';

/**
 * How a configured command is started on Windows (CR-B16-01).
 *
 * `spawn` without a shell does not do what a terminal does there: it tries a
 * bare name with `.com` and `.exe` only, never with the rest of `PATHEXT`, and
 * since the April 2024 security release Node refuses to start a `.cmd` or
 * `.bat` file at all (`EINVAL`). `npx` is such a file — the most common way an
 * MCP server is configured — so it has to be found over `PATH` and `PATHEXT`
 * and started through `cmd.exe`.
 *
 * Starting through `cmd.exe` means the arguments are read twice: once by
 * `cmd /c`, and once more by the batch file, which hands `%*` on to the
 * program it calls (`npx.cmd` → `node npx-cli.js %*`). Each argument is
 * therefore quoted for the program and its `cmd` metacharacters are escaped
 * for both reads — the approach of `cross-spawn`, which the MCP SDK uses for
 * the same job. With a single escape, an argument holding a quote would leave
 * the rest of the line unquoted on the second read, and an `&` after it would
 * start a second command.
 */

const path = require('path');

/** What `cmd` treats specially outside quotes; each one gets a caret. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** `PATHEXT` when the environment has none — the Windows default. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Windows environment names ignore case; `Path` and `PATH` are the same. */
function envValue(env, name) {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env || {})) {
    if (key.toUpperCase() === wanted && typeof value === 'string') return value;
  }
  return '';
}

/**
 * Quotes one argument for a program that splits its command line the usual
 * way (`CommandLineToArgvW`), then escapes it for `cmd`, twice.
 */
function escapeCmdArgument(arg) {
  let quoted = String(arg);
  // Backslashes before a quote are doubled and the quote is escaped; the
  // backslashes at the very end are doubled because a quote follows them.
  quoted = quoted.replace(/(\\*)"/g, '$1$1\\"');
  quoted = quoted.replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/** The path of the batch file itself is read by `cmd` once. */
function escapeCmdCommand(file) {
  return String(file).replace(CMD_META, '^$1');
}

/**
 * Finds a command the way a terminal does: a name with a directory is taken
 * relative to `cwd`, a bare name is looked up in every `PATH` directory, and a
 * name without an extension is tried with every `PATHEXT` extension in order.
 *
 * @returns {string} the full path, or '' when nothing matches
 */
function findWindowsCommand(command, { env, cwd, isFile }) {
  const win = path.win32;
  const hasDir = /[\\/]/.test(command);
  const extensions = win.extname(command)
    ? ['']
    : (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').map((ext) => ext.trim().toLowerCase()).filter(Boolean);
  const dirs = hasDir || win.isAbsolute(command)
    ? [cwd || '']
    : envValue(env, 'PATH').split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? win.resolve(dir, command) : command;
    for (const ext of extensions) {
      const candidate = `${base}${ext}`;
      if (isFile(candidate)) return candidate;
    }
  }
  return '';
}

/**
 * What to hand to `spawn` on Windows for a configured command.
 *
 * @param {object} input
 * @param {string} input.command
 * @param {string[]} input.args
 * @param {Record<string, string>} input.env  the child's environment
 * @param {string} [input.cwd]
 * @param {(file: string) => boolean} input.isFile
 * @returns {{ command: string, args: string[], options: object }}
 */
function windowsLaunch({ command, args = [], env = {}, cwd = '', isFile }) {
  const resolved = findWindowsCommand(command, { env, cwd, isFile });
  // Nothing found: start it as it was given and let `spawn` report ENOENT.
  if (!resolved) return { command, args, options: {} };
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, options: {} };
  const line = [escapeCmdCommand(resolved), ...args.map(escapeCmdArgument)].join(' ');
  return {
    command: envValue(env, 'ComSpec') || 'cmd.exe',
    // `/d` skips AutoRun, `/s` takes the outer quotes off and nothing else.
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

module.exports = { windowsLaunch, findWindowsCommand, escapeCmdArgument, escapeCmdCommand };
