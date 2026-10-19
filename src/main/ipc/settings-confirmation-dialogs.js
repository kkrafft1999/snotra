'use strict';

/**
 * The prompts of the settings that loosen a protection (#1104): an execution
 * tool switched on, a local MCP command stored. Built for the language the
 * interface speaks when they open, like the permission dialogs (#353), and
 * shown through the user-confirmation port — cancel is always the default.
 */

const { menuPath } = require('../../shared/i18n/ui-quotes');
const { PLATFORM_CAPABILITIES } = require('../../shared/contracts/platform-capabilities');
const { platformSupports } = require('../platforms');

/** Where the switches live, quoted in the prompt. */
const EXECUTION_SETTING_PAGE = 'settings.security';

/** A command line can be long; the prompt keeps it readable. */
const COMMAND_MAX_CHARS = 600;

const EXECUTION_DIALOG_KEYS = Object.freeze({
  shellExecutionEnabled: 'settingsDialog.shell',
  pythonExecutionEnabled: 'settingsDialog.python',
});

/**
 * @param {'shellExecutionEnabled'|'pythonExecutionEnabled'} pref
 * @param {(key: string, params?: object) => string & {}} t  a translator with `t.locale`
 * @param {string} platform  where there is no sandbox (Windows), the prompt says so
 */
function executionSwitchDialog(pref, t, platform) {
  const base = EXECUTION_DIALOG_KEYS[pref];
  const variant = platformSupports(platform, PLATFORM_CAPABILITIES.EXECUTION_SANDBOX) ? 'sandboxed' : 'unisolated';
  return {
    type: 'warning',
    title: t(`${base}.title`),
    message: t(`${base}.title`),
    detail: t(`${base}.detail.${variant}`, {
      mode: t('permissions.mode.auto'),
      place: menuPath(t.locale, EXECUTION_SETTING_PAGE),
    }),
    buttons: [t('settingsDialog.execution.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

/** An argument as a shell would need it to read as one word. */
function quoteArg(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandLine(command, args) {
  const line = [command, ...(Array.isArray(args) ? args : [])].map(quoteArg).join(' ');
  return line.length > COMMAND_MAX_CHARS ? `${line.slice(0, COMMAND_MAX_CHARS - 1)}…` : line;
}

/**
 * @param {{ label: string, command: string, args: string[], cwd: string, envKeys: string[] }} server
 *   what `mcpSettings.launchConfirmation` describes — variable names, never values
 * @param {(key: string, params?: object) => string} t
 */
function mcpLaunchDialog(server, t) {
  const folder = server.cwd ? `\n${t('settingsDialog.mcpLaunch.folder', { cwd: server.cwd })}` : '';
  const env = server.envKeys.length > 0
    ? `\n${t('settingsDialog.mcpLaunch.env', { names: server.envKeys.join(', ') })}`
    : '';
  return {
    type: 'warning',
    title: t('settingsDialog.mcpLaunch.title'),
    message: t('settingsDialog.mcpLaunch.title'),
    detail: t('settingsDialog.mcpLaunch.detail', {
      label: server.label,
      command: commandLine(server.command, server.args),
      folder,
      env,
    }),
    buttons: [t('settingsDialog.mcpLaunch.confirm'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  };
}

module.exports = { executionSwitchDialog, mcpLaunchDialog, EXECUTION_DIALOG_KEYS };
