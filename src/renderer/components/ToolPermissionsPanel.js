import {
  ruleEffectOptions,
  ruleScopeOptions,
  resetActions as resetActionOptions,
  sessionGrantGroups,
  legacyWriteMigrationHint,
  ruleClassOptions,
  validateRuleDraft,
  validateSensitivePattern,
  integrityWarning,
} from '../utils/tool-approval-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { t, tMessage, onLocaleChange, getLocale } from '../i18n.js';

const TRASH_ICON_HTML =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

/**
 * The permission controls of Settings › Security (#67, #449; concept §3/§7/§8):
 * the rule form, the sensitive path patterns, the list of session approvals,
 * the reset actions and the integrity and migration hints.
 *
 * They take effect at once through main, whose policy file it is; loosening
 * (a lasting allowance, deleting a block) is confirmed there in a native
 * dialog. The renderer shows the state and phrases requests; it decides
 * nothing. Since #449 the rules are listed per risk class by SecurityPanel.js,
 * which also opens the rule form in the row it belongs to; the chat's mode is
 * set in the chat only.
 */
export function initToolPermissionsPanel({ toolPermissions }) {
  const migrationHint = document.getElementById('settings-permissions-migration');
  const integrityHint = document.getElementById('settings-permissions-integrity');
  const errorEl = document.getElementById('settings-permissions-error');
  const ruleForm = document.getElementById('settings-rule-form');
  const ruleEffect = document.getElementById('rule-effect');
  const ruleScope = document.getElementById('rule-scope');
  const ruleSubjectType = document.getElementById('rule-subject-type');
  const ruleTool = document.getElementById('rule-tool');
  const ruleClass = document.getElementById('rule-class');
  const rulePattern = document.getElementById('rule-pattern');
  const ruleError = document.getElementById('settings-rule-error');
  const sensitiveList = document.getElementById('settings-sensitive-list');
  const sensitiveEmpty = document.getElementById('settings-sensitive-empty');
  const sensitiveInput = document.getElementById('input-sensitive-pattern');
  const btnSensitiveAdd = document.getElementById('btn-sensitive-add');
  const sensitiveError = document.getElementById('settings-sensitive-error');
  const resetActions = document.getElementById('settings-reset-actions');
  const grantsList = document.getElementById('settings-grants');
  const grantsEmpty = document.getElementById('settings-grants-empty');
  const grantsStatus = document.getElementById('status-session-grants');
  const btnRevokeAll = document.getElementById('btn-grants-revoke-all');

  if (!resetActions || !toolPermissions) return { open: async () => {}, close() {} };

  let toolCatalog = [];
  let isOpen = false;
  let unsubscribe = null;
  /** The last state drawn — needed to redraw after a language change. */
  let lastState = null;

  function setError(target, text) {
    if (!target) return;
    target.textContent = text || '';
    target.classList.toggle('hidden', !text);
  }

  function reportResult(target, result, fallbackError) {
    if (result?.ok) {
      setError(target, '');
      return true;
    }
    if (isCancelledResult(result)) {
      setError(target, t('settings.permissions.dialogCancelled'));
      return false;
    }
    setError(target, tMessage(result?.error) || fallbackError || t('settings.permissions.actionFailed'));
    return false;
  }

  // ── The rule form ───────────────────────────────────────────────────────
  function fillSelect(select, options, keepValue = true) {
    if (!select) return;
    const previous = keepValue ? select.value : '';
    select.innerHTML = '';
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }
    if (previous && options.some((o) => o.value === previous)) select.value = previous;
  }

  function renderRuleForm(state) {
    fillSelect(ruleEffect, ruleEffectOptions());
    fillSelect(ruleScope, ruleScopeOptions());
    if (ruleScope) {
      const hasWorkspace = typeof state?.workspaceRoot === 'string' && state.workspaceRoot;
      const workspaceOption = ruleScope.querySelector('option[value="workspace"]');
      if (workspaceOption) workspaceOption.disabled = !hasWorkspace;
      if (!hasWorkspace) ruleScope.value = 'global';
    }
    fillSelect(
      ruleTool,
      toolCatalog.map((tool) => ({ value: tool.name, label: tool.name }))
    );
    fillSelect(ruleClass, ruleClassOptions(ruleEffect?.value));
    syncRuleSubjectFields();
  }

  function syncRuleSubjectFields() {
    const byTool = ruleSubjectType?.value === 'tool';
    ruleTool?.closest('.settings-rule-form__field')?.classList.toggle('hidden', !byTool);
    ruleClass?.closest('.settings-rule-form__field')?.classList.toggle('hidden', byTool);
  }

  ruleEffect?.addEventListener('change', () => fillSelect(ruleClass, ruleClassOptions(ruleEffect.value)));
  ruleSubjectType?.addEventListener('change', syncRuleSubjectFields);

  ruleForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const state = toolPermissions.get();
    const draft = validateRuleDraft({
      effect: ruleEffect?.value,
      scope: ruleScope?.value,
      subjectType: ruleSubjectType?.value,
      tool: ruleTool?.value,
      riskClass: ruleClass?.value,
      pathPattern: rulePattern?.value,
      hasWorkspace: typeof state?.workspaceRoot === 'string' && !!state.workspaceRoot,
    });
    if (!draft.ok) {
      setError(ruleError, draft.error);
      return;
    }
    const result = await toolPermissions.addRule(draft.rule);
    if (reportResult(ruleError, result)) {
      if (rulePattern) rulePattern.value = '';
      // The Security page closes the form it opened in a row.
      ruleForm.dispatchEvent(new CustomEvent('rule-added', { detail: draft.rule }));
    }
  });

  // ── Sensible Pfadmuster ──────────────────────────────────────────────────
  /** After a removal: focus the remove button at this index, or the input. */
  let sensitiveFocusIndex = null;

  function renderSensitive(state) {
    const patterns = Array.isArray(state?.sensitivePathPatterns) ? state.sensitivePathPatterns : [];
    if (sensitiveList) {
      // The list is rebuilt on every push; a focused button keeps its focus
      // when its pattern is still there (CR-B13-03).
      const focused = sensitiveList.contains(document.activeElement) ? document.activeElement?.dataset?.pattern : null;
      sensitiveList.innerHTML = '';
      for (const pattern of patterns) {
        const li = document.createElement('li');
        li.className = 'settings-rule-item';
        const codeEl = document.createElement('code');
        codeEl.className = 'settings-rule-item__pattern';
        codeEl.textContent = pattern;
        li.appendChild(codeEl);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'settings-icon-trash';
        remove.dataset.pattern = pattern;
        remove.setAttribute('aria-label', t('settings.sensitive.remove', { pattern }));
        remove.innerHTML = TRASH_ICON_HTML;
        li.appendChild(remove);
        sensitiveList.appendChild(li);
      }
      const buttons = [...sensitiveList.querySelectorAll('button[data-pattern]')];
      if (sensitiveFocusIndex !== null) {
        const target = buttons[Math.min(sensitiveFocusIndex, buttons.length - 1)] || sensitiveInput;
        sensitiveFocusIndex = null;
        target?.focus();
      } else if (focused) {
        buttons.find((button) => button.dataset.pattern === focused)?.focus();
      }
    }
    sensitiveEmpty?.classList.toggle('hidden', patterns.length > 0);
  }

  async function saveSensitive(patterns) {
    const result = await toolPermissions.setSensitivePathPatterns(patterns);
    return reportResult(sensitiveError, result);
  }

  sensitiveList?.addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-pattern]');
    if (!button) return;
    const current = toolPermissions.get()?.sensitivePathPatterns || [];
    // The redraw after the removal moves the focus on to the next pattern.
    sensitiveFocusIndex = [...sensitiveList.querySelectorAll('button[data-pattern]')].indexOf(button);
    if (!await saveSensitive(current.filter((p) => p !== button.dataset.pattern))) sensitiveFocusIndex = null;
  });

  async function addSensitive() {
    const current = toolPermissions.get()?.sensitivePathPatterns || [];
    const check = validateSensitivePattern(sensitiveInput?.value, current);
    if (!check.ok) {
      setError(sensitiveError, check.error);
      return;
    }
    if (await saveSensitive([...current, check.pattern]) && sensitiveInput) sensitiveInput.value = '';
  }

  btnSensitiveAdd?.addEventListener('click', () => void addSensitive());
  sensitiveInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void addSensitive();
  });

  // ── Session allowances (#447) ───────────────────────────────────────────
  /** After a revoke: focus the revoke button at this index, or the empty hint. */
  let grantFocusIndex = null;
  let grantStatusTimer = null;

  function formatGrantTime(ms) {
    try {
      return new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleTimeString();
    }
  }

  function showGrantStatus(key) {
    if (!grantsStatus) return;
    clearTimeout(grantStatusTimer);
    grantsStatus.textContent = t(key);
    grantsStatus.classList.add('is-visible');
    grantStatusTimer = setTimeout(() => grantsStatus.classList.remove('is-visible'), 2400);
  }

  function renderGrants(state) {
    if (!grantsList) return;
    const groups = sessionGrantGroups(state?.sessionGrants, { formatTime: formatGrantTime });
    // A push can redraw the list at any time (a card granted in the chat); a
    // focused revoke button keeps its focus if its approval is still there.
    const focusedId = grantsList.contains(document.activeElement) ? document.activeElement?.dataset?.grantId : null;
    grantsList.innerHTML = '';
    for (const group of groups) {
      const section = document.createElement('section');
      section.className = 'settings-grants__group';
      const label = document.createElement('h4');
      label.className = 'settings-grants__group-label';
      label.textContent = group.label;
      section.appendChild(label);
      const list = document.createElement('ul');
      list.className = 'settings-rule-list';
      for (const item of group.items) {
        const li = document.createElement('li');
        li.className = 'settings-rule-item settings-grant';
        const text = document.createElement('div');
        text.className = 'settings-grant__text';
        const scope = document.createElement('span');
        scope.className = 'settings-grant__scope';
        scope.textContent = item.text;
        const meta = document.createElement('span');
        meta.className = 'settings-grant__meta';
        meta.textContent = item.meta;
        text.appendChild(scope);
        text.appendChild(meta);
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'btn-secondary';
        revoke.dataset.grantId = item.id;
        revoke.textContent = t('settings.grants.revoke');
        revoke.setAttribute('aria-label', t('settings.grants.revokeLabel', { text: item.text }));
        li.appendChild(text);
        li.appendChild(revoke);
        list.appendChild(li);
      }
      section.appendChild(list);
      grantsList.appendChild(section);
    }
    const count = groups.reduce((sum, group) => sum + group.items.length, 0);
    grantsEmpty?.classList.toggle('hidden', count > 0);
    btnRevokeAll?.closest('.settings-grants__footer')?.classList.toggle('hidden', count === 0);
    const refocus = focusedId && grantFocusIndex === null
      ? [...grantsList.querySelectorAll('button[data-grant-id]')].find((el) => el.dataset.grantId === focusedId)
      : null;
    if (refocus) refocus.focus();
    if (grantFocusIndex !== null) {
      const buttons = [...grantsList.querySelectorAll('button[data-grant-id]')];
      const target = buttons[Math.min(grantFocusIndex, buttons.length - 1)];
      grantFocusIndex = null;
      if (target) target.focus();
      else if (grantsEmpty) {
        grantsEmpty.tabIndex = -1;
        grantsEmpty.focus();
      }
    }
  }

  grantsList?.addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-grant-id]');
    if (!button || button.disabled) return;
    const buttons = [...grantsList.querySelectorAll('button[data-grant-id]')];
    button.disabled = true;
    grantFocusIndex = buttons.indexOf(button);
    const result = await toolPermissions.revokeSessionGrant(button.dataset.grantId);
    if (reportResult(errorEl, result)) showGrantStatus('settings.grants.revoked');
    else {
      grantFocusIndex = null;
      button.disabled = false;
      // Disabling it dropped the focus; it goes back where it was (CR-B13-03).
      if (button.isConnected) button.focus();
    }
  });

  btnRevokeAll?.addEventListener('click', async () => {
    grantFocusIndex = 0;
    const result = await toolPermissions.clearSessionGrants();
    if (reportResult(errorEl, result)) showGrantStatus('settings.grants.revokedAll');
    else grantFocusIndex = null;
  });

  // ── Zurücksetzen ─────────────────────────────────────────────────────────
  function renderResets(state) {
    if (!resetActions) return;
    // Rebuilt after every action and push; the focused button keeps its focus
    // (CR-B13-03).
    const focusedKey = resetActions.contains(document.activeElement) ? document.activeElement?.dataset?.reset : null;
    resetActions.innerHTML = '';
    const hasWorkspace = typeof state?.workspaceRoot === 'string' && !!state.workspaceRoot;
    for (const action of resetActionOptions()) {
      const row = document.createElement('div');
      row.className = 'settings-reset-row';
      const text = document.createElement('div');
      text.className = 'settings-reset-row__text';
      const title = document.createElement('span');
      title.className = 'settings-reset-row__title';
      title.id = `settings-reset-${action.key}-title`;
      title.textContent = action.label;
      const desc = document.createElement('span');
      desc.className = 'settings-reset-row__desc';
      desc.id = `settings-reset-${action.key}-desc`;
      desc.textContent = action.description;
      text.appendChild(title);
      text.appendChild(desc);
      row.appendChild(text);
      const controls = document.createElement('div');
      controls.className = 'settings-reset-row__controls';
      // Main confirms in a native dialog where one is needed (#514); the
      // ellipsis says that one always follows here.
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-secondary';
      button.dataset.reset = action.key;
      button.textContent = action.confirm ? t('settings.reset.running') : t('settings.reset.run');
      // "Run" alone does not say what runs: the row's title and text do
      // (CR-B13-06, WCAG 2.4.6).
      button.setAttribute('aria-describedby', `${title.id} ${desc.id}`);
      button.disabled = !state || (action.key === 'workspace' && !hasWorkspace);
      controls.appendChild(button);
      row.appendChild(controls);
      resetActions.appendChild(row);
    }
    if (focusedKey) resetActions.querySelector(`button[data-reset="${focusedKey}"]:not([disabled])`)?.focus();
  }

  resetActions?.addEventListener('click', async (e) => {
    const button = e.target.closest('button[data-reset]');
    if (!button) return;
    const key = button.dataset.reset;
    if (!resetActionOptions().some((a) => a.key === key)) return;
    let result;
    if (key === 'workspace') result = await toolPermissions.resetWorkspaceRules();
    else result = await toolPermissions.resetAll();
    reportResult(errorEl, result);
    renderResets(toolPermissions.get());
  });

  // ── Gesamt ───────────────────────────────────────────────────────────────
  function render(state) {
    if (!isOpen) return;
    lastState = state;
    renderRuleForm(state);
    renderSensitive(state);
    renderGrants(state);
    renderResets(state);
    if (migrationHint) {
      migrationHint.textContent = legacyWriteMigrationHint();
      migrationHint.classList.toggle('hidden', state?.legacyWriteMigrated !== true);
    }
    setError(integrityHint, integrityWarning(state?.integrity));
    if (!state) setError(errorEl, t('settings.permissions.loadFailed'));
    else if (errorEl?.textContent === t('settings.permissions.loadFailed')) setError(errorEl, '');
  }

  // Language change (epic #277): the form's options and the reset actions
  // take their text from `tool-approval-view` and are built here. With the
  // section closed nothing happens — `open()` draws afresh anyway.
  onLocaleChange(() => {
    if (!isOpen) return;
    render(lastState);
  });

  return {
    async open(catalog) {
      toolCatalog = Array.isArray(catalog) ? catalog : [];
      isOpen = true;
      setError(errorEl, '');
      setError(ruleError, '');
      setError(sensitiveError, '');
      unsubscribe?.();
      unsubscribe = toolPermissions.subscribe(render);
      render(await toolPermissions.refresh());
    },
    close() {
      isOpen = false;
      unsubscribe?.();
      unsubscribe = null;
    },
    /** The form's selects follow the catalog; SecurityPanel sets them after. */
    refreshRuleForm() {
      renderRuleForm(toolPermissions.get());
    },
    setRuleError(text) {
      setError(ruleError, text);
    },
    /** A rule removed from a row of the Security page reports here. */
    report(result) {
      return reportResult(errorEl, result);
    },
  };
}
