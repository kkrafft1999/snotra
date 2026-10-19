// The capability register of the platforms (#1149, AR-21, platform half).
//
// Every platform and every packaging variant declares every capability, and
// every gap carries a reason the UI can show and either the issue that is to
// close it or `permanent` with the rationale (parity rule, quality
// requirements §3). Code that decides whether a feature exists reads the
// register, not the platform's name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const en = require('../src/shared/i18n/messages/en');
const de = require('../src/shared/i18n/messages/de');
const {
  PLATFORM_CAPABILITIES,
  PLATFORMS,
  PLATFORM_VARIANTS,
  PLATFORM_FACTS,
  AT_START,
  platformDeclarationProblems,
  resolvePlatformCapabilities,
} = require('../src/shared/contracts/platform-capabilities');
const {
  listPlatformRegister,
  platformDeclaration,
  platformSupports,
  resolvePlatform,
} = require('../src/main/platforms');
const { resolveRunningPlatform } = require('../src/main/platforms/running-platform');
const { detectInstallTarget } = require('../src/main/services/update-targets');
const { executionSwitchDialog } = require('../src/main/ipc/settings-confirmation-dialogs');
const { createTranslator } = require('../src/shared/i18n');

const ROOT = path.join(__dirname, '..');
const knownReasonKeys = new Set(Object.keys(en).filter((key) => Object.hasOwn(de, key)));
const { EXECUTION_SANDBOX, SANDBOX_GIT_SSH, SELF_UPDATE, SECURE_STORAGE } = PLATFORM_CAPABILITIES;

/** A complete declaration to break one piece of at a time. */
function complete() {
  return {
    [EXECUTION_SANDBOX]: { supported: true },
    [SANDBOX_GIT_SSH]: { supported: false, reason: 'approval.isolation.reason.platform', issue: 990 },
    [SELF_UPDATE]: { supported: false, reason: 'update.reason.package', permanent: true, rationale: 'by design' },
    [SECURE_STORAGE]: {
      supported: AT_START,
      fact: PLATFORM_FACTS.ENCRYPTION_AVAILABLE,
      reason: 'settings.error.encryptionUnavailable',
      permanent: true,
      rationale: 'no plain text',
    },
  };
}

test('every platform and variant declares every capability, each gap with a reason and an issue or a rationale', () => {
  const register = listPlatformRegister();
  assert.deepEqual(
    register.map((entry) => entry.id),
    [...Object.values(PLATFORMS), ...Object.values(PLATFORM_VARIANTS)],
  );
  for (const { id, capabilities } of register) {
    assert.deepEqual(platformDeclarationProblems(capabilities, { knownReasonKeys }), [], id);
  }
});

test('a declaration that leaves a capability out, or a gap unexplained, is refused', () => {
  assert.deepEqual(platformDeclarationProblems(complete(), { knownReasonKeys }), []);

  const missing = complete();
  delete missing[SELF_UPDATE];
  assert.deepEqual(platformDeclarationProblems(missing), [`does not declare "${SELF_UPDATE}"`]);

  const unknown = { ...complete(), teleport: { supported: true } };
  assert.deepEqual(platformDeclarationProblems(unknown), ['declares unknown capability "teleport"']);

  const bare = { ...complete(), [EXECUTION_SANDBOX]: { supported: false } };
  assert.deepEqual(platformDeclarationProblems(bare), [
    `"${EXECUTION_SANDBOX}": a gap needs a reason key`,
    `"${EXECUTION_SANDBOX}": a gap needs the issue that tracks it, or permanent: true with a rationale`,
  ]);

  const noIssue = { ...complete(), [EXECUTION_SANDBOX]: { supported: false, reason: 'approval.isolation.reason.platform' } };
  assert.deepEqual(platformDeclarationProblems(noIssue, { knownReasonKeys }), [
    `"${EXECUTION_SANDBOX}": a gap needs the issue that tracks it, or permanent: true with a rationale`,
  ]);

  const unexplained = { ...complete(), [SELF_UPDATE]: { supported: false, reason: 'update.reason.package', permanent: true } };
  assert.deepEqual(platformDeclarationProblems(unexplained), [`"${SELF_UPDATE}": a permanent gap says why it stays`]);

  const both = { ...complete(), [SELF_UPDATE]: { ...complete()[SELF_UPDATE], issue: 7 } };
  assert.deepEqual(platformDeclarationProblems(both), [`"${SELF_UPDATE}": a permanent gap has no issue to close it`]);

  const unknownKey = { ...complete(), [SANDBOX_GIT_SSH]: { supported: false, reason: 'no.such.key', issue: 990 } };
  assert.deepEqual(platformDeclarationProblems(unknownKey, { knownReasonKeys }), [
    `"${SANDBOX_GIT_SSH}": reason key "no.such.key" is not in the message catalogue`,
  ]);

  const noFact = { ...complete(), [SECURE_STORAGE]: { ...complete()[SECURE_STORAGE], fact: 'mood' } };
  assert.deepEqual(platformDeclarationProblems(noFact), [`"${SECURE_STORAGE}": an at-start capability names the fact it follows`]);

  const maybe = { ...complete(), [EXECUTION_SANDBOX]: { supported: 'sometimes' } };
  assert.deepEqual(platformDeclarationProblems(maybe), [`"${EXECUTION_SANDBOX}": supported must be true, false or "${AT_START}"`]);

  assert.deepEqual(platformDeclarationProblems(null), ['declares no capabilities']);
});

test('resolved for Windows: no sandbox, tracked by #990', () => {
  const resolved = resolvePlatform({ platform: 'win32', facts: { encryptionAvailable: true } });
  assert.deepEqual(resolved, {
    executionSandbox: false,
    sandboxGitSsh: false,
    selfUpdate: true,
    secureStorage: true,
    gaps: {
      executionSandbox: { reason: 'approval.isolation.reason.platform', issue: 990 },
      sandboxGitSsh: { reason: 'approval.isolation.reason.platform', issue: 990 },
    },
  });
});

test('resolved for a Linux system package: no self-update, for good; Git over SSH through the relay (#1155)', () => {
  const resolved = resolvePlatform({ platform: 'linux', variant: PLATFORM_VARIANTS.LINUX_PACKAGE, facts: { encryptionAvailable: true } });
  assert.equal(resolved.executionSandbox, true);
  assert.equal(resolved.selfUpdate, false);
  assert.equal(resolved.sandboxGitSsh, true);
  assert.deepEqual(resolved.gaps, {
    selfUpdate: { reason: 'update.reason.package', permanent: true },
  });
  // The AppImage and the extracted folder are plain Linux.
  assert.equal(resolvePlatform({ platform: 'linux' }).selfUpdate, true);
  // A variant of another platform changes nothing.
  assert.equal(platformDeclaration('darwin', PLATFORM_VARIANTS.LINUX_PACKAGE), platformDeclaration('darwin'));
});

test('encrypted storage follows the fact read at start, and its gap is permanent', () => {
  for (const platform of Object.values(PLATFORMS)) {
    assert.equal(resolvePlatform({ platform, facts: { encryptionAvailable: true } }).secureStorage, true, platform);
    const without = resolvePlatform({ platform, facts: { encryptionAvailable: false } });
    assert.equal(without.secureStorage, false, platform);
    assert.deepEqual(without.gaps.secureStorage, { reason: 'settings.error.encryptionUnavailable', permanent: true }, platform);
  }
  assert.throws(() => platformSupports('linux', SECURE_STORAGE), /depends on the running system/);
});

test('a platform Snotra does not ship for has every capability off', () => {
  const resolved = resolvePlatformCapabilities(platformDeclaration('freebsd'), { encryptionAvailable: true });
  for (const name of Object.values(PLATFORM_CAPABILITIES)) {
    assert.equal(resolved[name], false, name);
    assert.equal(resolved.gaps[name].permanent, true, name);
  }
  assert.equal(platformSupports('freebsd', EXECUTION_SANDBOX), false);
});

test('the running platform: the install path picks the variant, safeStorage the fact', () => {
  const app = (exe) => ({ getPath: () => exe, isPackaged: true });
  const packaged = resolveRunningPlatform({
    app: app('/usr/lib/snotra-agent/snotra-agent'),
    safeStorage: { isEncryptionAvailable: () => false },
    platform: 'linux',
    env: {},
  });
  assert.equal(packaged.selfUpdate, false);
  assert.equal(packaged.secureStorage, false);

  const appImage = resolveRunningPlatform({
    app: app('/tmp/.mount_snotra/snotra-agent'),
    safeStorage: { isEncryptionAvailable: () => true },
    platform: 'linux',
    env: { APPIMAGE: '/home/me/Snotra.AppImage' },
  });
  assert.equal(appImage.selfUpdate, true);
  assert.equal(appImage.secureStorage, true);

  const throwing = resolveRunningPlatform({
    app: { getPath: () => { throw new Error('not ready'); } },
    safeStorage: { isEncryptionAvailable: () => { throw new Error('not ready'); } },
    platform: 'darwin',
    execPath: '/Applications/Snotra Agent.app/Contents/MacOS/Snotra Agent',
  });
  assert.equal(throwing.secureStorage, false);
  assert.equal(throwing.executionSandbox, true);
});

test('whether a feature exists is read from the register', () => {
  // The update dialog's reason for a system package is the register's.
  const target = detectInstallTarget({ platform: 'linux', execPath: '/opt/Snotra Agent/snotra-agent', env: {} });
  assert.equal(target.kind, 'linux-package');
  assert.equal(target.canSelfUpdate, false);
  assert.deepEqual(target.reason, { key: platformDeclaration('linux', PLATFORM_VARIANTS.LINUX_PACKAGE)[SELF_UPDATE].reason });

  // The prompt for an execution tool says there is no sandbox where the register says so.
  const t = createTranslator('en');
  const variantOf = (platform) => executionSwitchDialog('shellExecutionEnabled', t, platform).detail;
  assert.match(variantOf('win32'), /There is no sandbox on this system/);
  assert.doesNotMatch(variantOf('linux'), /There is no sandbox on this system/);
  assert.equal(variantOf('linux'), variantOf('darwin'));
});

test('the renderer never asks for Windows by name; it reads the register', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'vendor') walk(full);
      } else if (entry.name.endsWith('.js') && /[!=]==\s*'win32'|'win32'\s*[!=]==/.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'src', 'renderer'));
  assert.deepEqual(offenders, []);
});
