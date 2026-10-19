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
 * Every "not isolated" line is a warning, not an error (#396): the tool still
 * runs, only without the sandbox — the same amber as on the pill and the card.
 *
 * @param {object|undefined} sandbox  `describe()` of the sandbox service
 * @param {boolean} enabled           whether the tool is switched on
 * @param {{workspaceDisabled?: boolean}} [options]  the user switched the
 *   sandbox off for the open workspace (#357)
 * @returns {{text: string, isWarning: boolean}|null}  null: show nothing
 */
export function describeSandboxStatus(sandbox, enabled, { workspaceDisabled = false } = {}) {
  if (!enabled || !sandbox || typeof sandbox !== 'object') return null;
  // The user's own choice outranks what the sandbox could do — except on
  // Windows, where there is nothing to switch off.
  if (workspaceDisabled && sandbox.reason !== 'platform') {
    return { text: t('settings.sandbox.reason.workspace'), isWarning: true };
  }
  if (sandbox.isolated === true) return { text: t('settings.sandbox.isolated'), isWarning: false };
  if (sandbox.status === 'unknown' || sandbox.status === 'testing') {
    return { text: t('settings.sandbox.pending'), isWarning: false };
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
  return { text: t(key, { packages: missing, detail }), isWarning: true };
}

/**
 * The shield next to the folder name (#398), from the tool permission state.
 *
 * Shown while a folder is open and an execution tool is on — only those runs
 * are sandboxed. Struck through and amber when a run would not be isolated,
 * whatever the reason: the same state as on the pill and the card. A sandbox
 * still being checked shows the plain shield, so the name does not jump when
 * the answer arrives.
 *
 * @param {object|null} state  tool permission state from main
 * @returns {{visible: boolean, unisolated: boolean, text: string}}
 */
export function describeFolderSandbox(state) {
  const isolation = state?.executionIsolation;
  // Main lists the execution tools that are on (#1008); their names are shown.
  const tools = (Array.isArray(isolation?.tools) ? isolation.tools : [])
    .filter((entry) => typeof entry === 'string' && entry);
  const root = typeof state?.workspaceRoot === 'string' ? state.workspaceRoot : '';
  if (!root || tools.length === 0) return { visible: false, unisolated: false, text: '' };
  const names = tools.join(t('chat.toolMode.unisolated.and'));
  if (isolation.unisolated === true) {
    const key = isolation.reason === 'workspace' ? 'sidebar.sandbox.off.workspace' : 'sidebar.sandbox.off.system';
    return { visible: true, unisolated: true, text: t(key, { tools: names }) };
  }
  const key = isolation.pending === true ? 'sidebar.sandbox.pending' : 'sidebar.sandbox.on';
  return { visible: true, unisolated: false, text: t(key, { tools: names }) };
}
