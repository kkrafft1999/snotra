import {
  TOOL_MODE_OPTIONS,
  RULE_EFFECT_OPTIONS,
  RULE_SCOPE_OPTIONS,
  RESET_ACTIONS,
  LEGACY_WRITE_MIGRATION_HINT,
  ruleClassOptions,
  describeRule,
  validateRuleDraft,
  validateSensitivePattern,
  integrityWarning,
  modeLabel,
} from '../utils/tool-approval-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';

const TRASH_ICON_HTML =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

/**
 * Einstellungen › Tools › Berechtigungen (Issue #67, Konzept §3/§7/§8).
 *
 * Modus, Regeln, sensible Pfadmuster und Reset-Aktionen wirken sofort über den
 * Main-Prozess – anders als der Rest des Dialogs nicht erst mit „Übernehmen“,
 * weil die Policy-Datei dem Main gehört und Lockerungen (Auto, dauerhafte
 * Erlaubnis, Sperre löschen) dort in einem nativen Dialog bestätigt werden.
 * Der Renderer zeigt den Stand und formuliert Anfragen; er entscheidet nichts.
 */
export function initToolPermissionsPanel({ toolPermissions }) {
  const modeGroup = document.getElementById('settings-tool-mode-group');
  const migrationHint = document.getElementById('settings-permissions-migration');
  const integrityHint = document.getElementById('settings-permissions-integrity');
  const errorEl = document.getElementById('settings-permissions-error');
  const rulesGlobal = document.getElementById('settings-rules-global');
  const rulesGlobalEmpty = document.getElementById('settings-rules-global-empty');
  const rulesWorkspace = document.getElementById('settings-rules-workspace');
  const rulesWorkspaceEmpty = document.getElementById('settings-rules-workspace-empty');
  const rulesWorkspaceName = document.getElementById('settings-rules-workspace-name');
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

  if (!modeGroup || !toolPermissions) return { open: async () => {}, close() {} };

  let toolCatalog = [];
  let isOpen = false;
  let unsubscribe = null;
  let resetConfirmKey = null;

  function setError(target, text) {
    if (!target) return;
    target.textContent = text || '';
    target.classList.toggle('hidden', !text);
  }

  function reportResult(target, result, successText) {
    if (result?.ok) {
      setError(target, '');
      return true;
    }
    if (isCancelledResult(result)) {
      setError(target, 'Im Systemdialog abgebrochen – nichts geändert.');
      return false;
    }
    setError(target, result?.error || successText || 'Aktion fehlgeschlagen.');
    return false;
  }

  // ── Modus ────────────────────────────────────────────────────────────────
  function renderMode(state) {
    modeGroup.innerHTML = '';
    const legend = document.createElement('legend');
    // Die Karte ist seit #99 mit „Modus" ueberschrieben; die Legend wuerde den
    // Text doppeln, bleibt aber fuer Screenreader als Gruppenname noetig.
    legend.className = 'settings-mode-group__legend visually-hidden';
    legend.textContent = 'Modus';
    modeGroup.appendChild(legend);
    const active = state?.mode || 'smart';
    for (const option of TOOL_MODE_OPTIONS) {
      const label = document.createElement('label');
      label.className = 'settings-mode-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'tool-permission-mode';
      input.value = option.value;
      input.checked = option.value === active;
      input.disabled = !state;
      const main = document.createElement('span');
      main.className = 'settings-mode-option__main';
      const title = document.createElement('span');
      title.className = 'settings-mode-option__title';
      title.textContent = option.label;
      const desc = document.createElement('span');
      desc.className = 'settings-mode-option__desc';
      desc.textContent = option.description;
      main.appendChild(title);
      main.appendChild(desc);
      label.appendChild(input);
      label.appendChild(main);
      modeGroup.appendChild(label);
    }
  }

  modeGroup.addEventListener('change', async (e) => {
    const input = e.target.closest('input[name="tool-permission-mode"]');
    if (!input) return;
    const mode = input.value;
    if (mode === toolPermissions.mode()) return;
    const result = await toolPermissions.setMode(mode);
    if (!reportResult(errorEl, result)) renderMode(toolPermissions.get());
    else setError(errorEl, '');
  });

  // ── Regeln ───────────────────────────────────────────────────────────────
  function ruleRow(rule) {
    const desc = describeRule(rule);
    const li = document.createElement('li');
    li.className = 'settings-rule-item';
    li.dataset.ruleId = rule.id;
    const main = document.createElement('div');
    main.className = 'settings-rule-item__main';
    const badge = document.createElement('span');
    badge.className = `settings-tool-item__badge settings-rule-item__badge settings-rule-item__badge--${rule.effect}`;
    badge.textContent = desc.effectLabel;
    main.appendChild(badge);
    const subject = document.createElement('span');
    subject.className = 'settings-rule-item__subject';
    subject.textContent = desc.subject;
    main.appendChild(subject);
    const pattern = document.createElement('code');
    pattern.className = 'settings-rule-item__pattern';
    pattern.textContent = desc.patternLabel;
    main.appendChild(pattern);
    li.appendChild(main);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'settings-icon-trash settings-rule-item__remove';
    remove.dataset.ruleId = rule.id;
    remove.setAttribute('aria-label', `${desc.text} löschen`);
    remove.title = rule.effect === 'deny' ? 'Sperre löschen (Bestätigung im Systemdialog)' : 'Erlaubnis löschen';
    remove.innerHTML = TRASH_ICON_HTML;
    li.appendChild(remove);
    return li;
  }

  function renderRules(state) {
    const globalRules = Array.isArray(state?.globalRules) ? state.globalRules : [];
    const workspaceRules = Array.isArray(state?.workspaceRules) ? state.workspaceRules : [];
    if (rulesGlobal) {
      rulesGlobal.innerHTML = '';
      for (const rule of globalRules) rulesGlobal.appendChild(ruleRow(rule));
    }
    rulesGlobalEmpty?.classList.toggle('hidden', globalRules.length > 0);
    if (rulesWorkspace) {
      rulesWorkspace.innerHTML = '';
      for (const rule of workspaceRules) rulesWorkspace.appendChild(ruleRow(rule));
    }
    const root = typeof state?.workspaceRoot === 'string' ? state.workspaceRoot : '';
    if (rulesWorkspaceName) rulesWorkspaceName.textContent = root || 'kein Workspace geöffnet';
    if (rulesWorkspaceEmpty) {
      rulesWorkspaceEmpty.textContent = root ? 'Keine Workspace-Regeln.' : 'Öffne einen Ordner, um Workspace-Regeln anzulegen.';
      rulesWorkspaceEmpty.classList.toggle('hidden', workspaceRules.length > 0);
    }
  }

  async function removeRule(ruleId) {
    const result = await toolPermissions.removeRule(ruleId);
    reportResult(ruleError, result);
  }

  for (const list of [rulesGlobal, rulesWorkspace]) {
    list?.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-rule-id]');
      if (!button) return;
      void removeRule(button.dataset.ruleId);
    });
  }

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
    fillSelect(ruleEffect, RULE_EFFECT_OPTIONS);
    fillSelect(ruleScope, RULE_SCOPE_OPTIONS);
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
    if (reportResult(ruleError, result) && rulePattern) rulePattern.value = '';
  });

  // ── Sensible Pfadmuster ──────────────────────────────────────────────────
  function renderSensitive(state) {
    const patterns = Array.isArray(state?.sensitivePathPatterns) ? state.sensitivePathPatterns : [];
    if (sensitiveList) {
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
        remove.setAttribute('aria-label', `Muster ${pattern} entfernen`);
        remove.innerHTML = TRASH_ICON_HTML;
        li.appendChild(remove);
        sensitiveList.appendChild(li);
      }
    }
    sensitiveEmpty?.classList.toggle('hidden', patterns.length > 0);
  }

  async function saveSensitive(patterns) {
    const result = await toolPermissions.setSensitivePathPatterns(patterns);
    return reportResult(sensitiveError, result);
  }

  sensitiveList?.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-pattern]');
    if (!button) return;
    const current = toolPermissions.get()?.sensitivePathPatterns || [];
    void saveSensitive(current.filter((p) => p !== button.dataset.pattern));
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

  // ── Zurücksetzen ─────────────────────────────────────────────────────────
  function renderResets(state) {
    if (!resetActions) return;
    resetActions.innerHTML = '';
    const grants = Number.isInteger(state?.sessionGrantCount) ? state.sessionGrantCount : 0;
    const hasWorkspace = typeof state?.workspaceRoot === 'string' && !!state.workspaceRoot;
    for (const action of RESET_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'settings-reset-row';
      const text = document.createElement('div');
      text.className = 'settings-reset-row__text';
      const title = document.createElement('span');
      title.className = 'settings-reset-row__title';
      title.textContent = action.key === 'session' ? `${action.label} (${grants})` : action.label;
      const desc = document.createElement('span');
      desc.className = 'settings-reset-row__desc';
      desc.textContent = action.description;
      text.appendChild(title);
      text.appendChild(desc);
      row.appendChild(text);
      const controls = document.createElement('div');
      controls.className = 'settings-reset-row__controls';
      if (action.confirm && resetConfirmKey === action.key) {
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'btn-destructive';
        confirm.dataset.reset = action.key;
        confirm.dataset.confirmed = 'true';
        confirm.textContent = 'Ja, alles zurücksetzen';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn-secondary';
        cancel.dataset.resetCancel = 'true';
        cancel.textContent = 'Abbrechen';
        controls.appendChild(confirm);
        controls.appendChild(cancel);
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-secondary';
        button.dataset.reset = action.key;
        button.textContent = action.confirm ? 'Zurücksetzen …' : 'Ausführen';
        button.disabled = !state || (action.key === 'session' && grants === 0) || (action.key === 'workspace' && !hasWorkspace);
        controls.appendChild(button);
      }
      row.appendChild(controls);
      resetActions.appendChild(row);
    }
  }

  resetActions?.addEventListener('click', async (e) => {
    const cancel = e.target.closest('button[data-reset-cancel]');
    if (cancel) {
      resetConfirmKey = null;
      renderResets(toolPermissions.get());
      return;
    }
    const button = e.target.closest('button[data-reset]');
    if (!button) return;
    const key = button.dataset.reset;
    const action = RESET_ACTIONS.find((a) => a.key === key);
    if (!action) return;
    if (action.confirm && button.dataset.confirmed !== 'true') {
      resetConfirmKey = key;
      renderResets(toolPermissions.get());
      resetActions.querySelector('button[data-confirmed="true"]')?.focus();
      return;
    }
    resetConfirmKey = null;
    let result;
    if (key === 'session') result = await toolPermissions.clearSessionGrants();
    else if (key === 'workspace') result = await toolPermissions.resetWorkspaceRules();
    else result = await toolPermissions.resetAll();
    reportResult(errorEl, result);
    renderResets(toolPermissions.get());
  });

  // ── Gesamt ───────────────────────────────────────────────────────────────
  function render(state) {
    if (!isOpen) return;
    renderMode(state);
    renderRules(state);
    renderRuleForm(state);
    renderSensitive(state);
    renderResets(state);
    if (migrationHint) {
      migrationHint.textContent = LEGACY_WRITE_MIGRATION_HINT;
      migrationHint.classList.toggle('hidden', state?.legacyWriteMigrated !== true);
    }
    setError(integrityHint, integrityWarning(state?.integrity));
    if (!state) setError(errorEl, 'Berechtigungen konnten nicht geladen werden.');
    else if (errorEl?.textContent === 'Berechtigungen konnten nicht geladen werden.') setError(errorEl, '');
  }

  return {
    async open(catalog) {
      toolCatalog = Array.isArray(catalog) ? catalog : [];
      isOpen = true;
      resetConfirmKey = null;
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
    modeLabel,
  };
}
