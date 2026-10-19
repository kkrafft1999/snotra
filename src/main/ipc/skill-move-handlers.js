'use strict';

const { createTranslator } = require('../../shared/i18n');
const { CONFIRMATION_ACTIONS, createRefusingConfirmation } = require('../../application/permissions/user-confirmation');

/** The reason codes of `planMakeGlobal`/`makeGlobal`, as catalogue keys. */
const ERROR_KEYS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  'not-found': 'skills.makeGlobal.error.notFound',
  'no-workspace': 'skills.makeGlobal.error.noWorkspace',
  'no-home': 'skills.makeGlobal.error.noHome',
}));

/**
 * "Make global" for a workspace skill (#764). The renderer only names the
 * skill; which folder that is, where it goes and whether the user agrees are
 * decided here, with a native confirmation — the same pattern as taking files
 * over (#101): the renderer is not a security boundary
 * (docs/security-concept.md §5). No tool reaches this, so the model still
 * never writes outside the open folder (#160, #548).
 *
 * The confirmation goes through the user-confirmation port (#980); `dialog`
 * is left with the error notices.
 *
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {Record<string, string>} deps.REQ
 * @param {Pick<ReturnType<typeof import('../services/skills-service').createSkillsService>,
 *   'planMakeGlobal' | 'makeGlobal' | 'switchOnAfterMakeGlobal'>} deps.skillsService
 * @param {import('../ports/ui-prefs-store-port').UiPrefsStorePort} deps.uiPrefsStore
 * @param {() => string|null} [deps.getActiveWorkspaceRoot]
 * @param {Pick<import('electron').Dialog, 'showMessageBox'>|null} [deps.dialog]
 * @param {import('../../application/ports/user-confirmation-port').UserConfirmationPort} [deps.confirmations]
 * @param {() => (import('electron').BrowserWindow|null)} [deps.getMainWindow]
 * @param {() => string|null} [deps.getLocale]
 */
function registerSkillMoveHandlers({
  ipcMain,
  REQ,
  skillsService,
  uiPrefsStore,
  getActiveWorkspaceRoot = () => null,
  dialog = null,
  confirmations = createRefusingConfirmation(),
  getMainWindow = () => null,
  getLocale = () => null,
}) {
  /**
   * @param {import('electron').MessageBoxOptions} options
   */
  function showMessageBox(options) {
    // The handler below answers before it gets here when there is no dialog.
    if (!dialog) throw new Error('No dialog to show.');
    const win = getMainWindow();
    return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  }

  /**
   * @param {ReturnType<typeof createTranslator>} t
   * @param {string} message
   * @param {string} detail
   */
  async function tell(t, message, detail) {
    await showMessageBox({ type: 'error', buttons: [t('skills.makeGlobal.ok')], noLink: true, message, detail });
  }

  ipcMain.handle(REQ.SKILLS_MAKE_GLOBAL, async (_event, name) => {
    const t = createTranslator(getLocale());
    if (!dialog || !confirmations.canConfirm()) return { error: t('skills.makeGlobal.error.noDialog') };
    const root = getActiveWorkspaceRoot();
    const workspaceRoot = typeof root === 'string' && root.trim() ? root : null;
    const skillName = typeof name === 'string' ? name : '';

    const plan = await skillsService.planMakeGlobal({ workspaceRoot, name: skillName });
    if (plan.error) {
      const message = t(ERROR_KEYS[plan.error] || 'skills.makeGlobal.error.notFound');
      await tell(t, t('skills.makeGlobal.failed.title'), message);
      return { error: message };
    }
    if (plan.conflict) {
      await tell(t, t('skills.makeGlobal.conflict.title', { name: plan.name }), t('skills.makeGlobal.conflict.detail', { to: plan.to }));
      return { error: t('skills.makeGlobal.conflict.title', { name: plan.name }), conflict: true };
    }

    const prefs = await uiPrefsStore.readUIPrefs();
    const switchedOn = await skillsService.switchOnAfterMakeGlobal({
      workspaceRoot,
      name: plan.name,
      activeSkills: Array.isArray(prefs.activeSkills) ? prefs.activeSkills : null,
      activeWorkspaceSkills: prefs.activeWorkspaceSkills || null,
    });
    const detail = [
      t('skills.makeGlobal.confirm.detail'),
      switchedOn ? t('skills.makeGlobal.confirm.switchedOn') : null,
      `${t('skills.makeGlobal.confirm.from')} ${plan.from}\n${t('skills.makeGlobal.confirm.to')} ${plan.to}`,
    ].filter(Boolean).join('\n\n');
    const outcome = await confirmations.confirm({
      action: CONFIRMATION_ACTIONS.SKILL_MAKE_GLOBAL,
      subject: plan.name,
      prompt: {
        type: 'question',
        buttons: [t('skills.makeGlobal.confirm.move'), t('skills.makeGlobal.confirm.cancel')],
        // Cancel is the default and the Escape answer: Enter moves nothing (#59).
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: t('skills.makeGlobal.confirm.message', { name: plan.name }),
        detail,
      },
    });
    if (!outcome.confirmed) return { cancelled: true };

    let result;
    try {
      result = await skillsService.makeGlobal({ workspaceRoot, name: plan.name });
    } catch (error) {
      await tell(t, t('skills.makeGlobal.failed.title'), error?.message || String(error));
      return { error: t('skills.makeGlobal.failed.title') };
    }
    if (result.error === 'conflict') {
      await tell(t, t('skills.makeGlobal.conflict.title', { name: plan.name }), t('skills.makeGlobal.conflict.detail', { to: result.to }));
      return { error: t('skills.makeGlobal.conflict.title', { name: plan.name }), conflict: true };
    }
    if (result.error) {
      const message = t(ERROR_KEYS[result.error] || 'skills.makeGlobal.error.notFound');
      await tell(t, t('skills.makeGlobal.failed.title'), message);
      return { error: message };
    }

    // Read again under the lock: the switch-on is carried over on what is
    // stored now, not on the copy read before the dialog.
    await uiPrefsStore.updateUIPrefs(async (out) => {
      const next = await skillsService.switchOnAfterMakeGlobal({
        workspaceRoot,
        name: plan.name,
        activeSkills: Array.isArray(out.activeSkills) ? out.activeSkills : null,
        activeWorkspaceSkills: out.activeWorkspaceSkills || null,
      });
      return next ? Object.assign(out, next) : out;
    });
    return { ok: true, name: plan.name, to: result.to };
  });
}

module.exports = { registerSkillMoveHandlers };
