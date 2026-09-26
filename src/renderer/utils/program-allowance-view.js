import { t } from '../i18n.js';

/**
 * Program allowances as the interface shows them (#408): a row in
 * Settings › Tools and a sentence on the approval card. Pure functions over
 * what main sends, so both places say the same.
 */

/** `/Users/me/x` → `~/x`; anything outside the home folder stays as it is. */
export function tildePath(value, homeDir = '') {
  if (typeof value !== 'string') return '';
  if (!homeDir) return value;
  if (value === homeDir) return '~';
  return value.startsWith(`${homeDir}/`) ? `~${value.slice(homeDir.length)}` : value;
}

/** File name of a program path. */
export function programLabel(programPath) {
  return typeof programPath === 'string' ? programPath.split('/').pop() || programPath : '';
}

/**
 * One row of the settings list: the program, where it lives, and the rights
 * it adds — only those it actually has. `weaker` marks trustd.
 */
export function describeAllowanceRow(entry, { homeDir = '' } = {}) {
  const facts = [];
  if (Array.isArray(entry?.domains) && entry.domains.length > 0) {
    facts.push({ label: t('settings.allowances.fact.network'), values: entry.domains, mono: true });
  }
  if (Array.isArray(entry?.writePaths) && entry.writePaths.length > 0) {
    facts.push({
      label: t('settings.allowances.fact.folders'),
      values: entry.writePaths.map((folder) => tildePath(folder, homeDir)),
      mono: true,
    });
  }
  if (entry?.trustd === true) {
    facts.push({
      label: t('settings.allowances.fact.certificates'),
      values: [t('settings.allowances.certificates.macos')],
      mono: false,
      tag: t('settings.allowances.weaker'),
    });
  }
  return {
    name: programLabel(entry?.path),
    pathLabel: tildePath(entry?.path || '', homeDir),
    facts,
  };
}

const SKIP_KEYS = Object.freeze({
  compound: 'approval.allowance.skipped.compound',
  expansion: 'approval.allowance.skipped.expansion',
  otherFile: 'approval.allowance.skipped.otherFile',
});

/**
 * What the approval card says about a program allowance, or null. Applied:
 * a bold prefix and what the run gets besides the domains, which already
 * stand under "Network". Skipped: one sentence why it stays off.
 */
export function describeAllowanceOnCard(isolation, { homeDir = '' } = {}) {
  if (!isolation || isolation.isolated !== true) return null;
  const settingsLabel = t('approval.allowance.settings');
  const granted = isolation.allowance;
  if (granted && typeof granted.program === 'string' && granted.program) {
    const folders = (Array.isArray(granted.writePaths) ? granted.writePaths : [])
      .map((folder) => tildePath(folder, homeDir));
    const params = { folders: folders.join(', ') };
    let key = 'approval.allowance.domainsOnly';
    if (folders.length > 0 && granted.trustd) key = 'approval.allowance.both';
    else if (folders.length > 0) key = 'approval.allowance.foldersOnly';
    else if (granted.trustd) key = 'approval.allowance.trustdOnly';
    return {
      kind: 'applied',
      prefix: t('approval.allowance.prefix', { program: granted.program }),
      text: t(key, params),
      settingsLabel,
    };
  }
  const skipped = isolation.allowanceSkipped;
  if (skipped && SKIP_KEYS[skipped.reason] && typeof skipped.program === 'string') {
    return { kind: 'skipped', prefix: '', text: t(SKIP_KEYS[skipped.reason], { program: skipped.program }), settingsLabel };
  }
  return null;
}
