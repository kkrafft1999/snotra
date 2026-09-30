import { t, tMessage, onLocaleChange } from '../i18n.js';
import { integrityWarning } from '../utils/tool-approval-view.js';
import {
  SECURITY_LINK_TARGETS,
  describeSecurityHeader,
  describeSecurityRow,
  linkLabel,
} from '../utils/security-overview-view.js';
import { initWorkspaceModeSetting, SECURITY_PAGE_IDS } from './WorkspaceModeSetting.js';

/**
 * Settings › Security (#448): what Snotra may do in the open workspace, one
 * row per risk class. Main computes the state (`api.getSecurityOverview`);
 * this panel draws it and links every line to the place where it is changed
 * today. The only control of its own is the workspace default mode, the
 * same one as in Settings › Permissions — #449 moves the others in.
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function initSecurityPanel({ api, toolPermissions, onNavigate = () => {} }) {
  const panel = document.getElementById('panel-settings-security');
  const nameEl = document.getElementById('settings-security-workspace-name');
  const titleEl = document.querySelector('#heading-security-workspace > span');
  const scopeEl = document.getElementById('settings-security-scope');
  const integrityEl = document.getElementById('settings-security-integrity');
  const modeRow = document.getElementById('settings-security-mode-row');
  const modeState = document.getElementById('settings-security-mode-state');
  const modeNote = document.getElementById('settings-security-mode-note');
  const chatsEl = document.getElementById('settings-security-other-chats');
  const summaryEl = document.getElementById('settings-security-summary');
  const errorEl = document.getElementById('settings-security-error');
  const rowsEl = document.getElementById('settings-security-rows');
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

  function homeDir() {
    const state = toolPermissions?.get?.();
    return typeof state?.homeDir === 'string' ? state.homeDir : '';
  }

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

  /** An entry of a list inside an answer: text, optional code, quiet tag. */
  function itemRow({ label, code, tag, scope, muted = false, codeFirst = false }) {
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
    if (tag) li.appendChild(scope ? scopeTag(tag, scope) : el('span', 'settings-security-item__tag', tag));
    return li;
  }

  function itemList(items) {
    const ul = el('ul', 'settings-security-items');
    for (const item of items) ul.appendChild(itemRow(item));
    return ul;
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

  function renderMay(view, body) {
    body.appendChild(el('p', 'settings-security-answer', view.answer));
    if (view.note) body.appendChild(el('p', 'settings-security-note', view.note));
    if (view.tools.length > 0) {
      body.appendChild(itemList(view.tools.map((tool) => ({
        label: tool.label,
        code: tool.name,
        tag: tool.tag,
        scope: tool.muted ? null : 'global',
        muted: tool.muted,
        codeFirst: true,
      }))));
    }
    body.appendChild(linksRow(view.links));
  }

  function renderAsk(view, body) {
    body.appendChild(el('p', 'settings-security-answer', view.answer));
    if (view.allowances.length > 0) {
      body.appendChild(el('p', 'settings-security-subhead', view.allowancesHeading));
      body.appendChild(itemList(view.allowances.map((item) => ({
        label: item.label,
        code: item.code,
        tag: item.tag,
        scope: item.scope,
        muted: view.allowancesMuted,
      }))));
    }
    if (view.grants.length > 0) {
      body.appendChild(el('p', 'settings-security-subhead', view.grantsHeading));
      body.appendChild(itemList(view.grants.map((grant) => ({ label: grant.text, tag: grant.tag }))));
    }
    body.appendChild(linksRow(view.links));
  }

  function renderExecuteReach(view, body) {
    const reach = view.execute;
    if (reach.inactive) body.appendChild(el('p', 'settings-security-note', reach.inactive));
    const state = el('p', `settings-security-answer settings-security-answer--${reach.state.kind}`, reach.state.text);
    body.appendChild(state);
    if (reach.facts.length > 0) {
      const ul = el('ul', 'settings-security-facts');
      for (const fact of reach.facts) ul.appendChild(el('li', null, fact));
      body.appendChild(ul);
    }
    body.appendChild(el('p', 'settings-security-subhead', reach.allowancesHeading));
    if (reach.allowances.length > 0) {
      body.appendChild(itemList(reach.allowances.map((entry) => ({ label: entry.text, tag: entry.tag, scope: 'global' }))));
    } else {
      body.appendChild(el('p', 'settings-security-note', reach.allowancesEmpty));
    }
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
    body.appendChild(el('p', 'settings-security-subhead', sensitive.userHeading));
    if (sensitive.user.length > 0) {
      body.appendChild(itemList(sensitive.user.map((pattern) => ({ code: pattern, tag: t('security.scope.global'), scope: 'global' }))));
    } else {
      body.appendChild(el('p', 'settings-security-note', sensitive.userEmpty));
    }
  }

  function renderWhere(view, body) {
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
      }))));
    }
    if (view.note) body.appendChild(el('p', 'settings-security-note', view.note));
    body.appendChild(linksRow(view.links));
  }

  function renderRow(row) {
    const view = describeSecurityRow(row, overview, { homeDir: homeDir() });
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
    renderAsk(view.ask, ask.body);
    const where = question(3, view.where.question);
    renderWhere(view.where, where.body);
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
    if (integrityEl) {
      const warning = integrityWarning(overview?.integrity);
      integrityEl.textContent = warning;
      integrityEl.classList.toggle('hidden', !warning);
    }
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

  function render() {
    if (!overview) return;
    const focusedClass = rowsEl.contains(document.activeElement) ? document.activeElement?.dataset?.riskClass : null;
    // The mode control draws its own state line; the header decides after it
    // whether the row is shown at all.
    modeSetting.render();
    renderHeader();
    rowsEl.innerHTML = '';
    for (const row of overview.classes || []) rowsEl.appendChild(renderRow(row));
    if (focusedClass) rowsEl.querySelector(`.settings-security-row__toggle[data-risk-class="${focusedClass}"]`)?.focus();
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

  return { open, close, refresh, render };
}
