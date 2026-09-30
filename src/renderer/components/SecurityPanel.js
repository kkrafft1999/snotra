import { t, tMessage, onLocaleChange } from '../i18n.js';
import { riskClassLabel } from '../utils/tool-approval-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import {
  SECURITY_LINK_TARGETS,
  describeSecurityHeader,
  describeSecurityRow,
  linkLabel,
} from '../utils/security-overview-view.js';
import { initWorkspaceModeSetting, SECURITY_PAGE_IDS } from './WorkspaceModeSetting.js';

/**
 * Settings › Security (#448, #449): what Snotra may do in the open workspace,
 * one row per risk class, and every control that changes it. Main computes
 * the state (`api.getSecurityOverview`); this panel draws it and puts each
 * control under the question it answers. Every control applies at once;
 * loosening is confirmed natively by main, as everywhere else.
 *
 * Controls with a component of their own (the execution switches, the
 * sandbox switch, program allowances, sensitive patterns, the rule form) are
 * "slots": elements that live in `#settings-security-slots` and are moved
 * into the row they belong to on every draw. Their components keep working
 * on the same elements, and a redraw does not lose what was typed.
 *
 * Rows are disclosure buttons (`aria-expanded`); which ones are open survives
 * a redraw, so a live update does not fold the row the user is reading.
 */

const SVG_ATTRS = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

const CLASS_ICONS = Object.freeze({
  read: `<svg ${SVG_ATTRS}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  'read-sensitive': `<svg ${SVG_ATTRS}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  write: `<svg ${SVG_ATTRS}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  delete: `<svg ${SVG_ATTRS}><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>`,
  execute: `<svg ${SVG_ATTRS}><path d="m4 17 6-5-6-5"/><path d="M12 19h8"/></svg>`,
  external: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20"/></svg>`,
});

const CHEVRON = `<svg class="settings-security-row__chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"/></svg>`;

const SCOPE_ICONS = Object.freeze({
  global: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20"/></svg>`,
  workspace: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
});

const TRASH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

const SLOT_IDS = Object.freeze({
  python: 'settings-python-card',
  shell: 'settings-shell-card',
  sandbox: 'settings-sandbox-card',
  allowances: 'settings-allowances-card',
  sensitive: 'settings-sensitive-card',
  ruleForm: 'settings-rule-form',
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function initSecurityPanel({
  api,
  toolPermissions,
  // The rule form, the sensitive patterns, the approvals card and the resets
  // (ToolPermissionsPanel.js); the rule form is opened from here.
  permissionsPanel = null,
  onNavigate = () => {},
  // Writes `disabledTools` at once; resolves to whether it was stored.
  onToggleTool = async () => false,
}) {
  const panel = document.getElementById('panel-settings-security');
  const nameEl = document.getElementById('settings-security-workspace-name');
  const titleEl = document.querySelector('#heading-security-workspace > span');
  const scopeEl = document.getElementById('settings-security-scope');
  const modeRow = document.getElementById('settings-security-mode-row');
  const modeState = document.getElementById('settings-security-mode-state');
  const modeNote = document.getElementById('settings-security-mode-note');
  const chatsEl = document.getElementById('settings-security-other-chats');
  const summaryEl = document.getElementById('settings-security-summary');
  const errorEl = document.getElementById('settings-security-error');
  const rowsEl = document.getElementById('settings-security-rows');
  const slotsHome = document.getElementById('settings-security-slots');
  const slots = Object.fromEntries(Object.entries(SLOT_IDS).map(([key, id]) => [key, document.getElementById(id)]));
  const ruleForm = slots.ruleForm;
  const ruleHeading = document.getElementById('heading-rule-form');
  const ruleCancel = document.getElementById('btn-rule-cancel');
  if (!panel || !rowsEl || typeof api?.getSecurityOverview !== 'function') {
    return { open() {}, close() {}, refresh: async () => {} };
  }

  const modeSetting = initWorkspaceModeSetting({ toolPermissions, ids: SECURITY_PAGE_IDS });
  const expanded = new Set();
  let overview = null;
  // What was drawn last: an update that changes nothing redraws nothing,
  // so focus and hover stay where they are.
  let drawnKey = '';
  let isOpen = false;
  let unsubscribe = null;
  let requestSeq = 0;
  /** The rule form opened in a row: `{ riskClass, effect }`, or null. */
  let ruleDraft = null;
  /** What to focus after the next draw (a removed rule's list, say). */
  let pendingFocus = null;

  function linkButton(key) {
    const target = SECURITY_LINK_TARGETS[key];
    const button = el('button', 'settings-security-link', linkLabel(key));
    button.type = 'button';
    button.dataset.securityLink = key;
    button.addEventListener('click', () => onNavigate(target.panel, target.target, target.fallback || null));
    return button;
  }

  function linksRow(keys) {
    const wrap = el('p', 'settings-security-links');
    // Two links to the same section would read as the same link twice.
    const seen = new Set();
    for (const key of keys) {
      const panelKey = SECURITY_LINK_TARGETS[key]?.panel;
      if (!panelKey || seen.has(panelKey)) continue;
      seen.add(panelKey);
      wrap.appendChild(linkButton(key));
    }
    return wrap;
  }

  function scopeTag(text, scope) {
    const tag = el('span', 'settings-security-scope');
    if (scope && SCOPE_ICONS[scope]) tag.insertAdjacentHTML('afterbegin', SCOPE_ICONS[scope]);
    tag.appendChild(el('span', null, text));
    return tag;
  }

  /**
   * An entry of a list inside an answer: text, optional code, a quiet tag and
   * at most one control — a tool switch, a remove or a revoke button.
   */
  function itemRow({ label, code, tag, scope, muted = false, codeFirst = false, control = null }) {
    const li = el('li', `settings-security-item${muted ? ' settings-security-item--muted' : ''}${codeFirst ? ' settings-security-item--tool' : ''}`);
    const main = el('span', 'settings-security-item__main');
    const labelEl = label ? el('span', 'settings-security-item__label', label) : null;
    let codeEl = null;
    if (code) {
      codeEl = el('code', 'settings-security-item__code', code);
      codeEl.setAttribute('lang', 'en');
    }
    // A tool is known by its name; its description is the quiet second
    // line, cut to one line with the whole sentence on hover.
    if (codeFirst && labelEl) labelEl.title = label;
    for (const node of codeFirst ? [codeEl, labelEl] : [labelEl, codeEl]) if (node) main.appendChild(node);
    li.appendChild(main);
    const end = el('span', 'settings-security-item__end');
    if (tag) end.appendChild(scope ? scopeTag(tag, scope) : el('span', 'settings-security-item__tag', tag));
    if (control) end.appendChild(control);
    li.appendChild(end);
    return li;
  }

  function itemList(items) {
    const ul = el('ul', 'settings-security-items');
    for (const item of items) ul.appendChild(itemRow(item));
    return ul;
  }

  function removeButton(id, label) {
    const button = el('button', 'settings-icon-trash settings-security-remove');
    button.type = 'button';
    button.dataset.ruleRemove = id;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = TRASH_ICON;
    return button;
  }

  function toolSwitch(tool) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'ds-switch';
    input.setAttribute('role', 'switch');
    input.dataset.toolSwitch = tool.name;
    input.checked = tool.checked;
    input.disabled = tool.switchDisabled;
    input.setAttribute('aria-label', t('security.tool.switch', { tool: tool.name }));
    return input;
  }

  function question(number, text) {
    const li = el('li', 'settings-security-q');
    const head = el('p', 'settings-security-q__head');
    head.appendChild(el('span', 'settings-security-q__number', String(number)));
    head.appendChild(el('span', 'settings-security-q__text', text));
    li.appendChild(head);
    const body = el('div', 'settings-security-q__body');
    li.appendChild(body);
    return { li, body };
  }

  function placeSlot(key, body) {
    const node = slots[key];
    if (node) body.appendChild(node);
  }

  /** Every slot back home, before the rows it sits in are replaced. */
  function parkSlots() {
    if (!slotsHome) return;
    for (const node of Object.values(slots)) {
      if (node && node.parentNode !== slotsHome) slotsHome.appendChild(node);
    }
  }

  /** "Add allowance" / "Add block", or the rule form in its place. */
  function ruleAction(riskClass, effect, label, body) {
    if (ruleDraft && ruleDraft.riskClass === riskClass && ruleDraft.effect === effect) {
      placeSlot('ruleForm', body);
      return;
    }
    const wrap = el('p', 'settings-security-actions');
    const button = el('button', 'btn-secondary settings-security-add', label);
    button.type = 'button';
    button.dataset.ruleAdd = effect;
    button.dataset.riskClass = riskClass;
    wrap.appendChild(button);
    body.appendChild(wrap);
  }

  function renderMay(view, body) {
    body.appendChild(el('p', 'settings-security-answer', view.answer));
    if (view.note) body.appendChild(el('p', 'settings-security-note', view.note));
    if (view.execution) {
      placeSlot('shell', body);
      placeSlot('python', body);
    }
    if (view.tools.length > 0) {
      body.appendChild(itemList(view.tools.map((tool) => ({
        label: tool.label,
        code: tool.name,
        tag: tool.tag,
        scope: tool.muted || !tool.switchable ? null : 'global',
        muted: tool.muted,
        codeFirst: true,
        // A tool that is not set up has nothing to switch yet; its tag and
        // the link under the list say where it is set up.
        control: tool.switchable && !tool.switchDisabled ? toolSwitch(tool) : null,
      }))));
    }
    if (view.links.length > 0) body.appendChild(linksRow(view.links));
  }

  function renderAsk(view, body, riskClass) {
    body.appendChild(el('p', 'settings-security-answer', view.answer));
    if (view.allowances.length > 0) {
      body.appendChild(el('p', 'settings-security-subhead', view.allowancesHeading));
      body.appendChild(itemList(view.allowances.map((item) => ({
        label: item.label,
        code: item.code,
        tag: item.tag,
        scope: item.scope,
        muted: view.allowancesMuted,
        control: removeButton(item.id, item.removeLabel),
      }))));
    }
    if (view.addAllowance) ruleAction(riskClass, 'allow', view.addAllowance, body);
    else if (view.onlyOnce) body.appendChild(el('p', 'settings-security-note', view.onlyOnce));
    if (view.grants.length > 0) {
      body.appendChild(el('p', 'settings-security-subhead', view.grantsHeading));
      body.appendChild(itemList(view.grants.map((grant) => {
        const revoke = el('button', 'btn-secondary settings-security-revoke', t('settings.grants.revoke'));
        revoke.type = 'button';
        revoke.dataset.grantRevoke = grant.id;
        revoke.setAttribute('aria-label', grant.revokeLabel);
        return { label: grant.text, tag: grant.tag, control: revoke };
      })));
    }
  }

  function renderExecuteReach(view, body) {
    const reach = view.execute;
    if (reach.inactive) body.appendChild(el('p', 'settings-security-note', reach.inactive));
    body.appendChild(el('p', `settings-security-answer settings-security-answer--${reach.state.kind}`, reach.state.text));
    if (reach.facts.length > 0) {
      const ul = el('ul', 'settings-security-facts');
      for (const fact of reach.facts) ul.appendChild(el('li', null, fact));
      body.appendChild(ul);
    }
    placeSlot('sandbox', body);
    placeSlot('allowances', body);
  }

  function renderSensitive(view, body) {
    const sensitive = view.sensitive;
    body.appendChild(el('p', 'settings-security-subhead', sensitive.builtInHeading));
    const chips = el('p', 'settings-security-chips');
    for (const pattern of sensitive.builtIn) {
      const code = el('code', 'settings-security-chip', pattern);
      code.setAttribute('lang', 'en');
      chips.appendChild(code);
    }
    body.appendChild(chips);
    placeSlot('sensitive', body);
  }

  function renderWhere(view, body, riskClass) {
    if (view.answer) body.appendChild(el('p', 'settings-security-answer', view.answer));
    if (view.sensitive) renderSensitive(view, body);
    if (view.execute) renderExecuteReach(view, body);
    if (Array.isArray(view.facts) && view.facts.length > 0) {
      const ul = el('ul', 'settings-security-facts');
      for (const fact of view.facts) ul.appendChild(el('li', null, fact));
      body.appendChild(ul);
    }
    if (view.blocks.length > 0) {
      body.appendChild(el('p', 'settings-security-subhead', view.blocksHeading));
      body.appendChild(itemList(view.blocks.map((item) => ({
        label: item.label,
        code: item.code,
        tag: item.tag,
        scope: item.scope,
        control: removeButton(item.id, item.removeLabel),
      }))));
    }
    ruleAction(riskClass, 'deny', view.addBlock, body);
    if (view.note) body.appendChild(el('p', 'settings-security-note', view.note));
  }

  function renderRow(row) {
    const view = describeSecurityRow(row, overview);
    const open = expanded.has(row.riskClass);
    const li = el('li', `settings-security-row settings-security-row--${view.pill.kind}${open ? ' settings-security-row--open' : ''}`);
    li.dataset.riskClass = row.riskClass;
    const heading = el('h3', 'settings-security-row__heading');
    const toggle = el('button', 'settings-security-row__toggle');
    toggle.type = 'button';
    const bodyId = `settings-security-row-${row.riskClass}`;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-controls', bodyId);
    toggle.dataset.riskClass = row.riskClass;

    const icon = el('span', 'settings-security-row__icon');
    icon.innerHTML = CLASS_ICONS[row.riskClass] || '';
    const title = el('span', 'settings-security-row__title');
    title.appendChild(el('span', 'settings-security-row__name', view.name));
    title.appendChild(el('span', 'settings-security-row__sub', view.sub));
    const reason = el('span', 'settings-security-row__reason');
    reason.appendChild(el('span', null, view.reason));
    if (view.exceptions) reason.appendChild(el('span', 'settings-security-row__exceptions', view.exceptions));
    const pills = el('span', 'settings-security-row__pills');
    if (view.noSandbox) pills.appendChild(el('span', 'settings-security-pill settings-security-pill--warning', view.noSandbox));
    pills.appendChild(el('span', `settings-security-pill settings-security-pill--${view.pill.kind}`, view.pill.text));
    toggle.append(icon, title, reason, pills);
    toggle.insertAdjacentHTML('beforeend', CHEVRON);
    toggle.addEventListener('click', () => {
      if (expanded.has(row.riskClass)) expanded.delete(row.riskClass);
      else expanded.add(row.riskClass);
      syncRow(row.riskClass);
    });
    heading.appendChild(toggle);
    li.appendChild(heading);

    const body = el('div', 'settings-security-row__body');
    body.id = bodyId;
    body.hidden = !open;
    const questions = el('ol', 'settings-security-questions');
    const may = question(1, view.may.question);
    renderMay(view.may, may.body);
    const ask = question(2, view.ask.question);
    renderAsk(view.ask, ask.body, row.riskClass);
    const where = question(3, view.where.question);
    renderWhere(view.where, where.body, row.riskClass);
    questions.append(may.li, ask.li, where.li);
    body.appendChild(questions);
    li.appendChild(body);
    return li;
  }

  /**
   * Opens or closes the row as it stands in the list now. A live update can
   * replace the rows between a press and its click; the press still counts.
   */
  function syncRow(riskClass) {
    const li = rowsEl.querySelector(`.settings-security-row[data-risk-class="${riskClass}"]`);
    if (!li) return;
    const open = expanded.has(riskClass);
    li.classList.toggle('settings-security-row--open', open);
    li.querySelector('.settings-security-row__toggle')?.setAttribute('aria-expanded', open ? 'true' : 'false');
    const body = li.querySelector('.settings-security-row__body');
    if (body) body.hidden = !open;
  }

  function renderHeader() {
    const header = describeSecurityHeader(overview);
    // The title belongs to the page, not to the catalogue pass: without a
    // folder there is no workspace to name.
    if (titleEl) {
      titleEl.textContent = t(header.hasWorkspace ? 'security.header.title' : 'security.header.titleNone');
    }
    if (nameEl) {
      nameEl.textContent = header.hasWorkspace ? header.name : '';
      nameEl.hidden = !header.hasWorkspace;
      nameEl.title = header.root;
    }
    if (scopeEl) scopeEl.textContent = t(header.hasWorkspace ? 'security.header.scope' : 'security.header.noWorkspace');
    // Without a folder there is no default to set: the row, its state line
    // and its note go, the scope line says why.
    if (modeRow) modeRow.hidden = !header.hasWorkspace;
    if (modeNote) modeNote.hidden = !header.hasWorkspace;
    if (modeState && !header.hasWorkspace) modeState.hidden = true;
    if (chatsEl) {
      chatsEl.innerHTML = '';
      chatsEl.hidden = header.otherChats.length === 0;
      if (header.otherChats.length > 0) {
        chatsEl.appendChild(el('span', 'settings-security-header__chats-label', t('security.header.otherChats')));
        const ul = el('ul', 'settings-security-header__chat-list');
        for (const text of header.otherChats) ul.appendChild(el('li', null, text));
        if (header.otherChatsMore) ul.appendChild(el('li', 'settings-security-header__chat-more', header.otherChatsMore));
        chatsEl.appendChild(ul);
      }
    }
    if (summaryEl) summaryEl.textContent = header.summary;
  }

  /**
   * How to find the focused element again after a draw: slots keep their
   * nodes, everything else is found by what it controls.
   */
  function focusMemo() {
    const active = document.activeElement;
    if (!active || !rowsEl.contains(active)) return null;
    if (Object.values(slots).some((node) => node && node.contains(active))) return { node: active };
    if (active.dataset.toolSwitch) return { selector: `[data-tool-switch="${CSS.escape(active.dataset.toolSwitch)}"]` };
    if (active.dataset.ruleAdd) return { selector: `[data-rule-add="${active.dataset.ruleAdd}"][data-risk-class="${active.dataset.riskClass}"]` };
    if (active.dataset.riskClass) return { selector: `.settings-security-row__toggle[data-risk-class="${active.dataset.riskClass}"]` };
    return null;
  }

  function restoreFocus(memo) {
    const target = memo?.node?.isConnected ? memo.node : memo?.selector ? rowsEl.querySelector(memo.selector) : null;
    target?.focus();
  }

  function render() {
    if (!overview) return;
    const memo = pendingFocus || focusMemo();
    pendingFocus = null;
    // The mode control draws its own state line; the header decides after it
    // whether the row is shown at all.
    modeSetting.render();
    renderHeader();
    parkSlots();
    rowsEl.innerHTML = '';
    for (const row of overview.classes || []) rowsEl.appendChild(renderRow(row));
    restoreFocus(memo);
  }

  // ── Actions in the rows ────────────────────────────────────────────────

  function selectValue(id, value) {
    const select = document.getElementById(id);
    if (!select) return;
    if ([...select.options].some((option) => option.value === value)) select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Opens the one rule form in the row and question it belongs to. */
  function openRuleForm(riskClass, effect) {
    if (!ruleForm) return;
    ruleDraft = { riskClass, effect };
    permissionsPanel?.refreshRuleForm?.();
    permissionsPanel?.setRuleError?.('');
    selectValue('rule-effect', effect);
    selectValue('rule-subject-type', 'class');
    selectValue('rule-class', riskClass);
    selectValue('rule-scope', overview?.workspace ? 'workspace' : 'global');
    if (ruleHeading) {
      ruleHeading.textContent = t(effect === 'allow' ? 'security.rule.formAllow' : 'security.rule.formDeny', {
        riskClass: riskClassLabel(riskClass),
      });
    }
    expanded.add(riskClass);
    render();
    document.getElementById('rule-pattern')?.focus();
  }

  function closeRuleForm() {
    if (!ruleDraft) return;
    const { riskClass, effect } = ruleDraft;
    ruleDraft = null;
    pendingFocus = { selector: `[data-rule-add="${effect}"][data-risk-class="${riskClass}"]` };
    render();
  }

  ruleCancel?.addEventListener('click', closeRuleForm);
  ruleForm?.addEventListener('rule-added', closeRuleForm);
  ruleForm?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !ruleDraft) return;
    e.preventDefault();
    e.stopPropagation();
    closeRuleForm();
  });

  function reportAction(result) {
    if (result?.ok) {
      showError('');
      return true;
    }
    // A cancelled system dialog changed nothing, and says nothing.
    if (!isCancelledResult(result)) showError(tMessage(result?.error) || t('settings.permissions.actionFailed'));
    return false;
  }

  rowsEl.addEventListener('click', async (e) => {
    const add = e.target.closest('button[data-rule-add]');
    if (add) {
      openRuleForm(add.dataset.riskClass, add.dataset.ruleAdd);
      return;
    }
    const remove = e.target.closest('button[data-rule-remove]');
    const revoke = e.target.closest('button[data-grant-revoke]');
    const button = remove || revoke;
    if (!button || button.disabled) return;
    const riskClass = button.closest('.settings-security-row')?.dataset.riskClass;
    button.disabled = true;
    const result = remove
      ? await toolPermissions.removeRule(remove.dataset.ruleRemove)
      : await toolPermissions.revokeSessionGrant(revoke.dataset.grantRevoke);
    if (reportAction(result)) {
      // The item is gone after the redraw; the keyboard lands on its row.
      pendingFocus = { selector: `.settings-security-row__toggle[data-risk-class="${riskClass}"]` };
      void refresh();
    } else if (button.isConnected) {
      button.disabled = false;
      button.focus();
    }
  });

  rowsEl.addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-tool-switch]');
    if (!input) return;
    const on = input.checked;
    input.disabled = true;
    let ok = false;
    try {
      ok = await onToggleTool(input.dataset.toolSwitch, on);
    } catch {
      ok = false;
    }
    input.disabled = false;
    if (!ok) input.checked = !on;
    await refresh();
    // After the redraw, which clears the line when the page could be read.
    showError(ok ? '' : t('settings.instant.failed'));
  });

  /** Hidden by something inside the list — a slot that does not apply here. */
  function hiddenWithinRows(node) {
    for (let current = node; current && current !== rowsEl; current = current.parentElement) {
      if (current.hidden || current.classList?.contains('hidden')) return true;
    }
    return false;
  }

  /**
   * From the approval card, the mode pill and the folder shield: open the
   * execute row and focus the control they are about. False when it is not
   * shown here (no sandbox on this system).
   */
  async function reveal(target) {
    if (!overview) await refresh();
    const node = target === 'allowances'
      ? slots.allowances?.querySelector('[data-action="edit"]') || document.getElementById('btn-add-program-allowance')
      : document.getElementById('input-workspace-sandbox');
    expanded.add('execute');
    render();
    const toggle = rowsEl.querySelector('.settings-security-row__toggle[data-risk-class="execute"]');
    const shown = !!node && rowsEl.contains(node) && !hiddenWithinRows(node);
    const focusTarget = shown ? node : toggle;
    try {
      focusTarget?.scrollIntoView({ block: 'center' });
    } catch { /* happy-dom */ }
    focusTarget?.focus();
    return shown;
  }

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.classList.toggle('hidden', !message);
  }

  async function refresh() {
    const seq = ++requestSeq;
    let next;
    try {
      next = await api.getSecurityOverview();
    } catch {
      next = null;
    }
    // A slower answer to an older request must not overwrite a newer one.
    if (seq !== requestSeq) return;
    if (!next || !Array.isArray(next.classes)) {
      showError(tMessage(next?.error) || t('security.error.load'));
      return;
    }
    showError('');
    overview = next;
    const key = JSON.stringify(next);
    if (key === drawnKey) {
      // The mode control follows the renderer state, which may have moved.
      modeSetting.render();
      if (pendingFocus) {
        restoreFocus(pendingFocus);
        pendingFocus = null;
      }
      return;
    }
    drawnKey = key;
    render();
  }

  function open() {
    isOpen = true;
    if (!unsubscribe && typeof toolPermissions?.subscribe === 'function') {
      unsubscribe = toolPermissions.subscribe(() => {
        if (isOpen) void refresh();
      });
    }
    return refresh();
  }

  function close() {
    isOpen = false;
    ruleDraft = null;
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
  }

  // Tool names come from main in the interface language: a language change
  // asks again rather than mixing two languages on one page.
  onLocaleChange(() => {
    // The page's own texts change even when main's answer does not.
    drawnKey = '';
    if (isOpen) void refresh();
    else render();
  });

  return { open, close, refresh, render, reveal };
}
