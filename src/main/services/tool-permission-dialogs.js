'use strict';

/**
 * The prompts of the permission changes that loosen a protection (#66, #980):
 * "Auto", an allow rule, a removed block, the sandbox off, hosts and program
 * allowances, a reset. Built for the language the interface speaks when they
 * open, and shown through the user-confirmation port. Moved out of
 * `ipc/tool-permission-handlers.js` with the rules that ask them (#1006).
 */

const { PERMISSION_RULE_SCOPES } = require('../../shared/contracts/tool-permissions');
const { menuPath } = require('../../shared/i18n/ui-quotes');

/**
 * @typedef {ReturnType<typeof import('../../shared/i18n').createTranslator>} Translator
 * @typedef {import('../../application/ports/user-confirmation-port').ConfirmationPrompt} ConfirmationPrompt
 * @typedef {import('../../shared/contracts/tool-permissions').PermissionRule} PermissionRule
 * @typedef {import('../../shared/contracts/tool-permissions').CommandRule} CommandRule
 * @typedef {import('../../shared/contracts/program-allowances').ProgramAllowance} ProgramAllowance
 */

// The three dialogs are built for the language the interface speaks at the
// moment they open (#353). They live only until the click, so there is nothing
// to repaint on a language change.
/**
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function autoModeDialog(t) {
  return {
    type: 'warning',
    title: t('permissionDialog.auto.title'),
    message: t('permissionDialog.auto.title'),
    detail: t('permissionDialog.auto.detail'),
    buttons: [t('permissionDialog.auto.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * @param {PermissionRule} rule
 * @param {Translator} t
 * @returns {string}
 */
function ruleSubject(rule, t) {
  return rule.tool
    ? t('permissionDialog.subject.tool', { tool: rule.tool })
    : t('permissionDialog.subject.class', { riskClass: rule.riskClass });
}

/**
 * @param {PermissionRule} rule
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function allowRuleDialog(rule, t) {
  const scope = rule.scope === PERMISSION_RULE_SCOPES.GLOBAL
    ? t('permissionDialog.scope.global')
    : t('permissionDialog.scope.workspace', { root: rule.root });
  return {
    type: 'warning',
    title: t('permissionDialog.allowRule.title'),
    message: t('permissionDialog.allowRule.title'),
    detail: t('permissionDialog.allowRule.detail', {
      subject: ruleSubject(rule, t),
      pattern: rule.pathPattern,
      scope,
      // Mode and page are quoted from the entries the interface renders, so
      // that the dialog names what the user will actually find.
      mode: t('permissions.mode.smart'),
      place: menuPath(t.locale, 'settings.security'),
    }),
    buttons: [t('permissionDialog.allowRule.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * @param {PermissionRule} rule
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function removeDenyRuleDialog(rule, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.removeDeny.title'),
    message: t('permissionDialog.removeDeny.title'),
    detail: t('permissionDialog.removeDeny.detail', { subject: ruleSubject(rule, t), pattern: rule.pathPattern }),
    buttons: [t('permissionDialog.removeDeny.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * What a reset or a shorter pattern list takes away that protects (#514):
 * blocks, the user's sensitive path patterns, "Always ask" as a default or as
 * the mode on screen. Removing those is a loosening like deleting one deny
 * rule, so main confirms it natively and names what goes. Allow rules,
 * allowances and the sandbox opt-out going is a tightening and is not listed.
 *
 * @param {{ denyRules?: number, patterns?: string[], askAllDefaults?: number, askAllMode?: boolean }} losses
 * @param {Translator} t
 * @returns {string[]}
 */
function protectionLosses({ denyRules = 0, patterns = [], askAllDefaults = 0, askAllMode = false }, t) {
  const lines = [];
  if (denyRules > 0) lines.push(t('permissionDialog.losses.blocks', { count: denyRules }));
  if (patterns.length > 0) lines.push(t('permissionDialog.losses.patterns', { patterns: patterns.join(', ') }));
  if (askAllDefaults > 0) {
    lines.push(t('permissionDialog.losses.askAllDefaults', { count: askAllDefaults, askAll: t('permissions.mode.askAll') }));
  }
  if (askAllMode) lines.push(t('permissionDialog.losses.askAllMode', { askAll: t('permissions.mode.askAll'), smart: t('permissions.mode.smart') }));
  return lines;
}

/**
 * @param {'resetWorkspace'|'resetAll'} kind
 * @param {string[]} losses
 * @param {Translator} t
 * @param {string} [root]
 * @returns {ConfirmationPrompt}
 */
function resetDialog(kind, losses, t, root = '') {
  return {
    type: 'warning',
    title: t(`permissionDialog.${kind}.title`),
    message: t(`permissionDialog.${kind}.title`),
    detail: [
      t(`permissionDialog.${kind}.detail`, { root }),
      ...(losses.length > 0
        ? [t('permissionDialog.losses.intro'), losses.map((line) => `• ${line}`).join('\n')]
        : []),
    ].join('\n\n'),
    buttons: [t(`permissionDialog.${kind}.confirm`), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * @param {string[]} patterns
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function removePatternsDialog(patterns, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.removePatterns.title'),
    message: t('permissionDialog.removePatterns.title'),
    detail: t('permissionDialog.removePatterns.detail', { patterns: patterns.join(', '), smart: t('permissions.mode.smart') }),
    buttons: [t('permissionDialog.removePatterns.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * "Always allow this command" (#121). The dialog repeats exactly what is
 * remembered — command, folder, network — because that is the whole rule:
 * a different spelling of the command is a different command.
 *
 * @param {CommandRule} rule
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function commandRuleDialog(rule, t) {
  const facts = [
    t('permissionDialog.commandRule.command', { command: rule.command }),
    t('permissionDialog.commandRule.cwd', { cwd: rule.cwd || t('permissionDialog.commandRule.cwd.root') }),
    rule.networkDomains.length > 0
      ? t('permissionDialog.commandRule.network', { domains: rule.networkDomains.join(', ') })
      : t('permissionDialog.commandRule.network.none'),
  ];
  return {
    type: 'warning',
    title: t('permissionDialog.commandRule.title'),
    message: t('permissionDialog.commandRule.title'),
    detail: t('permissionDialog.commandRule.detail', {
      facts: facts.join('\n'),
      root: rule.root,
      mode: t('permissions.mode.smart'),
      place: menuPath(t.locale, 'settings.security'),
    }),
    buttons: [t('permissionDialog.commandRule.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * "For this workspace" on a connection card (#946). The dialog repeats what
 * is kept — the hosts and the folder — because that is the whole grant.
 *
 * @param {string[]} hosts
 * @param {string} root
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function workspaceHostsDialog(hosts, root, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.workspaceHosts.title'),
    message: t('permissionDialog.workspaceHosts.title'),
    detail: t('permissionDialog.workspaceHosts.detail', {
      hosts: hosts.join('\n'),
      root,
      place: menuPath(t.locale, SANDBOX_SETTING_PAGE),
    }),
    buttons: [t('permissionDialog.workspaceHosts.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * Where the sandbox switch, the program allowances and the hosts live,
 * quoted in their dialogs (#357) — Settings › Tools › Security since #1119.
 */
const SANDBOX_SETTING_PAGE = 'settings.sandbox';

/**
 * Hosts open in every workspace (#1119): only from the settings, never from a card.
 *
 * @param {string[]} hosts
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function globalHostsDialog(hosts, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.globalHosts.title'),
    message: t('permissionDialog.globalHosts.title'),
    detail: t('permissionDialog.globalHosts.detail', {
      hosts: hosts.join('\n'),
      place: menuPath(t.locale, SANDBOX_SETTING_PAGE),
    }),
    buttons: [t('permissionDialog.globalHosts.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * New workspaces without the sandbox (#1119).
 *
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function newWorkspaceSandboxOffDialog(t) {
  return {
    type: 'warning',
    title: t('permissionDialog.newWorkspaceSandboxOff.title'),
    message: t('permissionDialog.newWorkspaceSandboxOff.title'),
    detail: t('permissionDialog.newWorkspaceSandboxOff.detail', {
      mode: t('permissions.mode.auto'),
      place: menuPath(t.locale, SANDBOX_SETTING_PAGE),
    }),
    buttons: [t('permissionDialog.newWorkspaceSandboxOff.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * "Reset the sandbox everywhere" (#1119): only takes rights away, but all of them.
 *
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function resetSandboxDialog(t) {
  return {
    type: 'warning',
    title: t('permissionDialog.resetSandbox.title'),
    message: t('permissionDialog.resetSandbox.title'),
    detail: t('permissionDialog.resetSandbox.detail'),
    buttons: [t('permissionDialog.resetSandbox.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * @param {string} root
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function sandboxOffDialog(root, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.sandboxOff.title'),
    message: t('permissionDialog.sandboxOff.title'),
    detail: t('permissionDialog.sandboxOff.detail', {
      root,
      mode: t('permissions.mode.auto'),
      place: menuPath(t.locale, SANDBOX_SETTING_PAGE),
    }),
    buttons: [t('permissionDialog.sandboxOff.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * "Auto" for every new chat in one workspace (#413).
 *
 * @param {string} root
 * @param {Translator} t
 * @returns {ConfirmationPrompt}
 */
function workspaceAutoDialog(root, t) {
  return {
    type: 'warning',
    title: t('permissionDialog.workspaceAuto.title'),
    message: t('permissionDialog.workspaceAuto.title'),
    detail: t('permissionDialog.workspaceAuto.detail', {
      root,
      mode: t('permissions.mode.auto'),
      smart: t('permissions.mode.smart'),
      place: menuPath(t.locale, 'settings.security'),
    }),
    buttons: [t('permissionDialog.workspaceAuto.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * `/Users/me/x` → `~/x`, so the dialog reads like the settings list.
 *
 * @param {string} value
 * @param {string} [homeDir]
 * @returns {string}
 */
function tildePath(value, homeDir) {
  if (!homeDir || typeof value !== 'string') return value;
  if (value === homeDir) return '~';
  return value.startsWith(`${homeDir}/`) ? `~${value.slice(homeDir.length)}` : value;
}

/**
 * @param {ProgramAllowance} entry
 * @param {Translator} t
 * @param {string} [homeDir]
 * @param {string|null} [root]
 * @returns {ConfirmationPrompt}
 */
function programAllowanceDialog(entry, t, homeDir = '', root = null) {
  const lines = [];
  if (entry.domains.length > 0) lines.push(t('permissionDialog.allowance.domains', { domains: entry.domains.join(', ') }));
  if (entry.writePaths.length > 0) {
    lines.push(t('permissionDialog.allowance.folders', {
      folders: entry.writePaths.map((folder) => tildePath(folder, homeDir)).join(', '),
    }));
  }
  if (entry.trustd) lines.push(t('permissionDialog.allowance.trustd'));
  const program = entry.path.split('/').pop();
  return {
    type: 'warning',
    title: t('permissionDialog.allowance.title', { program }),
    message: t('permissionDialog.allowance.title', { program }),
    detail: [
      root
        ? t('permissionDialog.allowance.intro.workspace', { path: tildePath(entry.path, homeDir), root: tildePath(root, homeDir) })
        : t('permissionDialog.allowance.intro', { path: tildePath(entry.path, homeDir) }),
      lines.map((line) => `• ${line}`).join('\n'),
      t('permissionDialog.allowance.footer', { place: menuPath(t.locale, SANDBOX_SETTING_PAGE) }),
    ].join('\n\n'),
    buttons: [t('permissionDialog.allowance.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

module.exports = {
  autoModeDialog,
  allowRuleDialog,
  removeDenyRuleDialog,
  sandboxOffDialog,
  workspaceAutoDialog,
  commandRuleDialog,
  workspaceHostsDialog,
  globalHostsDialog,
  newWorkspaceSandboxOffDialog,
  resetSandboxDialog,
  programAllowanceDialog,
  resetDialog,
  removePatternsDialog,
  protectionLosses,
};
