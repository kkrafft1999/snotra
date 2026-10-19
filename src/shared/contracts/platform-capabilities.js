/**
 * The capability register of the platforms (#1149, AR-21, platform half).
 *
 * The twin of the provider register (`provider-capabilities.js`, #996): one
 * vocabulary for what Snotra can do on an operating system, declared once per
 * platform and per packaging variant that changes something
 * (`src/main/platforms/index.js`). Code that decides *whether* a feature
 * exists reads the register instead of comparing `process.platform`; code
 * that only picks *how* a platform does something — paths, shell quoting,
 * menus, key bindings — keeps its own checks.
 *
 * Every capability is declared for every platform, and every gap carries a
 * reason key the UI can show and either the issue that is to close it or
 * `permanent: true` with the rationale for keeping it (parity rule,
 * `docs/quality-requirements.md` §3, USE-4 / POR-1).
 * `test/platform-capabilities.test.js` fails on an undeclared capability and
 * on a gap with neither.
 *
 * Some entries depend on a fact of the running system rather than on the
 * platform: whether the system's encrypted storage is there. Those say
 * `supported: AT_START` and name the fact; main reads it once the app is ready
 * and resolves the register to the DTO the renderer gets
 * (`resolvePlatformCapabilities`). What changes while the app runs — the
 * sandbox's self-test, missing Linux packages — is a state with its own
 * status, not a platform capability.
 */
'use strict';

/** The capabilities every platform declares. */
const PLATFORM_CAPABILITIES = Object.freeze({
  /** Shell commands and Python run isolated in the sandbox (#329). */
  EXECUTION_SANDBOX: 'executionSandbox',
  /** Git over SSH signs in from inside the sandbox through the ssh-agent (#932). */
  SANDBOX_GIT_SSH: 'sandboxGitSsh',
  /** The app replaces itself with a new version (#353). */
  SELF_UPDATE: 'selfUpdate',
  /** The system's encrypted storage keeps keys, history and permanent permissions. */
  SECURE_STORAGE: 'secureStorage',
});

/** The platforms Snotra ships for, as `process.platform` names them. */
const PLATFORMS = Object.freeze({
  MACOS: 'darwin',
  WINDOWS: 'win32',
  LINUX: 'linux',
});

/**
 * Packaging variants that change a capability. Each declares only what
 * differs from its platform; the rest comes from there.
 */
const PLATFORM_VARIANTS = Object.freeze({
  /** A system package (`.deb`, `.rpm`, Snap) under `/opt`, `/usr` or `/snap`. */
  LINUX_PACKAGE: 'linux-package',
});

/** `supported` of an entry a fact of the running system decides, read once at start. */
const AT_START = 'at-start';

/** The facts an `AT_START` entry can follow. */
const PLATFORM_FACTS = Object.freeze({
  /** `safeStorage.isEncryptionAvailable()` once the app is ready (#1012). */
  ENCRYPTION_AVAILABLE: 'encryptionAvailable',
});

/**
 * @typedef {Object} PlatformCapabilityDeclaration
 * @property {boolean|string} supported  true, false or AT_START
 * @property {string} [fact]        AT_START: the fact it follows, one of PLATFORM_FACTS
 * @property {string} [reason]      a gap: the message key the UI can show
 * @property {number} [issue]       a gap to close: the issue that tracks it
 * @property {boolean} [permanent]  a gap by design, kept on purpose
 * @property {string} [rationale]   a permanent gap: why it stays
 *
 * One platform's declaration, by capability name.
 * @typedef {Object<string, PlatformCapabilityDeclaration>} PlatformDeclaration
 *
 * A gap as the renderer gets it.
 * @typedef {Object} PlatformCapabilityGap
 * @property {string} reason        the message key
 * @property {number} [issue]       the issue that is to close it
 * @property {boolean} [permanent]  kept on purpose
 *
 * The resolved register: one boolean per capability, and a gap for each
 * `false`.
 * @typedef {Object} PlatformCapabilities
 * @property {boolean} executionSandbox
 * @property {boolean} sandboxGitSsh
 * @property {boolean} selfUpdate
 * @property {boolean} secureStorage
 * @property {Object<string, PlatformCapabilityGap>} [gaps]
 */

/** @param {unknown} value */
function isIssueNumber(value) {
  return Number.isInteger(value) && /** @type {number} */ (value) > 0;
}

/** @param {unknown} value */
function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * What is wrong with one platform's declaration, as a list of sentences;
 * empty when it is complete. `knownReasonKeys` is the message catalogue the
 * reason keys must exist in.
 *
 * @param {PlatformDeclaration|null|undefined} declared
 * @param {{ knownReasonKeys?: Set<string> }} [options]
 * @returns {string[]}
 */
function platformDeclarationProblems(declared, { knownReasonKeys } = {}) {
  /** @type {string[]} */
  const problems = [];
  if (!declared || typeof declared !== 'object') return ['declares no capabilities'];
  /** @type {string[]} */
  const names = Object.values(PLATFORM_CAPABILITIES);
  /** @type {string[]} */
  const facts = Object.values(PLATFORM_FACTS);
  for (const name of Object.keys(declared)) {
    if (!names.includes(name)) problems.push(`declares unknown capability "${name}"`);
  }
  for (const name of names) {
    const entry = declared[name];
    if (!entry || typeof entry !== 'object') {
      problems.push(`does not declare "${name}"`);
      continue;
    }
    const { supported } = entry;
    if (supported !== true && supported !== false && supported !== AT_START) {
      problems.push(`"${name}": supported must be true, false or "${AT_START}"`);
      continue;
    }
    if (supported === AT_START && !(typeof entry.fact === 'string' && facts.includes(entry.fact))) {
      problems.push(`"${name}": an at-start capability names the fact it follows`);
    }
    if (supported === true) continue;
    // A gap — on this platform for good, or whenever the fact says so.
    if (!isText(entry.reason)) {
      problems.push(`"${name}": a gap needs a reason key`);
    } else if (knownReasonKeys && !knownReasonKeys.has(/** @type {string} */ (entry.reason))) {
      problems.push(`"${name}": reason key "${entry.reason}" is not in the message catalogue`);
    }
    if (entry.permanent === true) {
      if (!isText(entry.rationale)) problems.push(`"${name}": a permanent gap says why it stays`);
      if (entry.issue !== undefined) problems.push(`"${name}": a permanent gap has no issue to close it`);
    } else if (!isIssueNumber(entry.issue)) {
      problems.push(`"${name}": a gap needs the issue that tracks it, or permanent: true with a rationale`);
    }
  }
  return problems;
}

/**
 * The register resolved for the running system — what the renderer reads.
 * A platform nobody declared has every capability off.
 *
 * @param {PlatformDeclaration|null|undefined} declared
 * @param {Object<string, boolean>} [facts]  the PLATFORM_FACTS, read once the app is ready
 * @returns {PlatformCapabilities}
 */
function resolvePlatformCapabilities(declared, facts = {}) {
  /** @type {any} */
  const out = {};
  /** @type {Object<string, PlatformCapabilityGap>} */
  const gaps = {};
  for (const name of Object.values(PLATFORM_CAPABILITIES)) {
    const entry = declared?.[name];
    const supported = entry?.supported === true
      || (entry?.supported === AT_START && typeof entry.fact === 'string' && facts[entry.fact] === true);
    out[name] = supported;
    if (supported) continue;
    /** @type {PlatformCapabilityGap} */
    const gap = { reason: entry?.reason || '' };
    if (entry?.permanent === true || !entry) gap.permanent = true;
    else if (isIssueNumber(entry.issue)) gap.issue = entry.issue;
    gaps[name] = gap;
  }
  if (Object.keys(gaps).length > 0) out.gaps = gaps;
  return out;
}

module.exports = {
  PLATFORM_CAPABILITIES,
  PLATFORMS,
  PLATFORM_VARIANTS,
  PLATFORM_FACTS,
  AT_START,
  platformDeclarationProblems,
  resolvePlatformCapabilities,
};
