import contracts from '../generated/contracts.js';
import { programLabel, tildePath } from '../utils/program-allowance-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { onLocaleChange, t, tMessage } from '../i18n.js';

const {
  parseDomainInput,
  credentialNameProblem,
  credentialValueProblem,
  suggestedCredentialName,
  CREDENTIAL_NAME_PROBLEMS,
  CREDENTIAL_VALUE_PROBLEMS,
  PROGRAM_ALLOWANCE_LIMITS,
} = contracts;

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
 *
 * Credentials (#1262) are write-only: a saved one comes back as its variable
 * and an id, never its value. It can be renamed, replaced with a new value,
 * or removed; a typed value lives in this dialog only until it is saved or
 * closed.
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
  const credentialList = document.getElementById('allowance-credential-list');
  const credentialsHead = document.getElementById('allowance-credentials-head');
  const credentialsWarning = document.getElementById('allowance-credentials-warning');
  const credentialsError = document.getElementById('allowance-credentials-error');
  const btnCredentialAdd = document.getElementById('btn-allowance-credential-add');

  if (!overlay || !dialog || !toolPermissions) {
    return { open() {}, close() {}, isOpen: () => false };
  }

  /** The entry the dialog edits and the scope it lives in; null while adding. */
  let editing = null;
  /** The workspace "This workspace" means here, or null when there is none. */
  let workspace = null;
  let folders = [];
  /**
   * The credential rows: `id` is set for one that is saved, `replacing` while
   * a saved one gets a new value, `value` is what was typed.
   * @type {Array<{ key: number, name: string, id: string|null, replacing: boolean, value: string }>}
   */
  let credentials = [];
  let credentialKey = 0;
  /** The row and field that refused the save, marked until it is edited. */
  let credentialError = null;
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

  function credentialRowLabel(row) {
    return row.name.trim() || null;
  }

  function focusCredential(key, field) {
    const node = credentialList?.querySelector(`[data-credential="${key}"] [data-field="${field}"]`);
    node?.focus();
  }

  /** One row per credential: the variable, then the value or its saved state. */
  function renderCredentials() {
    if (!credentialList) return;
    credentialList.replaceChildren();
    for (const row of credentials) {
      const name = credentialRowLabel(row);
      const item = el('li', 'allowance-credential');
      item.dataset.credential = String(row.key);

      const nameInput = el('input', 'modal-input modal-input--mono allowance-credential__name');
      const nameRefused = credentialError?.key === row.key && credentialError.field === 'name';
      nameInput.type = 'text';
      nameInput.value = row.name;
      nameInput.dataset.field = 'name';
      nameInput.autocomplete = 'off';
      nameInput.spellcheck = false;
      nameInput.placeholder = 'GH_TOKEN';
      nameInput.maxLength = PROGRAM_ALLOWANCE_LIMITS.MAX_CREDENTIAL_NAME_CHARS;
      nameInput.setAttribute('aria-label', t('allowanceDialog.credentials.name'));
      nameInput.setAttribute('aria-invalid', nameRefused ? 'true' : 'false');
      if (nameRefused) nameInput.setAttribute('aria-describedby', 'allowance-credentials-error');
      nameInput.addEventListener('input', () => {
        row.name = nameInput.value;
        clearCredentialError(row.key, 'name', nameInput);
        // The buttons speak of the variable; keep their names in step.
        relabelCredential(item, row);
      });

      const value = el('div', 'allowance-credential__value');
      const saved = !!row.id && !row.replacing;
      if (saved) {
        const masked = el('span', 'allowance-credential__masked', '••••••••');
        masked.setAttribute('aria-hidden', 'true');
        const replace = el('button', 'btn-secondary allowance-credential__action', t('allowanceDialog.credentials.replace'));
        replace.type = 'button';
        replace.dataset.field = 'replace';
        replace.addEventListener('click', () => {
          row.replacing = true;
          row.value = '';
          renderCredentials();
          focusCredential(row.key, 'value');
        });
        value.append(masked, replace);
      } else {
        // Not mono: it only ever shows dots, and its placeholder reads as a sentence.
        const valueInput = el('input', 'modal-input allowance-credential__secret');
        const valueRefused = credentialError?.key === row.key && credentialError.field === 'value';
        valueInput.type = 'password';
        valueInput.value = row.value;
        valueInput.dataset.field = 'value';
        valueInput.autocomplete = 'off';
        valueInput.spellcheck = false;
        valueInput.placeholder = t('allowanceDialog.credentials.valuePlaceholder');
        valueInput.maxLength = PROGRAM_ALLOWANCE_LIMITS.MAX_SECRET_CHARS + 64;
        valueInput.setAttribute('aria-invalid', valueRefused ? 'true' : 'false');
        if (valueRefused) valueInput.setAttribute('aria-describedby', 'allowance-credentials-error');
        valueInput.addEventListener('input', () => {
          row.value = valueInput.value;
          clearCredentialError(row.key, 'value', valueInput);
        });
        value.append(valueInput);
        if (row.id) {
          const keep = el('button', 'btn-secondary allowance-credential__action', t('allowanceDialog.credentials.keep'));
          keep.type = 'button';
          keep.dataset.field = 'keep';
          keep.addEventListener('click', () => {
            row.replacing = false;
            row.value = '';
            if (credentialError?.key === row.key) showCredentialError(null);
            renderCredentials();
            focusCredential(row.key, 'replace');
          });
          value.append(keep);
        }
      }

      const remove = el('button', 'allowance-folder__remove allowance-credential__remove');
      remove.type = 'button';
      remove.innerHTML = REMOVE_ICON;
      remove.dataset.field = 'remove';
      remove.addEventListener('click', () => {
        const at = credentials.indexOf(row);
        credentials = credentials.filter((other) => other !== row);
        if (credentialError?.key === row.key) showCredentialError(null);
        renderCredentials();
        const next = credentials[Math.min(at, credentials.length - 1)];
        if (next) focusCredential(next.key, 'remove');
        else btnCredentialAdd?.focus();
      });

      item.append(nameInput, value, remove);
      if (saved) {
        const note = el('p', 'modal-hint allowance-credential__note', t('allowanceDialog.credentials.saved'));
        note.id = `allowance-credential-note-${row.key}`;
        item.append(note);
      }
      relabelCredential(item, row);
      credentialList.append(item);
    }
    const any = credentials.length > 0;
    if (credentialsHead) credentialsHead.hidden = !any;
    // The guidance comes with the first token, before one is pasted.
    if (credentialsWarning) credentialsWarning.hidden = !any;
    if (btnCredentialAdd) btnCredentialAdd.hidden = credentials.length >= PROGRAM_ALLOWANCE_LIMITS.MAX_CREDENTIALS;
  }

  /** The labels that name the variable, after it was typed. */
  function relabelCredential(item, row) {
    const name = credentialRowLabel(row);
    const valueInput = item.querySelector('[data-field="value"]');
    valueInput?.setAttribute('aria-label', name
      ? `${t('allowanceDialog.credentials.value')} ${name}`
      : t('allowanceDialog.credentials.value'));
    const replace = item.querySelector('[data-field="replace"]');
    if (replace) {
      replace.setAttribute('aria-label', t('allowanceDialog.credentials.replace.label', { name: name || '' }));
      replace.setAttribute('aria-describedby', `allowance-credential-note-${row.key}`);
    }
    item.querySelector('[data-field="keep"]')?.setAttribute('aria-label', t('allowanceDialog.credentials.keep.label', { name: name || '' }));
    item.querySelector('[data-field="remove"]')?.setAttribute('aria-label', name
      ? t('allowanceDialog.credentials.remove', { name })
      : t('allowanceDialog.credentials.removeUnnamed'));
  }

  /**
   * A refused row is said right under the rows, where the focus goes — the
   * form's error at the top may be scrolled out of sight by then.
   */
  function showCredentialError(refusal) {
    credentialError = refusal ? { key: refusal.key, field: refusal.field } : null;
    setText(credentialsError, refusal?.error || '');
  }

  function clearCredentialError(key, field, input) {
    if (credentialError?.key !== key || credentialError.field !== field) return;
    showCredentialError(null);
    input.setAttribute('aria-invalid', 'false');
    input.removeAttribute('aria-describedby');
  }

  function addCredential() {
    if (credentials.length >= PROGRAM_ALLOWANCE_LIMITS.MAX_CREDENTIALS) return;
    const suggested = suggestedCredentialName(fieldProgram.value.trim());
    const name = suggested && !credentials.some((row) => row.name.trim() === suggested) ? suggested : '';
    credentialKey += 1;
    credentials = [...credentials, { key: credentialKey, name, id: null, replacing: false, value: '' }];
    renderCredentials();
    // With the variable proposed, the token is what is left to type.
    focusCredential(credentialKey, name ? 'value' : 'name');
  }

  /**
   * What the dialog sends for its credentials, or the first row it refuses:
   * the same checks main makes, so the field can be pointed at.
   */
  function collectCredentials() {
    const out = [];
    const seen = new Set();
    for (const row of credentials) {
      const name = row.name.trim();
      const nameProblem = credentialNameProblem(name);
      if (nameProblem === CREDENTIAL_NAME_PROBLEMS.EMPTY) {
        return { error: t('permissions.allowance.error.credentialNameEmpty'), key: row.key, field: 'name' };
      }
      if (nameProblem === CREDENTIAL_NAME_PROBLEMS.RESERVED) {
        return { error: t('permissions.allowance.error.credentialNameReserved', { name }), key: row.key, field: 'name' };
      }
      if (nameProblem) return { error: t('permissions.allowance.error.credentialNameInvalid', { name }), key: row.key, field: 'name' };
      if (seen.has(name)) return { error: t('permissions.allowance.error.credentialNameTwice', { name }), key: row.key, field: 'name' };
      seen.add(name);
      if (row.id && !row.replacing) {
        out.push({ name, id: row.id });
        continue;
      }
      const valueProblem = credentialValueProblem(row.value);
      if (valueProblem) {
        const key = {
          [CREDENTIAL_VALUE_PROBLEMS.EMPTY]: 'permissions.allowance.error.credentialValueEmpty',
          [CREDENTIAL_VALUE_PROBLEMS.SHORT]: 'permissions.allowance.error.credentialValueShort',
          [CREDENTIAL_VALUE_PROBLEMS.LONG]: 'permissions.allowance.error.credentialValueLong',
        }[valueProblem] || 'permissions.allowance.error.credentialValueInvalid';
        return {
          error: t(key, { name, min: PROGRAM_ALLOWANCE_LIMITS.MIN_SECRET_CHARS, max: PROGRAM_ALLOWANCE_LIMITS.MAX_SECRET_CHARS }),
          key: row.key,
          field: 'value',
        };
      }
      out.push({ name, value: row.value.trim() });
    }
    return { credentials: out };
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
    renderCredentials();
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
    credentials = (Array.isArray(entry?.credentials) ? entry.credentials : []).map((credential) => {
      credentialKey += 1;
      return { key: credentialKey, name: credential.name, id: credential.id, replacing: false, value: '' };
    });
    showCredentialError(null);
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
    // A typed token stays nowhere once the dialog is gone.
    credentials = [];
    showCredentialError(null);
    credentialList?.replaceChildren();
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
    const collected = collectCredentials();
    if (collected.error) {
      showCredentialError(collected);
      renderCredentials();
      focusCredential(collected.key, collected.field);
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
      credentials: collected.credentials,
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
  btnCredentialAdd?.addEventListener('click', addCredential);
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
