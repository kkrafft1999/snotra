import contracts from '../generated/contracts.js';
import { programLabel, tildePath } from '../utils/program-allowance-view.js';
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
 * The dialog that adds or edits a program allowance (#408) — opened from
 * Settings › Tools › Security (#1119), where the list lives.
 *
 * "Applies to" chooses the scope: the workspace the page shows, preselected,
 * or every workspace, the deliberate choice. Without a workspace to offer
 * only every workspace is possible. Main resolves the program and checks
 * every folder itself and asks in a native dialog before anything widens the
 * sandbox; the dialog here only helps to fill it in. A cancelled native
 * dialog leaves the form open and as it was.
 */
export function initProgramAllowanceDialog({ api, toolPermissions }) {
  const overlay = document.getElementById('program-allowance-overlay');
  const dialog = document.getElementById('dialog-program-allowance');
  const dialogTitle = document.getElementById('dialog-program-allowance-title');
  const btnClose = document.getElementById('btn-program-allowance-close');
  const btnCancel = document.getElementById('btn-program-allowance-cancel');
  const btnSave = document.getElementById('btn-program-allowance-save');
  const formError = document.getElementById('allowance-form-error');
  const fieldProgram = document.getElementById('allowance-field-program');
  const programStatus = document.getElementById('allowance-program-status');
  const scopeWorkspace = document.getElementById('allowance-scope-workspace');
  const scopeGlobal = document.getElementById('allowance-scope-global');
  const scopeRoot = document.getElementById('allowance-scope-root');
  const scopeWorkspaceDesc = document.getElementById('allowance-scope-workspace-desc');
  const fieldDomains = document.getElementById('allowance-field-domains');
  const domainsInvalid = document.getElementById('allowance-domains-invalid');
  const folderList = document.getElementById('allowance-folder-list');
  const foldersNone = document.getElementById('allowance-folders-none');
  const btnFolderAdd = document.getElementById('btn-allowance-folder-add');
  const trustdGroup = document.getElementById('allowance-trustd-group');
  const fieldTrustd = document.getElementById('allowance-field-trustd');

  if (!overlay || !dialog || !toolPermissions) {
    return { open() {}, close() {}, isOpen: () => false };
  }

  /** The entry the dialog edits and the scope it lives in; null while adding. */
  let editing = null;
  /** The workspace "This workspace" means here, or null when there is none. */
  let workspace = null;
  let folders = [];
  let lastFocus = null;
  let saving = false;
  let resolveTimer = null;
  let resolveSeq = 0;
  /** Called with main's answer once an allowance is stored. */
  let onSaved = null;
  /** Last answer for the program field: {state: 'hint'|'checking'|'found'|'error', text}. */
  let programState = { state: 'hint', text: '' };

  const state = () => toolPermissions.get() || {};
  const homeDir = () => (typeof state().homeDir === 'string' ? state().homeDir : '');
  const isMac = () => state().platform === 'darwin';

  function setText(node, text) {
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('hidden', !text);
  }

  /** Whatever went wrong on the way to main shows as the form's error. */
  function showFailure(error) {
    saving = false;
    btnSave.disabled = false;
    setText(formError, error?.message || t('settings.instant.failed'));
  }

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

  /** "This workspace" names the folder, or says it needs one (#1119). */
  function renderScope() {
    if (!scopeWorkspace || !scopeGlobal) return;
    scopeWorkspace.disabled = !workspace;
    if (!workspace) scopeGlobal.checked = true;
    if (scopeRoot) {
      scopeRoot.textContent = workspace ? workspace.label : '';
      scopeRoot.title = workspace ? workspace.root : '';
      scopeRoot.hidden = !workspace;
    }
    if (scopeWorkspaceDesc) {
      scopeWorkspaceDesc.textContent = workspace ? t('allowanceDialog.scope.workspaceDesc') : t('allowanceDialog.scope.workspaceNone');
    }
  }

  function renderDialogTexts() {
    dialogTitle.textContent = editing
      ? t('allowanceDialog.title.edit', { program: programLabel(editing.entry.path) })
      : t('allowanceDialog.title.add');
    renderProgramStatus();
    renderFolders();
    renderScope();
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
    resolveTimer = setTimeout(() => resolveNow(text).catch(showFailure), RESOLVE_DELAY_MS);
  }

  async function resolveNow(text) {
    const seq = ++resolveSeq;
    let result = null;
    try {
      result = typeof api?.resolveAllowanceProgram === 'function' ? await api.resolveAllowanceProgram(text) : null;
    } catch {
      // No answer is drawn like a refusal below: the field says it is unavailable.
      result = null;
    }
    // An answer to an older spelling must not overwrite the current one.
    if (seq !== resolveSeq || overlay.classList.contains('hidden')) return;
    programState = result?.ok
      ? { state: 'found', text: t('allowanceDialog.program.found', { path: tildePath(result.path, homeDir()) }) }
      : { state: 'error', text: tMessage(result?.error) || t('permissions.allowance.error.unavailable') };
    renderProgramStatus();
  }

  /**
   * Opens the dialog.
   *
   * @param {object} [options]
   * @param {object|null} [options.entry]        the allowance to edit; null adds one
   * @param {string|null} [options.entryRoot]    the workspace the edited entry belongs to; null: every workspace
   * @param {'workspace'|'global'} [options.scope]  the preselected scope of a new entry
   * @param {{root: string, label: string}|null} [options.workspace]  what "This workspace" means
   * @param {(result: object) => void} [options.onSaved]
   */
  function open({ entry = null, entryRoot = null, scope = 'workspace', workspace: offered = null, onSaved: saved = null } = {}) {
    editing = entry ? { entry, root: entryRoot || null } : null;
    workspace = offered && typeof offered.root === 'string' && offered.root ? offered : null;
    onSaved = typeof saved === 'function' ? saved : null;
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
    const preselect = editing ? (editing.root ? 'workspace' : 'global') : scope;
    if (scopeWorkspace && scopeGlobal) {
      scopeWorkspace.checked = preselect === 'workspace';
      scopeGlobal.checked = preselect !== 'workspace';
    }
    programState = entry
      ? { state: 'found', text: t('allowanceDialog.program.found', { path: tildePath(entry.path, homeDir()) }) }
      : { state: 'hint', text: '' };
    renderDialogTexts();
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    queueMicrotask(() => (entry ? fieldDomains : fieldProgram).focus());
  }

  /** `focusTarget` wins over the element the dialog was opened from. */
  function close(focusTarget = null) {
    clearTimeout(resolveTimer);
    resolveSeq += 1;
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    editing = null;
    onSaved = null;
    try {
      const target = focusTarget || lastFocus;
      if (target?.isConnected) target.focus();
    } catch {
      /* the element may be gone by now */
    }
  }

  async function addFolder() {
    setText(formError, '');
    let result = null;
    try {
      result = typeof api?.chooseAllowanceFolder === 'function' ? await api.chooseAllowanceFolder() : null;
    } catch {
      // Drawn below as the form's error: the picker is unavailable.
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

  function chosenScope() {
    return workspace && scopeWorkspace?.checked ? { scope: 'workspace', root: workspace.root } : { scope: 'global', root: null };
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
    const target = chosenScope();
    const result = await toolPermissions.setProgramAllowance({
      program,
      domains: parsed.domains,
      writePaths: folders,
      trustd: isMac() && fieldTrustd.checked,
      scope: target.scope,
      root: target.root,
      previousPath: editing?.entry.path || null,
      previousScope: editing ? (editing.root ? 'workspace' : 'global') : undefined,
      previousRoot: editing?.root || null,
    });
    saving = false;
    btnSave.disabled = false;
    if (result?.ok) {
      const done = onSaved;
      close();
      done?.(result);
      return;
    }
    // A cancelled system dialog: the user decided, nothing to explain.
    if (isCancelledResult(result)) {
      btnSave.focus();
      return;
    }
    setText(formError, tMessage(result?.error) || t('settings.instant.failed'));
    formError.scrollIntoView?.({ block: 'nearest' });
    // Save was disabled while main checked, which dropped the focus out of
    // the dialog (CR-B13-03); the error itself is announced as an alert.
    btnSave.focus();
  }

  btnClose?.addEventListener('click', () => close());
  btnCancel?.addEventListener('click', () => close());
  btnSave?.addEventListener('click', () => save().catch(showFailure));
  btnFolderAdd?.addEventListener('click', () => addFolder().catch(showFailure));
  fieldProgram?.addEventListener('input', scheduleResolve);
  fieldDomains?.addEventListener('input', () => showInvalidDomains(false));
  fieldDomains?.addEventListener('blur', () => showInvalidDomains(true));
  // Escape closes only this dialog, not Settings underneath.
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  });

  onLocaleChange(() => {
    if (!overlay.classList.contains('hidden')) renderDialogTexts();
  });

  return {
    open,
    close: () => {
      if (!overlay.classList.contains('hidden')) close();
    },
    isOpen: () => !overlay.classList.contains('hidden'),
  };
}
