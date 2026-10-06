'use strict';

/**
 * Where main finds the user's home folder (#707).
 *
 * Normally that is `os.homedir()`. `SNOTRA_HOME_DIR` moves it — for the e2e
 * runs, which must not read the real global memory, instructions and skills.
 * On macOS and Linux moving HOME would do, but on Windows `os.homedir()` reads
 * USERPROFILE, and with that moved Electron does not come up at all. So main
 * asks here, and the tests redirect this one variable instead.
 *
 * Only an absolute path counts; anything else falls back to the real home.
 */

const os = require('os');
const path = require('path');

const HOME_DIR_ENV = 'SNOTRA_HOME_DIR';

function homeDirOverride(env = process.env) {
  const raw = typeof env?.[HOME_DIR_ENV] === 'string' ? env[HOME_DIR_ENV].trim() : '';
  return raw && path.isAbsolute(raw) ? path.resolve(raw) : null;
}

function resolveHomeDir({ env = process.env, homedir = os.homedir } = {}) {
  return homeDirOverride(env) ?? homedir();
}

/**
 * An `os` whose `homedir()` honours the override; everything else is the given
 * one. Without an override the given `os` comes back unchanged.
 */
function withHomeDir(baseOs, env = process.env) {
  const override = homeDirOverride(env);
  if (!override || !baseOs) return baseOs;
  return Object.assign(Object.create(baseOs), { homedir: () => override });
}

module.exports = { HOME_DIR_ENV, homeDirOverride, resolveHomeDir, withHomeDir };
