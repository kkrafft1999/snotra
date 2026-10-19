/**
 * The platform capability register resolved for the running app (#1149):
 * once at start, after `app` is ready — on Linux `safeStorage` knows its
 * backend only then.
 */
'use strict';

const { PLATFORM_VARIANTS, PLATFORM_FACTS } = require('../../shared/contracts/platform-capabilities');
const { detectInstallTarget } = require('../services/update-targets');
const { resolvePlatform } = require('./index');

/** @typedef {import('../../shared/contracts/platform-capabilities').PlatformCapabilities} PlatformCapabilities */

/** The packaging variant an installation's kind stands for, if any changes something. */
const VARIANT_BY_INSTALL_KIND = Object.freeze({
  'linux-package': PLATFORM_VARIANTS.LINUX_PACKAGE,
});

/**
 * @param {Object} deps
 * @param {Partial<Pick<import('electron').App, 'getPath' | 'isPackaged'>>} [deps.app]
 * @param {Partial<Pick<import('electron').SafeStorage, 'isEncryptionAvailable'>>} [deps.safeStorage]
 * @param {string} [deps.platform]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {string} [deps.execPath]
 * @returns {PlatformCapabilities}
 */
function resolveRunningPlatform({
  app,
  safeStorage,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
} = {}) {
  let exe = execPath;
  try {
    if (typeof app?.getPath === 'function') exe = app.getPath('exe');
  } catch { /* process.execPath stays */ }
  const { kind } = detectInstallTarget({ platform, execPath: exe, env, isPackaged: app?.isPackaged !== false });
  /** @type {Object<string, string>} */
  const variants = VARIANT_BY_INSTALL_KIND;
  let encryptionAvailable = false;
  try {
    encryptionAvailable = safeStorage?.isEncryptionAvailable?.() === true;
  } catch { /* no encrypted storage */ }
  return resolvePlatform({
    platform,
    variant: variants[kind] || null,
    facts: { [PLATFORM_FACTS.ENCRYPTION_AVAILABLE]: encryptionAvailable },
  });
}

module.exports = { resolveRunningPlatform };
