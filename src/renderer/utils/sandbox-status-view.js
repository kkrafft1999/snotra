/**
 * Isolation status line of the execution tools in the settings (#329).
 *
 * The approval card says per run whether it is isolated; the settings say
 * why not and what to do about it. Only shown for a switched-on tool — the
 * detection does not run for a tool nobody uses.
 */
import { t } from '../i18n.js';

const REASON_KEYS = Object.freeze({
  platform: 'settings.sandbox.reason.platform',
  dependencies: 'settings.sandbox.reason.dependencies',
  'self-test': 'settings.sandbox.reason.selfTest',
  start: 'settings.sandbox.reason.start',
});

/**
 * @param {object|undefined} sandbox  `describe()` of the sandbox service
 * @param {boolean} enabled           whether the tool is switched on
 * @returns {{text: string, isError: boolean}|null}  null: show nothing
 */
export function describeSandboxStatus(sandbox, enabled) {
  if (!enabled || !sandbox || typeof sandbox !== 'object') return null;
  if (sandbox.isolated === true) return { text: t('settings.sandbox.isolated'), isError: false };
  if (sandbox.status === 'unknown' || sandbox.status === 'testing') {
    return { text: t('settings.sandbox.pending'), isError: false };
  }
  const missing = Array.isArray(sandbox.missing) && sandbox.missing.length > 0
    ? sandbox.missing.join(', ')
    : 'bubblewrap, socat, ripgrep';
  const detail = typeof sandbox.detail === 'string' && sandbox.detail ? ` (${sandbox.detail})` : '';
  // The user-namespace hint only helps on Linux; on macOS a failing
  // self-test has no switch to flip.
  const key = sandbox.reason === 'self-test' && sandbox.platform === 'darwin'
    ? 'settings.sandbox.reason.selfTestMac'
    : REASON_KEYS[sandbox.reason] || REASON_KEYS.start;
  return { text: t(key, { packages: missing, detail }), isError: true };
}
