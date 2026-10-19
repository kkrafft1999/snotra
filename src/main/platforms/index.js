/**
 * What Snotra can do on each platform (#1149) — the declarations of the
 * platform capability register. The vocabulary, the rules a declaration
 * follows and the DTO it resolves to are in
 * `src/shared/contracts/platform-capabilities.js`.
 *
 * One block per platform, and one per packaging variant that changes
 * something; a variant declares only what differs from its platform. A gap
 * names the message the UI shows for it and the issue that is to close it, or
 * says `permanent` and why.
 */
'use strict';

const {
  PLATFORM_CAPABILITIES,
  PLATFORMS,
  PLATFORM_VARIANTS,
  PLATFORM_FACTS,
  AT_START,
  resolvePlatformCapabilities,
} = require('../../shared/contracts/platform-capabilities');

/** @typedef {import('../../shared/contracts/platform-capabilities').PlatformDeclaration} PlatformDeclaration */
/** @typedef {import('../../shared/contracts/platform-capabilities').PlatformCapabilityDeclaration} PlatformCapabilityDeclaration */
/** @typedef {import('../../shared/contracts/platform-capabilities').PlatformCapabilities} PlatformCapabilities */

const NO_SANDBOX_ON_WINDOWS = Object.freeze({
  supported: false,
  reason: 'approval.isolation.reason.platform',
  issue: 990,
});

// Keys and permanent permissions are never kept in plain text: without the
// system's encrypted storage there is no stored key, no Auto and no allow
// rule, and the history stays unencrypted. Linux without a keyring and a
// "Deny" on macOS both end up here.
const SECURE_STORAGE = Object.freeze({
  supported: AT_START,
  fact: PLATFORM_FACTS.ENCRYPTION_AVAILABLE,
  reason: 'settings.error.encryptionUnavailable',
  permanent: true,
  rationale: 'Keys and permanent permissions are never kept in plain text (security concept §7); without the '
    + 'system\'s encrypted storage the features that need them stay off rather than fall back to it.',
});

/** @type {Readonly<Object<string, PlatformDeclaration>>} */
const PLATFORM_DECLARATIONS = Object.freeze({
  [PLATFORMS.MACOS]: Object.freeze({
    [PLATFORM_CAPABILITIES.EXECUTION_SANDBOX]: { supported: true },
    [PLATFORM_CAPABILITIES.SANDBOX_GIT_SSH]: { supported: true },
    [PLATFORM_CAPABILITIES.SELF_UPDATE]: { supported: true },
    [PLATFORM_CAPABILITIES.SECURE_STORAGE]: SECURE_STORAGE,
  }),
  [PLATFORMS.WINDOWS]: Object.freeze({
    [PLATFORM_CAPABILITIES.EXECUTION_SANDBOX]: NO_SANDBOX_ON_WINDOWS,
    // Without a sandbox Git over SSH simply runs with the user's rights; the
    // gap is the sandbox's.
    [PLATFORM_CAPABILITIES.SANDBOX_GIT_SSH]: NO_SANDBOX_ON_WINDOWS,
    [PLATFORM_CAPABILITIES.SELF_UPDATE]: { supported: true },
    [PLATFORM_CAPABILITIES.SECURE_STORAGE]: SECURE_STORAGE,
  }),
  [PLATFORMS.LINUX]: Object.freeze({
    [PLATFORM_CAPABILITIES.EXECUTION_SANDBOX]: { supported: true },
    [PLATFORM_CAPABILITIES.SANDBOX_GIT_SSH]: {
      supported: false,
      reason: 'platform.gap.sandboxGitSsh',
      issue: 1155,
    },
    [PLATFORM_CAPABILITIES.SELF_UPDATE]: { supported: true },
    [PLATFORM_CAPABILITIES.SECURE_STORAGE]: SECURE_STORAGE,
  }),
});

/** @type {Readonly<Object<string, { platform: string, capabilities: PlatformDeclaration }>>} */
const VARIANT_DECLARATIONS = Object.freeze({
  [PLATFORM_VARIANTS.LINUX_PACKAGE]: Object.freeze({
    platform: PLATFORMS.LINUX,
    capabilities: Object.freeze({
      [PLATFORM_CAPABILITIES.SELF_UPDATE]: {
        supported: false,
        reason: 'update.reason.package',
        permanent: true,
        rationale: 'A system package belongs to the package manager: replacing it needs administrator rights, '
          + 'and the next package update would overwrite it anyway.',
      },
    }),
  }),
});

/**
 * The full declaration for a platform, with a variant's differences on top;
 * null for a platform Snotra does not ship for. A variant of another platform
 * is ignored.
 *
 * @param {string} platform  `process.platform`
 * @param {string|null} [variant]  one of PLATFORM_VARIANTS
 * @returns {PlatformDeclaration|null}
 */
function platformDeclaration(platform, variant = null) {
  const base = PLATFORM_DECLARATIONS[platform];
  if (!base) return null;
  const overlay = variant ? VARIANT_DECLARATIONS[variant] : null;
  if (!overlay || overlay.platform !== platform) return base;
  return { ...base, ...overlay.capabilities };
}

/**
 * One capability's declaration on a platform (and variant), or null.
 *
 * @param {string} platform
 * @param {string} name  one of PLATFORM_CAPABILITIES
 * @param {string|null} [variant]
 * @returns {PlatformCapabilityDeclaration|null}
 */
function declaredPlatformCapability(platform, name, variant = null) {
  return platformDeclaration(platform, variant)?.[name] || null;
}

/**
 * Whether a capability exists on a platform, for the entries the platform
 * alone decides. An entry that follows a fact of the running system has no
 * answer here; it is read from the resolved register.
 *
 * @param {string} platform  `process.platform`
 * @param {string} name      one of PLATFORM_CAPABILITIES
 * @param {string|null} [variant]
 * @returns {boolean}
 */
function platformSupports(platform, name, variant = null) {
  const entry = declaredPlatformCapability(platform, name, variant);
  if (entry?.supported === AT_START) {
    throw new Error(`"${name}" depends on the running system; read it from the resolved platform capabilities.`);
  }
  return entry?.supported === true;
}

/**
 * The register resolved for one platform, variant and set of facts.
 *
 * @param {{ platform: string, variant?: string|null, facts?: Object<string, boolean> }} running
 * @returns {PlatformCapabilities}
 */
function resolvePlatform({ platform, variant = null, facts = {} }) {
  return resolvePlatformCapabilities(platformDeclaration(platform, variant), facts);
}

/** Every declaration, platforms first, for the test and the docs. */
function listPlatformRegister() {
  return [
    ...Object.entries(PLATFORM_DECLARATIONS).map(([id, capabilities]) => ({ id, platform: id, capabilities })),
    ...Object.entries(VARIANT_DECLARATIONS).map(([id, variant]) => ({
      id,
      platform: variant.platform,
      capabilities: /** @type {PlatformDeclaration} */ (platformDeclaration(variant.platform, id)),
    })),
  ];
}

module.exports = {
  PLATFORM_DECLARATIONS,
  VARIANT_DECLARATIONS,
  platformDeclaration,
  declaredPlatformCapability,
  platformSupports,
  resolvePlatform,
  listPlatformRegister,
};
