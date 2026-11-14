'use strict';

/**
 * The name a comment in a PDF is signed with (#1386): the full name of the
 * system account Snotra runs under, the way macOS Preview and Acrobat sign
 * theirs. Decided on 2026-11-14 instead of a field in the settings — nothing
 * to set up, and the name is the one the user's other tools already use.
 *
 * - macOS: `id -F`, the account's full name.
 * - Linux: the first field of the GECOS entry in `/etc/passwd`.
 * - Windows, and wherever the above has nothing: the login name.
 *
 * Asked once and kept; a failure only costs the full name, never the comment.
 */

const os = require('os');
const { execFile } = require('child_process');
const { readFile } = require('fs/promises');

const LOOKUP_TIMEOUT_MS = 2000;
const MAX_NAME_CHARS = 128;

/** @param {unknown} name */
function clean(name) {
  if (typeof name !== 'string') return '';
  // One line, no control characters, a sane length.
  return name.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, MAX_NAME_CHARS);
}

/**
 * @param {Function} execFileFn  `child_process.execFile`'s shape
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function execText(execFileFn, file, args) {
  return new Promise((resolve) => {
    execFileFn(file, args, { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true }, (/** @type {Error | null} */ err, /** @type {unknown} */ stdout) => {
      resolve(err ? '' : String(stdout ?? ''));
    });
  });
}

/**
 * @param {{
 *   platform?: NodeJS.Platform,
 *   userInfo?: () => { username: string, uid: number },
 *   execFileFn?: typeof execFile,
 *   readFileFn?: (path: string, encoding: 'utf8') => Promise<string>,
 * }} [deps]
 */
function createAccountName({
  platform = process.platform,
  userInfo = () => os.userInfo(),
  execFileFn = execFile,
  readFileFn = readFile,
} = {}) {
  let cached = null;

  async function lookUp() {
    let login = '';
    let uid = -1;
    try {
      const info = userInfo();
      login = clean(info.username);
      uid = info.uid;
    } catch {
      // No account entry (a container, say): nothing to sign with but a blank.
    }
    let full = '';
    if (platform === 'darwin') {
      full = clean(await execText(execFileFn, '/usr/bin/id', ['-F']));
    } else if (platform === 'linux' && uid >= 0) {
      try {
        const passwd = await readFileFn('/etc/passwd', 'utf8');
        const line = passwd.split('\n').find((l) => l.split(':')[2] === String(uid));
        full = clean(line?.split(':')[4]?.split(',')[0] ?? '');
      } catch {
        // No passwd file to read: the login name below.
      }
    }
    return full || login;
  }

  return {
    /** The full name, or the login name, or ''. */
    async fullName() {
      cached ??= lookUp().catch(() => {
        // No name to be had: the comment is written unsigned rather than not at all.
        return '';
      });
      return cached;
    },
  };
}

module.exports = { createAccountName };
