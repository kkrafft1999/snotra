import { t, tMessage, onLocaleChange, getLocale } from '../i18n.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { describeAllowanceRow } from '../utils/program-allowance-view.js';
import { integrityWarning, modeLabel, sessionGrantGroups } from '../utils/tool-approval-view.js';
import {
  ALL_WORKSPACES,
  describeGlobalDetail,
  describeWorkspaceDetail,
  describeWorkspaceList,
  defaultSelection,
  validSelection,
} from '../utils/tool-security-view.js';

/**
 * Settings › Tools › Security (#1119): the sandbox of every workspace, and
 * what applies in all of them. Decided on 2026-10-18 from the mockup of the
 * issue — layout 2: the workspaces on the left, starting with All
 * workspaces, the details of the chosen one on the right.
 *
 * Main computes the state (`api.getSandboxOverview`) and decides every
 * change; this panel draws it. A workspace can be checked and changed
 * without opening it. Like everything about permissions it applies at once,
 * and loosening is confirmed natively by main.
 *
 * The details are drawn afresh on every change. Every control carries a
 * `data-focus` key, so the keyboard stays where it was across a redraw, and
 * a status that is still showing is drawn again next to its control.
 */

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ICONS = Object.freeze({
  folder: `<svg width="14" height="14" ${SVG}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
  globe: `<svg width="14" height="14" ${SVG}><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20"/></svg>`,
  clock: `<svg width="14" height="14" ${SVG}><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
  info: `<svg width="16" height="16" ${SVG}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  missing: `<svg width="16" height="16" ${SVG}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9.5 11.5l5 4M14.5 11.5l-5 4"/></svg>`,
});

/** The shield of the sandbox (#398), struck through when a run is not isolated. */
function shield(off, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" focusable="false">`
    + '<path d="M8 1.6 3.2 3.4v3.9c0 3 2 5.5 4.8 6.7 2.8-1.2 4.8-3.7 4.8-6.7V3.4z"/>'
    + (off ? '<path d="M1.8 1.8 14.2 14.2"/>' : '')
    + '</svg>';
}

/** How long a "Saved" stays next to its control (ms), as in InstantSetting.js. */
const SAVED_VISIBLE_MS = 1600;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(className, text, focusKey) {
  const node = el('button', className, text);
  node.type = 'button';
  if (focusKey) node.dataset.focus = focusKey;
  return node;
}

let idCounter = 0;
function uid(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function initToolSecurityPanel({ api, toolPermissions, allowanceDialog = null }) {
  const panel = document.getElementById('panel-settings-sandbox');
  const listEl = document.getElementById('settings-sandbox-list');
  const detailEl = document.getElementById('settings-sandbox-detail');
  const errorEl = document.getElementById('settings-sandbox-error');
  const integrityEl = document.getElementById('settings-sandbox-integrity');
  const announcer = document.getElementById('settings-sandbox-announcer');
  if (!panel || !listEl || !detailEl || typeof api?.getSandboxOverview !== 'function' || !toolPermissions) {
    return { open: async () => {}, close() {}, refresh: async () => {}, select() {}, reveal: async () => false };
  }

  let overview = null;
  let selected = null;
  let drawnKey = '';
  let isOpen = false;
  let unsubscribe = null;
  let requestSeq = 0;
  /** Controls whose action is on its way; they take no second press. */
  const busy = new Set();
  /** The "Saved" or "Not saved" next to a control: `{ key, ok, until }`. */
  let status = null;
  let statusTimer = null;
  /** The open "Add host" form: `{ scope, value, error }`, or null. */
  let hostForm = null;
  /** What to focus after the next draw, by `data-focus` key. */
  let pendingFocus = null;

  // ── Feedback ───────────────────────────────────────────────────────────

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.classList.toggle('hidden', !message);
  }

  function announce(text) {
    if (!announcer) return;
    announcer.textContent = '';
    // A second identical message is read out again only after a change.
    queueMicrotask(() => { announcer.textContent = text; });
  }

  function setStatus(key, ok) {
    clearTimeout(statusTimer);
    status = { key, ok, until: ok ? Date.now() + SAVED_VISIBLE_MS : Infinity };
    announce(t(ok ? 'settings.instant.saved' : 'settings.instant.failed'));
    if (ok) {
      statusTimer = setTimeout(() => {
        status = null;
        panel.querySelectorAll('.settings-instant-status[data-status-for]').forEach((node) => node.classList.remove('is-visible'));
      }, SAVED_VISIBLE_MS);
    }
  }

  function statusSlot(key) {
    const span = el('span', 'settings-instant-status');
    span.dataset.statusFor = key;
    span.setAttribute('aria-hidden', 'true');
    if (status && status.key === key && Date.now() < status.until) {
      span.textContent = t(status.ok ? 'settings.instant.saved' : 'settings.instant.failed');
      span.classList.add('is-visible');
      span.classList.toggle('is-error', !status.ok);
    }
    return span;
  }

  /** Main's answer: true when it worked; a cancelled system dialog says nothing. */
  function report(result, key) {
    if (result?.ok) {
      showError('');
      if (key) setStatus(key, true);
      return true;
    }
    if (isCancelledResult(result)) return false;
    showError(tMessage(result?.error) || t('settings.instant.failed'));
    if (key) setStatus(key, false);
    return false;
  }

  // ── Pieces ─────────────────────────────────────────────────────────────

  function scopeHead(icon, titleNode, extra = null) {
    const head = el('div', 'settings-sandbox-head');
    const iconEl = el('span', 'settings-sandbox-head__icon');
    iconEl.innerHTML = icon;
    head.append(iconEl, titleNode);
    if (extra) head.append(extra);
    return head;
  }

  function notice(title, body) {
    const box = el('div', 'settings-sandbox-notice');
    box.insertAdjacentHTML('afterbegin', ICONS.info);
    const text = el('div', 'settings-sandbox-notice__text');
    text.append(el('strong', null, title), el('span', null, body));
    box.append(text);
    return box;
  }

  function block({ title, count = 0, hint = '', resting = false, body, foot = null }) {
    const wrap = el('section', `settings-sandbox-block${resting ? ' settings-sandbox-block--resting' : ''}`);
    const headingId = uid('settings-sandbox-block');
    const heading = el('h4', 'settings-sandbox-block__title', title);
    heading.id = headingId;
    if (count > 0) heading.append(el('span', 'settings-sandbox-block__count', String(count)));
    wrap.setAttribute('aria-labelledby', headingId);
    wrap.append(heading);
    if (hint) wrap.append(el('p', 'settings-sandbox-block__hint', hint));
    if (resting) wrap.append(el('p', 'settings-sandbox-rest', t('toolSecurity.resting')));
    if (body) {
      if (body.tagName === 'UL') body.setAttribute('aria-labelledby', headingId);
      wrap.append(body);
    }
    if (foot) {
      const footEl = el('div', 'settings-sandbox-block__foot');
      footEl.append(...[].concat(foot));
      wrap.append(footEl);
    }
    return wrap;
  }

  /** A program or host that applies here because it applies everywhere: leads to All workspaces. */
  function inheritedChip(name, focusKey) {
    const chip = button('settings-sandbox-chip', null, focusKey);
    chip.insertAdjacentHTML('afterbegin', ICONS.globe);
    chip.append(el('span', null, t('toolSecurity.inherited')));
    const label = t('toolSecurity.inherited.label', { name });
    chip.setAttribute('aria-label', label);
    chip.title = label;
    chip.dataset.action = 'show-all';
    return chip;
  }

  function allowanceRow(entry, { root, inherited }) {
    const view = describeAllowanceRow(entry, { homeDir: overview?.homeDir || '' });
    const row = el('li', 'allowance-row');
    row.dataset.path = entry.path;
    const main = el('div', 'allowance-row__main');
    main.append(el('span', 'allowance-row__name', view.name));
    const pathEl = el('span', 'allowance-row__path', view.pathLabel);
    pathEl.title = entry.path;
    main.append(pathEl);
    row.append(main);
    const actions = el('div', 'allowance-row__actions');
    if (inherited) {
      actions.append(inheritedChip(view.name, `inherited-program:${entry.path}`));
    } else {
      const scopeKey = root || ALL_WORKSPACES;
      const edit = button('btn-secondary btn-compact', t('settings.allowances.edit'), `program-edit:${scopeKey}:${entry.path}`);
      edit.dataset.action = 'edit-program';
      edit.dataset.path = entry.path;
      edit.setAttribute('aria-label', t('settings.allowances.edit.label', { program: view.name }));
      const remove = button('btn-secondary btn-compact', t('settings.allowances.remove'), `program-remove:${scopeKey}:${entry.path}`);
      remove.dataset.action = 'remove-program';
      remove.dataset.path = entry.path;
      remove.setAttribute('aria-label', t('settings.allowances.remove.label', { program: view.name }));
      if (busy.has(remove.dataset.focus)) remove.setAttribute('aria-disabled', 'true');
      actions.append(edit, remove);
    }
    row.append(actions);
    if (view.facts.length > 0) {
      const facts = el('dl', 'allowance-row__facts');
      for (const fact of view.facts) {
        facts.append(el('dt', null, fact.label));
        const dd = el('dd');
        fact.values.forEach((value, index) => {
          if (index > 0) dd.append(', ');
          dd.append(fact.mono ? el('code', null, value) : value);
        });
        if (fact.tag) dd.append(el('span', 'allowance-tag', fact.tag));
        facts.append(dd);
      }
      row.append(facts);
    }
    return row;
  }

  function programsBlock({ own, inherited = [], root, resting, emptyText }) {
    const scopeKey = root || ALL_WORKSPACES;
    let body;
    if (own.length + inherited.length > 0) {
      body = el('ul', 'allowance-list');
      for (const entry of own) body.append(allowanceRow(entry, { root, inherited: false }));
      for (const entry of inherited) body.append(allowanceRow(entry, { root, inherited: true }));
    } else {
      body = el('p', 'settings-sandbox-empty', emptyText);
    }
    const add = button('btn-secondary', t('settings.allowances.add'), `program-add:${scopeKey}`);
    add.dataset.action = 'add-program';
    return block({
      title: t('toolSecurity.programs'),
      count: own.length,
      hint: t('toolSecurity.programs.hint'),
      // Only what is listed can rest.
      resting: resting && own.length + inherited.length > 0,
      body,
      foot: [add, statusSlot(`programs:${scopeKey}`)],
    });
  }

  function hostLine(host, { root, inherited }) {
    const line = el('li', 'settings-sandbox-line');
    const code = el('code', 'settings-sandbox-line__host', host);
    line.append(code);
    if (inherited) {
      line.append(inheritedChip(host, `inherited-host:${host}`));
    } else {
      const scopeKey = root || ALL_WORKSPACES;
      const close = button('settings-icon-trash', null, `host-close:${scopeKey}:${host}`);
      close.innerHTML = ICONS.trash;
      close.dataset.action = 'close-host';
      close.dataset.host = host;
      const label = t(root ? 'toolSecurity.hosts.close' : 'toolSecurity.hosts.closeAll', { host });
      close.setAttribute('aria-label', label);
      close.title = label;
      if (busy.has(close.dataset.focus)) close.setAttribute('aria-disabled', 'true');
      line.append(close);
    }
    return line;
  }

  function hostFormFor(scopeKey) {
    const form = el('form', 'settings-sandbox-hostform');
    form.dataset.scope = scopeKey;
    const inputId = uid('settings-sandbox-host');
    const hintId = `${inputId}-hint`;
    const errorId = `${inputId}-error`;
    const label = el('label', 'modal-field-label', t('toolSecurity.hosts.field'));
    label.htmlFor = inputId;
    const row = el('div', 'modal-row settings-sandbox-hostform__row');
    const input = el('input', 'modal-input modal-input--mono modal-input--grow');
    input.type = 'text';
    input.id = inputId;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'api.example.com:443';
    input.value = hostForm?.value || '';
    input.dataset.focus = `host-input:${scopeKey}`;
    input.setAttribute('aria-describedby', `${hintId} ${errorId}`);
    if (hostForm?.error) input.setAttribute('aria-invalid', 'true');
    input.addEventListener('input', () => {
      if (hostForm) hostForm.value = input.value;
    });
    const save = el('button', 'btn-secondary', t('toolSecurity.hosts.save'));
    save.type = 'submit';
    save.dataset.focus = `host-save:${scopeKey}`;
    if (busy.has(save.dataset.focus)) save.setAttribute('aria-disabled', 'true');
    const cancel = button('btn-secondary', t('toolSecurity.hosts.cancel'), `host-cancel:${scopeKey}`);
    cancel.dataset.action = 'cancel-host';
    row.append(input, save, cancel);
    const hint = el('p', 'modal-hint');
    hint.id = hintId;
    hint.innerHTML = t('toolSecurity.hosts.fieldHint');
    const error = el('p', `modal-hint error${hostForm?.error ? '' : ' hidden'}`, hostForm?.error || '');
    error.id = errorId;
    error.setAttribute('role', 'alert');
    form.append(label, row, hint, error);
    form.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // Escape closes the form, not the settings around it.
      event.stopPropagation();
      hostForm = null;
      pendingFocus = `host-add:${scopeKey}`;
      render();
    });
    return form;
  }

  function hostsBlock({ own, inherited = [], root, resting, titleKey, hintKey, emptyKey }) {
    const scopeKey = root || ALL_WORKSPACES;
    let body;
    if (own.length + inherited.length > 0) {
      body = el('ul', 'settings-sandbox-lines');
      for (const host of own) body.append(hostLine(host, { root, inherited: false }));
      for (const host of inherited) body.append(hostLine(host, { root, inherited: true }));
    } else {
      body = el('p', 'settings-sandbox-empty', t(emptyKey));
    }
    const foot = [];
    if (hostForm?.scope === scopeKey) {
      foot.push(hostFormFor(scopeKey));
    } else {
      const add = button('btn-secondary', t('toolSecurity.hosts.add'), `host-add:${scopeKey}`);
      add.dataset.action = 'add-host';
      foot.push(add);
    }
    foot.push(statusSlot(`hosts:${scopeKey}`));
    return block({ title: t(titleKey), count: own.length, hint: t(hintKey), resting: resting && own.length + inherited.length > 0, body, foot });
  }

  function resetRow({ titleText, descText, buttonText, action, focusKey, statusKey }) {
    const row = el('div', 'settings-reset-row');
    const text = el('div', 'settings-reset-row__text');
    const title = el('span', 'settings-reset-row__title', titleText);
    title.id = uid('settings-sandbox-reset');
    const desc = el('span', 'settings-reset-row__desc', descText);
    desc.id = `${title.id}-desc`;
    text.append(title, desc);
    const controls = el('div', 'settings-reset-row__controls');
    const run = button('btn-secondary', buttonText, focusKey);
    run.dataset.action = action;
    // "Reset" alone does not say what is reset: the row's title and text do.
    run.setAttribute('aria-describedby', `${title.id} ${desc.id}`);
    if (busy.has(focusKey)) run.setAttribute('aria-disabled', 'true');
    controls.append(statusSlot(statusKey), run);
    row.append(text, controls);
    return row;
  }

  function sandboxTile(detail) {
    const tile = el('div', 'settings-sandbox-tile');
    tile.dataset.tone = detail.tile.tone;
    tile.insertAdjacentHTML('afterbegin',
      '<svg class="settings-sandbox-tile__shield" width="28" height="28" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
      + '<path d="M8 1.6 3.2 3.4v3.9c0 3 2 5.5 4.8 6.7 2.8-1.2 4.8-3.7 4.8-6.7V3.4z"/>'
      + '<path class="settings-sandbox-tile__slash" d="M1.8 1.8 14.2 14.2"/></svg>');
    const text = el('div', 'settings-sandbox-tile__text');
    const inputId = uid('settings-sandbox-switch');
    const title = el(detail.tile.switchable ? 'label' : 'span', 'settings-sandbox-tile__title', detail.tile.title);
    if (detail.tile.switchable) title.htmlFor = inputId;
    const body = el('p', 'settings-sandbox-tile__body', detail.tile.body);
    body.id = `${inputId}-body`;
    const note = el('p', 'settings-sandbox-tile__note', detail.tile.note);
    note.id = `${inputId}-note`;
    text.append(title, body, note);
    tile.append(text);
    if (!detail.tile.switchable) return tile;
    const focusKey = `sandbox:${detail.root}`;
    tile.append(statusSlot(focusKey));
    const input = el('input', 'ds-switch');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.id = inputId;
    input.checked = detail.tile.checked;
    input.dataset.focus = focusKey;
    input.dataset.action = 'sandbox';
    input.setAttribute('aria-label', t('settings.sandbox.workspace.toggle'));
    input.setAttribute('aria-describedby', `${body.id} ${note.id}`);
    // Busy, or off not offered: marked rather than disabled, so the focus
    // stays and the reason can be read (CR-B14-07).
    if (busy.has(focusKey) || (detail.tile.offBlocked && detail.tile.checked)) input.setAttribute('aria-disabled', 'true');
    tile.append(input);
    return tile;
  }

  function sessionCard(grants) {
    const card = el('div', 'settings-tools-card settings-sandbox-card');
    const title = el('h3', 'settings-sandbox-head__title', t('toolSecurity.session'));
    card.append(scopeHead(ICONS.clock, title));
    card.append(el('p', 'settings-sandbox-sub', t('toolSecurity.session.sub')));
    const formatTime = (ms) => {
      try {
        return new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
      } catch {
        // An unknown locale falls back to the system's own clock format.
        return new Date(ms).toLocaleTimeString();
      }
    };
    for (const group of sessionGrantGroups(grants, { formatTime })) {
      const section = el('section', 'settings-grants__group');
      const label = el('h4', 'settings-grants__group-label', group.label);
      label.id = uid('settings-sandbox-grants');
      section.setAttribute('aria-labelledby', label.id);
      const list = el('ul', 'settings-sandbox-lines');
      for (const item of group.items) {
        const line = el('li', 'settings-sandbox-line settings-sandbox-line--grant');
        const text = el('span', 'settings-sandbox-line__text', item.text);
        const meta = el('span', 'settings-sandbox-line__meta', item.meta);
        const revoke = button('btn-secondary btn-compact', t('settings.grants.revoke'), `grant:${item.id}`);
        revoke.dataset.action = 'revoke-grant';
        revoke.dataset.grantId = item.id;
        revoke.setAttribute('aria-label', t('settings.grants.revokeLabel', { text: item.text }));
        line.append(text, meta, revoke);
        list.append(line);
      }
      section.append(label, list);
      card.append(section);
    }
    const all = button('btn-secondary', t('settings.grants.revokeAll'), 'grants-revoke-all');
    all.dataset.action = 'revoke-all-grants';
    const foot = el('div', 'settings-sandbox-block__foot');
    foot.append(all, statusSlot('grants'));
    card.append(foot);
    return card;
  }

  // ── The two kinds of detail ────────────────────────────────────────────

  function workspaceDetail(root) {
    const detail = describeWorkspaceDetail(overview, root, { autoLabel: modeLabel('auto') });
    if (!detail) return [];
    const card = el('div', 'settings-tools-card settings-sandbox-card');
    card.dataset.root = detail.root;
    const title = el('h3', 'settings-sandbox-head__title');
    title.id = 'settings-sandbox-detail-title';
    title.tabIndex = -1;
    const code = el('code', 'settings-rules-heading__root', detail.rootLabel);
    code.title = detail.root;
    title.append(code);
    const marker = detail.open ? el('span', 'settings-sandbox-head__open', `· ${t('toolSecurity.open')}`) : null;
    card.append(scopeHead(ICONS.folder, title, marker));
    if (detail.missing) {
      card.append(notice(t('toolSecurity.ws.missingTitle'), t('toolSecurity.ws.missingBody')));
      const remove = button('btn-secondary', t('toolSecurity.ws.remove'), `remove-ws:${detail.root}`);
      remove.dataset.action = 'reset-workspace';
      remove.setAttribute('aria-label', t('toolSecurity.ws.removeLabel', { root: detail.rootLabel }));
      if (busy.has(remove.dataset.focus)) remove.setAttribute('aria-disabled', 'true');
      const foot = el('div', 'settings-sandbox-block__foot');
      foot.append(remove);
      card.append(foot);
      return [card];
    }
    card.append(el('p', 'settings-sandbox-sub', detail.sub));
    card.append(sandboxTile(detail));
    if (detail.noSandbox) {
      card.append(notice(t('toolSecurity.windows.title'), t('toolSecurity.windows.body')));
      return [card];
    }
    card.append(programsBlock({
      own: detail.programs,
      inherited: detail.inheritedPrograms,
      root: detail.root,
      resting: detail.resting,
      emptyText: t('toolSecurity.programs.empty'),
    }));
    card.append(hostsBlock({
      own: detail.hosts,
      inherited: detail.inheritedHosts,
      root: detail.root,
      resting: detail.resting,
      titleKey: 'toolSecurity.hosts',
      hintKey: 'toolSecurity.hosts.hint',
      emptyKey: 'toolSecurity.hosts.empty',
    }));
    card.append(resetRow({
      titleText: t('toolSecurity.reset.ws'),
      descText: t('toolSecurity.reset.wsDesc'),
      buttonText: t('toolSecurity.reset.button'),
      action: 'reset-workspace',
      focusKey: `reset-ws:${detail.root}`,
      statusKey: `reset-ws:${detail.root}`,
    }));
    const out = [card];
    if (Array.isArray(detail.sessionGrants) && detail.sessionGrants.length > 0) out.push(sessionCard(detail.sessionGrants));
    return out;
  }

  function globalDetail() {
    const detail = describeGlobalDetail(overview);
    const out = [];
    if (detail.noWorkspace) out.push(notice(t('toolSecurity.noWs.title'), t('toolSecurity.noWs.body')));
    const card = el('div', 'settings-tools-card settings-sandbox-card');
    const title = el('h3', 'settings-sandbox-head__title', t('toolSecurity.all'));
    title.id = 'settings-sandbox-detail-title';
    title.tabIndex = -1;
    card.append(scopeHead(ICONS.globe, title));
    card.append(el('p', 'settings-sandbox-sub', t('toolSecurity.all.sub')));
    const facts = el('dl', 'settings-sandbox-facts');
    for (const [key, textKey] of [['closed', 'closedText'], ['open', 'openText'], ['notCovered', 'notCoveredText']]) {
      facts.append(el('dt', null, t(`toolSecurity.base.${key}`)));
      const dd = el('dd');
      dd.innerHTML = t(`toolSecurity.base.${textKey}`);
      facts.append(dd);
    }
    facts.append(el('dt', null, t('toolSecurity.base.system')), el('dd', null, detail.system));
    const base = block({ title: t('toolSecurity.base'), hint: t('toolSecurity.base.hint'), body: facts });
    if (detail.noSandbox) {
      card.append(notice(t('toolSecurity.windows.title'), t('toolSecurity.windows.body')), base);
      out.push(card);
      return out;
    }
    const newWs = el('div', 'settings-switch-row');
    const inputId = uid('settings-sandbox-newws');
    const label = el('label', 'settings-switch-row__label', t('toolSecurity.newWs.toggle'));
    label.htmlFor = inputId;
    const input = el('input', 'ds-switch');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.id = inputId;
    input.checked = detail.newWorkspaceSandbox;
    input.dataset.focus = 'new-workspaces';
    input.dataset.action = 'new-workspaces';
    const hint = el('p', 'settings-sandbox-block__hint', t('toolSecurity.newWs.hint'));
    hint.id = `${inputId}-hint`;
    input.setAttribute('aria-describedby', hint.id);
    if (busy.has('new-workspaces') || detail.newWorkspaceOffBlocked) input.setAttribute('aria-disabled', 'true');
    newWs.append(label, statusSlot('new-workspaces'), input);
    const newWsBody = el('div');
    newWsBody.append(newWs, hint);
    if (detail.newWorkspaceOffBlocked) newWsBody.append(el('p', 'settings-sandbox-block__hint', t('settings.sandbox.workspace.needsEncryption')));
    card.append(block({ title: t('toolSecurity.newWs'), body: newWsBody }));
    card.append(programsBlock({ own: detail.programs, root: null, resting: false, emptyText: t('toolSecurity.programs.emptyAll') }));
    card.append(hostsBlock({
      own: detail.hosts,
      root: null,
      resting: false,
      titleKey: 'toolSecurity.hosts.all',
      hintKey: 'toolSecurity.hosts.allHint',
      emptyKey: 'toolSecurity.hosts.emptyAll',
    }));
    card.append(base);
    card.append(resetRow({
      titleText: t('toolSecurity.reset.all'),
      descText: t('toolSecurity.reset.allDesc'),
      // The ellipsis says that a system dialog follows.
      buttonText: t('settings.reset.running'),
      action: 'reset-everywhere',
      focusKey: 'reset-everywhere',
      statusKey: 'reset-everywhere',
    }));
    out.push(card);
    return out;
  }

  // ── Drawing ────────────────────────────────────────────────────────────

  function listButton(item) {
    const li = el('li');
    const node = button('settings-sandbox-ws', null, `ws:${item.key}`);
    node.dataset.key = item.key;
    node.dataset.tone = item.tone;
    node.setAttribute('aria-current', item.selected ? 'true' : 'false');
    node.setAttribute('aria-controls', 'settings-sandbox-detail');
    if (item.title) node.title = item.title;
    const icon = el('span', 'settings-sandbox-ws__icon');
    if (item.kind === 'global') icon.innerHTML = ICONS.globe;
    else if (item.tone === 'missing') icon.innerHTML = ICONS.missing;
    else icon.innerHTML = shield(item.tone === 'off');
    const name = el('span', 'settings-sandbox-ws__name');
    name.append(el('span', 'settings-sandbox-ws__label', item.name));
    if (item.open) name.append(el('span', 'settings-sandbox-ws__open', t('toolSecurity.open')));
    // A pause between name and state for a screen reader; nothing to see.
    const pause = el('span', 'visually-hidden', ', ');
    const meta = el('span', 'settings-sandbox-ws__meta', item.meta);
    node.append(icon, name, pause, meta);
    li.append(node);
    return li;
  }

  function renderList() {
    const items = describeWorkspaceList(overview, selected);
    const top = el('ul', 'settings-sandbox-list__group');
    top.append(listButton(items[0]));
    const nodes = [top];
    if (items.length > 1) {
      const labelId = 'settings-sandbox-list-workspaces';
      const label = el('h4', 'settings-sandbox-list__label', t('toolSecurity.list.workspaces'));
      label.id = labelId;
      const group = el('ul', 'settings-sandbox-list__group');
      group.setAttribute('aria-labelledby', labelId);
      for (const item of items.slice(1)) group.append(listButton(item));
      nodes.push(label, group);
    }
    listEl.replaceChildren(...nodes);
  }

  function focusMemo() {
    const active = document.activeElement;
    if (!active || !panel.contains(active)) return null;
    return active.dataset?.focus || (active.id === 'settings-sandbox-detail-title' ? '#title' : null);
  }

  function restoreFocus(key) {
    if (!key) return;
    const target = key === '#title'
      ? document.getElementById('settings-sandbox-detail-title')
      : [...panel.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === key);
    target?.focus({ preventScroll: true });
  }

  function render() {
    if (!overview) return;
    const memo = pendingFocus || focusMemo();
    pendingFocus = null;
    const warning = integrityWarning(overview.integrity);
    if (integrityEl) {
      integrityEl.textContent = warning;
      integrityEl.classList.toggle('hidden', !warning);
    }
    renderList();
    detailEl.replaceChildren(...(selected === ALL_WORKSPACES ? globalDetail() : workspaceDetail(selected)));
    restoreFocus(memo);
  }

  async function refresh() {
    const seq = ++requestSeq;
    let next;
    try {
      next = await api.getSandboxOverview();
    } catch {
      // Said below, in the page's error line: the state could not be read.
      next = null;
    }
    // A slower answer to an older request must not overwrite a newer one.
    if (seq !== requestSeq) return;
    if (!next || !Array.isArray(next.workspaces)) {
      showError(tMessage(next?.error) || t('settings.permissions.unreadable'));
      return;
    }
    overview = next;
    selected = selected === null ? defaultSelection(overview) : validSelection(overview, selected);
    // A form for a scope that is gone goes with it.
    if (hostForm && hostForm.scope !== ALL_WORKSPACES && !overview.workspaces.some((ws) => ws.root === hostForm.scope)) hostForm = null;
    const key = JSON.stringify({ overview, selected, hostScope: hostForm?.scope || null });
    if (key === drawnKey && !pendingFocus) return;
    drawnKey = key;
    render();
  }

  function select(key, { focusList = false } = {}) {
    if (!overview) {
      selected = key;
      return;
    }
    const next = validSelection(overview, key);
    if (next !== selected) hostForm = null;
    selected = next;
    drawnKey = '';
    if (focusList) pendingFocus = `ws:${selected}`;
    render();
  }

  // ── Actions ────────────────────────────────────────────────────────────

  /** An action that threw on its way to main: said in the page's error line. */
  function failed(error) {
    showError(error?.message || t('settings.instant.failed'));
  }

  /** The workspace a control belongs to: the selected one, or null for All workspaces. */
  function scopeRoot() {
    return selected === ALL_WORKSPACES ? null : selected;
  }

  function entriesOf(root) {
    if (!root) return Array.isArray(overview?.global?.programs) ? overview.global.programs : [];
    return overview?.workspaces?.find((ws) => ws.root === root)?.programs || [];
  }

  /** What "This workspace" means in the dialog: the selected folder, or none from All workspaces. */
  function dialogWorkspace() {
    const root = scopeRoot();
    if (root) {
      const ws = overview.workspaces.find((entry) => entry.root === root);
      return ws ? { root, label: describeWorkspaceDetail(overview, root)?.rootLabel || root } : null;
    }
    const open = overview.workspaces.find((ws) => ws.open);
    return open ? { root: open.root, label: describeWorkspaceDetail(overview, open.root)?.rootLabel || open.root } : null;
  }

  async function run(focusKey, action, statusKey = null) {
    if (busy.has(focusKey)) return null;
    busy.add(focusKey);
    render();
    let result;
    try {
      result = await action();
    } catch (error) {
      result = { ok: false, error: error?.message };
    }
    busy.delete(focusKey);
    report(result, statusKey);
    return result;
  }

  async function onSandboxSwitch(input) {
    const root = scopeRoot();
    const focusKey = input.dataset.focus;
    if (input.getAttribute('aria-disabled') === 'true' || !root) {
      input.checked = !input.checked;
      return;
    }
    const enabled = input.checked;
    pendingFocus = focusKey;
    await run(focusKey, () => toolPermissions.setWorkspaceSandbox(enabled, root), focusKey);
    pendingFocus = focusKey;
    drawnKey = '';
    await refresh();
  }

  async function onNewWorkspaces(input) {
    if (input.getAttribute('aria-disabled') === 'true') {
      input.checked = !input.checked;
      return;
    }
    const enabled = input.checked;
    pendingFocus = 'new-workspaces';
    await run('new-workspaces', () => toolPermissions.setNewWorkspaceSandbox(enabled), 'new-workspaces');
    pendingFocus = 'new-workspaces';
    drawnKey = '';
    await refresh();
  }

  function openProgramDialog(entry = null) {
    if (!allowanceDialog) return;
    const root = scopeRoot();
    const scopeKey = root || ALL_WORKSPACES;
    allowanceDialog.open({
      entry,
      entryRoot: entry ? root : null,
      scope: root ? 'workspace' : 'global',
      workspace: dialogWorkspace(),
      onSaved: (result) => {
        // The saved program's row is where the keyboard belongs; its scope may
        // be another than the page shows, then the Add button stays.
        const savedRoot = result?.root || null;
        const path = result?.entry?.path;
        pendingFocus = path && savedRoot === root ? `program-edit:${scopeKey}:${path}` : `program-add:${scopeKey}`;
        setStatus(`programs:${scopeKey}`, true);
        drawnKey = '';
        refresh().catch(failed);
      },
    });
  }

  async function removeProgram(path) {
    const root = scopeRoot();
    const scopeKey = root || ALL_WORKSPACES;
    const entries = entriesOf(root);
    const index = entries.findIndex((entry) => entry.path === path);
    const result = await run(`program-remove:${scopeKey}:${path}`,
      () => toolPermissions.removeProgramAllowance(path, { scope: root ? 'workspace' : 'global', root }), `programs:${scopeKey}`);
    if (!result?.ok) {
      pendingFocus = `program-remove:${scopeKey}:${path}`;
      render();
      return;
    }
    const rest = entries.filter((entry) => entry.path !== path);
    const next = rest[Math.min(index, rest.length - 1)];
    pendingFocus = next ? `program-edit:${scopeKey}:${next.path}` : `program-add:${scopeKey}`;
    drawnKey = '';
    await refresh();
  }

  async function closeHost(host) {
    const root = scopeRoot();
    const scopeKey = root || ALL_WORKSPACES;
    const hosts = root ? overview.workspaces.find((ws) => ws.root === root)?.hosts || [] : overview.global?.hosts || [];
    const index = hosts.indexOf(host);
    const result = await run(`host-close:${scopeKey}:${host}`,
      () => (root ? toolPermissions.removeWorkspaceHost(host, root) : toolPermissions.removeGlobalHost(host)), `hosts:${scopeKey}`);
    if (!result?.ok) {
      pendingFocus = `host-close:${scopeKey}:${host}`;
      render();
      return;
    }
    const rest = hosts.filter((entry) => entry !== host);
    const next = rest[Math.min(index, rest.length - 1)];
    pendingFocus = next ? `host-close:${scopeKey}:${next}` : `host-add:${scopeKey}`;
    drawnKey = '';
    await refresh();
  }

  async function addHost(form) {
    const scopeKey = form.dataset.scope;
    const root = scopeKey === ALL_WORKSPACES ? null : scopeKey;
    const value = (hostForm?.value || '').trim();
    if (!value) {
      hostForm = { scope: scopeKey, value: '', error: t('permissions.hosts.error.invalid') };
      pendingFocus = `host-input:${scopeKey}`;
      render();
      return;
    }
    const result = await run(`host-save:${scopeKey}`, () => toolPermissions.addHosts({
      hosts: [value],
      scope: root ? 'workspace' : 'global',
      root,
    }));
    if (result?.ok) {
      hostForm = null;
      setStatus(`hosts:${scopeKey}`, true);
      pendingFocus = `host-add:${scopeKey}`;
      drawnKey = '';
      await refresh();
      return;
    }
    // A cancelled system dialog leaves the form as it was; a refusal says why, next to the field.
    if (hostForm) hostForm.error = isCancelledResult(result) ? '' : tMessage(result?.error) || t('settings.instant.failed');
    showError('');
    pendingFocus = isCancelledResult(result) ? `host-save:${scopeKey}` : `host-input:${scopeKey}`;
    render();
  }

  async function resetWorkspace() {
    const root = scopeRoot();
    if (!root) return;
    const missing = overview.workspaces.find((ws) => ws.root === root)?.missing === true;
    const focusKey = missing ? `remove-ws:${root}` : `reset-ws:${root}`;
    const result = await run(focusKey, () => toolPermissions.resetWorkspaceSandbox(root), missing ? null : focusKey);
    if (result?.ok && missing) {
      // The folder leaves the list: the keyboard goes to All workspaces.
      announce(t('toolSecurity.ws.removed'));
      selected = ALL_WORKSPACES;
      pendingFocus = `ws:${ALL_WORKSPACES}`;
    } else {
      pendingFocus = focusKey;
    }
    drawnKey = '';
    await refresh();
  }

  async function resetEverywhere() {
    pendingFocus = 'reset-everywhere';
    await run('reset-everywhere', () => toolPermissions.resetSandboxEverywhere(), 'reset-everywhere');
    pendingFocus = 'reset-everywhere';
    drawnKey = '';
    await refresh();
  }

  async function revokeGrant(id) {
    const ws = overview.workspaces.find((entry) => entry.open);
    const grants = Array.isArray(overview.sessionGrants) ? overview.sessionGrants : [];
    const index = grants.findIndex((grant) => grant.id === id);
    const result = await run(`grant:${id}`, () => toolPermissions.revokeSessionGrant(id), 'grants');
    const rest = grants.filter((grant) => grant.id !== id);
    const next = rest[Math.min(index, rest.length - 1)];
    pendingFocus = result?.ok ? (next ? `grant:${next.id}` : `ws:${ws?.root || ALL_WORKSPACES}`) : `grant:${id}`;
    drawnKey = '';
    await refresh();
  }

  async function revokeAllGrants() {
    const ws = overview.workspaces.find((entry) => entry.open);
    const ids = (Array.isArray(overview.sessionGrants) ? overview.sessionGrants : []).map((grant) => grant.id);
    await run('grants-revoke-all', async () => {
      for (const id of ids) {
        const result = await toolPermissions.revokeSessionGrant(id);
        if (!result?.ok) return result;
      }
      return { ok: true };
    }, 'grants');
    pendingFocus = `ws:${ws?.root || ALL_WORKSPACES}`;
    drawnKey = '';
    await refresh();
  }

  listEl.addEventListener('click', (event) => {
    const node = event.target.closest('button.settings-sandbox-ws');
    if (!node) return;
    select(node.dataset.key, { focusList: true });
  });

  // The list moves with the arrow keys as well, like the settings navigation.
  listEl.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...listEl.querySelectorAll('button.settings-sandbox-ws')];
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    let next = at;
    if (event.key === 'ArrowDown') next = Math.min(at + 1, buttons.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(at - 1, 0);
    else if (event.key === 'Home') next = 0;
    else next = buttons.length - 1;
    buttons[next].focus();
  });

  // A marked control takes no press, by mouse or by Space.
  detailEl.addEventListener('click', (event) => {
    if (event.target.closest?.('[aria-disabled="true"]')) event.preventDefault();
  }, true);

  detailEl.addEventListener('click', (event) => {
    const node = event.target.closest('[data-action]');
    if (!node || node.getAttribute('aria-disabled') === 'true' || node.tagName === 'INPUT') return;
    switch (node.dataset.action) {
      case 'show-all':
        select(ALL_WORKSPACES, { focusList: true });
        break;
      case 'add-program':
        openProgramDialog(null);
        break;
      case 'edit-program':
        openProgramDialog(entriesOf(scopeRoot()).find((entry) => entry.path === node.dataset.path) || null);
        break;
      case 'remove-program':
        removeProgram(node.dataset.path).catch(failed);
        break;
      case 'close-host':
        closeHost(node.dataset.host).catch(failed);
        break;
      case 'add-host':
        hostForm = { scope: scopeRoot() || ALL_WORKSPACES, value: '', error: '' };
        pendingFocus = `host-input:${hostForm.scope}`;
        render();
        break;
      case 'cancel-host': {
        const scopeKey = hostForm?.scope || scopeRoot() || ALL_WORKSPACES;
        hostForm = null;
        pendingFocus = `host-add:${scopeKey}`;
        render();
        break;
      }
      case 'reset-workspace':
        resetWorkspace().catch(failed);
        break;
      case 'reset-everywhere':
        resetEverywhere().catch(failed);
        break;
      case 'revoke-grant':
        revokeGrant(node.dataset.grantId).catch(failed);
        break;
      case 'revoke-all-grants':
        revokeAllGrants().catch(failed);
        break;
      default:
        break;
    }
  });

  detailEl.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-action]');
    if (!input) return;
    if (input.dataset.action === 'sandbox') onSandboxSwitch(input).catch(failed);
    else if (input.dataset.action === 'new-workspaces') onNewWorkspaces(input).catch(failed);
  });

  detailEl.addEventListener('submit', (event) => {
    const form = event.target.closest('form.settings-sandbox-hostform');
    if (!form) return;
    event.preventDefault();
    if (busy.has(`host-save:${form.dataset.scope}`)) return;
    addHost(form).catch(failed);
  });

  async function open() {
    isOpen = true;
    if (!unsubscribe && typeof toolPermissions.subscribe === 'function') {
      unsubscribe = toolPermissions.subscribe(() => {
        if (isOpen) refresh().catch(failed);
      });
    }
    return refresh();
  }

  function close() {
    isOpen = false;
    hostForm = null;
    status = null;
    clearTimeout(statusTimer);
    showError('');
    drawnKey = '';
    // The next visit starts on the open workspace again.
    selected = null;
    allowanceDialog?.close?.();
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
  }

  /**
   * From the folder shield, the card's "Not isolated" link, the blocked-
   * resource box and the line on Tools › Autonomy: the open workspace
   * selected, the control the way in was about focused — the sandbox switch,
   * or the programs (#1119). Without an open workspace, All workspaces.
   */
  async function reveal(target = 'sandbox') {
    selected = null;
    hostForm = null;
    drawnKey = '';
    await refresh();
    if (!overview) return false;
    selected = defaultSelection(overview);
    drawnKey = '';
    const scopeKey = selected;
    let key = '#title';
    if (selected !== ALL_WORKSPACES && target === 'sandbox') key = `sandbox:${selected}`;
    else if (target === 'programs') key = `program-add:${scopeKey}`;
    pendingFocus = key;
    render();
    const focused = document.activeElement;
    if (!focused || !panel.contains(focused)) restoreFocus('#title');
    try {
      document.activeElement?.scrollIntoView?.({ block: 'center' });
    } catch { /* happy-dom has no scrollIntoView */ }
    return true;
  }

  onLocaleChange(() => {
    drawnKey = '';
    status = null;
    if (isOpen) refresh().catch(failed);
  });

  return { open, close, refresh, select, reveal };
}

