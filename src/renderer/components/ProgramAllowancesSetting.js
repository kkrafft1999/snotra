import contracts from '../generated/contracts.js';
import { createInstantStatus } from './InstantSetting.js';
import { describeAllowanceRow, programLabel, tildePath } from '../utils/program-allowance-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { onLocaleChange, t, tMessage } from '../i18n.js';

const { parseDomainInput } = contracts;

const REMOVE_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.47 3.47a.75.75 0 0 1 1.06 0L8 6.94l3.47-3.47a.75.75 0 1 1 1.06 1.06L9.06 8l3.47 3.47a.75.75 0 1 1-1.06 1.06L8 9.06l-3.47 3.47a.75.75 0 0 1-1.06-1.06L6.94 8 3.47 4.53a.75.75 0 0 1 0-1.06z"/></svg>';

/** How long typing in the program field waits before asking main (ms). */
const RESOLVE_DELAY_MS = 300;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * Program allowances in Settings › Tools (#408): the list of programs with
 * extra rights inside the sandbox, and the dialog that edits one.
 *
 * Like the workspace switch above it, the list lives in main's policy file
 * and takes effect at once — no "Apply". Main resolves the program and checks
 * every folder itself and asks in a native dialog before anything widens the
 * sandbox; the dialog here only helps to fill it in. A cancelled native
 * dialog leaves the form open and as it was.
 */
export function initProgramAllowancesSetting({ api, toolPermissions }) {
  const card = document.getElementById('settings-allowances-card');
  const list = document.getElementById('settings-allowance-list');
  const empty = document.getElementById('settings-allowance-empty');
  const btnAdd = document.getElementById('btn-add-program-allowance');
  const cardError = document.getElementById('settings-allowance-error');
  const status = createInstantStatus(document.getElementById('status-program-allowances'));

  const overlay = document.getElementById('program-allowance-overlay');
  const dialog = document.getElementById('dialog-program-allowance');
  const dialogTitle = document.getElementById('dialog-program-allowance-title');
  const btnClose = document.getElementById('btn-program-allowance-close');
  const btnCancel = document.getElementById('btn-program-allowance-cancel');
  const btnSave = document.getElementById('btn-program-allowance-save');
  const formError = document.getElementById('allowance-form-error');
  const fieldProgram = document.getElementById('allowance-field-program');
  const programStatus = document.getElementById('allowance-program-status');
  const fieldDomains = document.getElementById('allowance-field-domains');
  const domainsInvalid = document.getElementById('allowance-domains-invalid');
  const folderList = document.getElementById('allowance-folder-list');
  const foldersNone = document.getElementById('allowance-folders-none');
  const btnFolderAdd = document.getElementById('btn-allowance-folder-add');
  const trustdGroup = document.getElementById('allowance-trustd-group');
  const fieldTrustd = document.getElementById('allowance-field-trustd');

  if (!card || !list || !overlay || !dialog || !toolPermissions) {
    return { update() {}, focus: () => false, close() {} };
  }

  let shellOn = false;
  let sandbox = null;
  /** The entry the dialog edits; null while adding. */
  let editing = null;
  let folders = [];
  let lastFocus = null;
  let saving = false;
  let resolveTimer = null;
  let resolveSeq = 0;
  /** Last answer for the program field: {state: 'hint'|'checking'|'found'|'error', text}. */
  let programState = { state: 'hint', text: '' };

  const state = () => toolPermissions.get() || {};
  const homeDir = () => (typeof state().homeDir === 'string' ? state().homeDir : '');
  const isMac = () => state().platform === 'darwin';
  const entries = () => (Array.isArray(state().programAllowances) ? state().programAllowances : []);

  function setText(node, text) {
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('hidden', !text);
  }

  // ── The list ─────────────────────────────────────────────────────────

  function renderList() {
    const visible = shellOn && !!sandbox && sandbox.reason !== 'platform' && state().platform !== 'win32';
    card.hidden = !visible;
    list.replaceChildren();
    const all = entries();
    if (empty) empty.hidden = all.length > 0;
    for (const entry of all) list.append(buildRow(entry));
  }

  function buildRow(entry) {
    const view = describeAllowanceRow(entry, { homeDir: homeDir() });
    const row = el('li', 'allowance-row');
    row.dataset.path = entry.path;

    const main = el('div', 'allowance-row__main');
    main.append(el('span', 'allowance-row__name', view.name));
    const pathEl = el('span', 'allowance-row__path', view.pathLabel);
    pathEl.title = entry.path;
    main.append(pathEl);
    row.append(main);

    const actions = el('div', 'allowance-row__actions');
    const edit = el('button', 'btn-secondary btn-compact', t('settings.allowances.edit'));
    edit.type = 'button';
    edit.dataset.action = 'edit';
    edit.setAttribute('aria-label', t('settings.allowances.edit.label', { program: view.name }));
    edit.addEventListener('click', () => openDialog(entry));
    const remove = el('button', 'btn-secondary btn-compact', t('settings.allowances.remove'));
    remove.type = 'button';
    remove.dataset.action = 'remove';
    remove.setAttribute('aria-label', t('settings.allowances.remove.label', { program: view.name }));
    remove.addEventListener('click', () => removeEntry(entry, row));
    actions.append(edit, remove);
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

  async function removeEntry(entry, row) {
    setText(cardError, '');
    status.clear();
    // The focus has to land somewhere sensible once the row is gone.
    const rows = [...list.children];
    const index = rows.indexOf(row);
    const result = await toolPermissions.removeProgramAllowance(entry.path);
    if (!result?.ok) {
      setText(cardError, tMessage(result?.error) || t('settings.instant.failed'));
      status.failed();
      return;
    }
    status.saved();
    const next = list.children[Math.min(index, list.children.length - 1)];
    (next?.querySelector('[data-action="edit"]') || btnAdd)?.focus();
  }

  // ── The dialog ───────────────────────────────────────────────────────

  function renderProgramStatus() {
    if (!programStatus) return;
    const { state: kind, text } = programState;
    programStatus.textContent = kind === 'hint' ? t('allowanceDialog.program.hint') : text;
    programStatus.classList.toggle('error', kind === 'error');
  }

  function renderFolders() {
    folderList.replaceChildren();
    for (const folder of folders) {
      const item = el('li', 'allowance-folder');
      const label = el('span', 'allowance-folder__path', tildePath(folder, homeDir()));
      label.title = folder;
      const remove = el('button', 'allowance-folder__remove');
      remove.type = 'button';
      remove.innerHTML = REMOVE_ICON;
      remove.setAttribute('aria-label', t('allowanceDialog.folders.remove', { folder: tildePath(folder, homeDir()) }));
      remove.addEventListener('click', () => {
        const at = folders.indexOf(folder);
        folders = folders.filter((other) => other !== folder);
        renderFolders();
        const buttons = folderList.querySelectorAll('.allowance-folder__remove');
        (buttons[Math.min(at, buttons.length - 1)] || btnFolderAdd)?.focus();
      });
      item.append(label, remove);
      folderList.append(item);
    }
    if (foldersNone) foldersNone.hidden = folders.length > 0;
  }

  function renderDialogTexts() {
    dialogTitle.textContent = editing
      ? t('allowanceDialog.title.edit', { program: programLabel(editing.path) })
      : t('allowanceDialog.title.add');
    renderProgramStatus();
    renderFolders();
    showInvalidDomains(false);
  }

  function showInvalidDomains(force) {
    const parsed = parseDomainInput(fieldDomains.value);
    const text = parsed.invalid.length > 0 ? t('allowanceDialog.domains.invalid', { domains: parsed.invalid.join(', ') }) : '';
    // While typing, only a fix is reported at once; a new complaint waits for
    // the field to be left, so a half-typed host is not called wrong.
    if (force || !text || !domainsInvalid.classList.contains('hidden')) setText(domainsInvalid, text);
    fieldDomains.setAttribute('aria-invalid', text && !domainsInvalid.classList.contains('hidden') ? 'true' : 'false');
    return parsed;
  }

  function scheduleResolve() {
    clearTimeout(resolveTimer);
    const text = fieldProgram.value.trim();
    if (!text) {
      programState = { state: 'hint', text: '' };
      renderProgramStatus();
      return;
    }
    programState = { state: 'checking', text: t('allowanceDialog.program.checking') };
    renderProgramStatus();
    resolveTimer = setTimeout(() => void resolveNow(text), RESOLVE_DELAY_MS);
  }

  async function resolveNow(text) {
    const seq = ++resolveSeq;
    let result = null;
    try {
      result = typeof api?.resolveAllowanceProgram === 'function' ? await api.resolveAllowanceProgram(text) : null;
    } catch {
      result = null;
    }
    // An answer to an older spelling must not overwrite the current one.
    if (seq !== resolveSeq || overlay.classList.contains('hidden')) return;
    programState = result?.ok
      ? { state: 'found', text: t('allowanceDialog.program.found', { path: tildePath(result.path, homeDir()) }) }
      : { state: 'error', text: tMessage(result?.error) || t('permissions.allowance.error.unavailable') };
    renderProgramStatus();
  }

  function openDialog(entry) {
    editing = entry || null;
    lastFocus = document.activeElement;
    saving = false;
    btnSave.disabled = false;
    setText(formError, '');
    setText(domainsInvalid, '');
    fieldProgram.value = entry ? entry.path : '';
    fieldDomains.value = entry ? entry.domains.join('\n') : '';
    folders = entry ? [...entry.writePaths] : [];
    fieldTrustd.checked = entry?.trustd === true;
    if (trustdGroup) trustdGroup.hidden = !isMac();
    programState = entry
      ? { state: 'found', text: t('allowanceDialog.program.found', { path: tildePath(entry.path, homeDir()) }) }
      : { state: 'hint', text: '' };
    renderDialogTexts();
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    queueMicrotask(() => (entry ? fieldDomains : fieldProgram).focus());
  }

  /** `focusTarget` wins over the element the dialog was opened from. */
  function closeDialog(focusTarget = null) {
    clearTimeout(resolveTimer);
    resolveSeq += 1;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    editing = null;
    try {
      (focusTarget || lastFocus)?.focus();
    } catch {
      /* the element may be gone by now */
    }
  }

  /** The Edit button of a program's row, once the list shows it. */
  function editButtonOf(programPath) {
    const row = [...list.children].find((item) => item.dataset.path === programPath);
    return row?.querySelector('[data-action="edit"]') || null;
  }

  async function addFolder() {
    setText(formError, '');
    let result = null;
    try {
      result = typeof api?.chooseAllowanceFolder === 'function' ? await api.chooseAllowanceFolder() : null;
    } catch {
      result = null;
    }
    if (isCancelledResult(result)) {
      btnFolderAdd.focus();
      return;
    }
    if (!result?.ok) {
      setText(formError, tMessage(result?.error) || t('permissions.allowance.error.unavailable'));
      btnFolderAdd.focus();
      return;
    }
    if (!folders.includes(result.path)) folders = [...folders, result.path];
    renderFolders();
    btnFolderAdd.focus();
  }

  async function save() {
    if (saving) return;
    setText(formError, '');
    const program = fieldProgram.value.trim();
    if (!program) {
      setText(formError, t('permissions.allowance.error.noProgram'));
      fieldProgram.focus();
      return;
    }
    const parsed = showInvalidDomains(true);
    if (parsed.invalid.length > 0) {
      fieldDomains.focus();
      return;
    }
    saving = true;
    btnSave.disabled = true;
    const result = await toolPermissions.setProgramAllowance({
      program,
      domains: parsed.domains,
      writePaths: folders,
      trustd: isMac() && fieldTrustd.checked,
      previousPath: editing?.path || null,
    });
    saving = false;
    btnSave.disabled = false;
    if (result?.ok) {
      // The saved program's row is where the focus belongs now — for a new
      // entry the dialog was opened from a button that is still there, but
      // the row is what changed.
      closeDialog(editButtonOf(result.entry?.path) || btnAdd);
      status.saved();
      return;
    }
    // A cancelled system dialog: the user decided, nothing to explain.
    if (isCancelledResult(result)) {
      btnSave.focus();
      return;
    }
    setText(formError, tMessage(result?.error) || t('settings.instant.failed'));
    formError.scrollIntoView?.({ block: 'nearest' });
  }

  btnAdd?.addEventListener('click', () => openDialog(null));
  btnClose?.addEventListener('click', () => closeDialog());
  btnCancel?.addEventListener('click', () => closeDialog());
  btnSave?.addEventListener('click', () => void save());
  btnFolderAdd?.addEventListener('click', () => void addFolder());
  fieldProgram?.addEventListener('input', scheduleResolve);
  fieldDomains?.addEventListener('input', () => showInvalidDomains(false));
  fieldDomains?.addEventListener('blur', () => showInvalidDomains(true));
  // Escape closes only this dialog, not Settings underneath.
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeDialog();
  });

  toolPermissions.subscribe(() => renderList());
  onLocaleChange(() => {
    renderList();
    if (!overlay.classList.contains('hidden')) renderDialogTexts();
  });

  return {
    /** What the settings know about shell_execute; shows or hides the card. */
    update(next = {}) {
      shellOn = next.shellOn === true;
      sandbox = next.sandbox && typeof next.sandbox === 'object' ? next.sandbox : null;
      status.clear();
      setText(cardError, '');
      renderList();
    },
    /** Brings the list into view for the card's "Program allowances" link. */
    focus() {
      if (card.hidden) return false;
      card.scrollIntoView({ block: 'center' });
      (list.querySelector('[data-action="edit"]') || btnAdd)?.focus();
      return true;
    },
    close() {
      if (!overlay.classList.contains('hidden')) closeDialog();
    },
  };
}
