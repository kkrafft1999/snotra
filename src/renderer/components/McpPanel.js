import contracts from '../generated/contracts.js';
import { t, tPlural, tMessage, onLocaleChange } from '../i18n.js';
import { describeConnection, connectionStatusElement } from '../utils/mcp-connection-view.js';

const { MCP_CONNECTION_STATES, parseMcpServersBlock, toMcpServerInput } = contracts;

/**
 * Einstellungen › MCP (Issue #109, Teil von #62).
 *
 * Variante C aus dem Mockup: das Panel zeigt nur die Liste mit Status und
 * Schalter, angelegt und bearbeitet wird in einem eigenen kleinen Dialog —
 * dasselbe Muster wie „Modell hinzufügen". Das Panel bleibt damit auch bei
 * vielen Servern kurz und ruhig.
 *
 * Wie die Berechtigungen (Issue #67) und anders als der Rest des Dialogs
 * wirken Änderungen hier **sofort** über den Main-Prozess, nicht erst mit
 * „Übernehmen": Die Serverliste gehört dem Main, dort liegen die Geheimnisse,
 * und ein Verbindungstest braucht ohnehin den gespeicherten Stand.
 *
 * Geheime env-Werte kommen nie in den Renderer zurück. Ein gespeichertes
 * Geheimnis erscheint im Formular als Platzhalter; wer es nicht anfasst,
 * schickt `{ keep: true }` statt eines Wertes, den diese Seite gar nicht
 * kennt.
 */

const CLOSE_ICON_HTML =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.47 3.47a.75.75 0 0 1 1.06 0L8 6.94l3.47-3.47a.75.75 0 1 1 1.06 1.06L9.06 8l3.47 3.47a.75.75 0 1 1-1.06 1.06L8 9.06l-3.47 3.47a.75.75 0 0 1-1.06-1.06L6.94 8 3.47 4.53a.75.75 0 0 1 0-1.06z"/></svg>';

/** Platzhalter für ein gespeichertes Geheimnis — nie der echte Wert. */
const SECRET_PLACEHOLDER = '••••••••••••';

/**
 * Argumente stehen im Formular als eine Zeile, intern sind es einzelne
 * Werte. Read like a command line (CR-B14-03): whitespace separates, double
 * or single quotes hold an argument together and may sit next to other text
 * (`--from="mein paket"`), `""` is an empty argument. Inside double quotes
 * `\"` and `\\` are escapes and any other backslash is literal; outside
 * quotes a backslash is always literal, so a Windows path needs no quoting.
 * An unclosed quote runs to the end of the line.
 */
export function splitArgs(text) {
  const source = typeof text === 'string' ? text : '';
  const out = [];
  let current = '';
  let started = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      if (started) out.push(current);
      current = '';
      started = false;
      i += 1;
    } else if (ch === '"') {
      started = true;
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && (source[i + 1] === '"' || source[i + 1] === '\\')) i += 1;
        current += source[i];
        i += 1;
      }
      i += 1;
    } else if (ch === "'") {
      started = true;
      const close = source.indexOf("'", i + 1);
      const stop = close === -1 ? source.length : close;
      current += source.slice(i + 1, stop);
      i = stop + 1;
    } else {
      started = true;
      current += ch;
      i += 1;
    }
  }
  if (started) out.push(current);
  return out;
}

/**
 * Rückweg für die Anzeige — so, dass `splitArgs` genau dieselbe Liste
 * zurückliest: an empty argument and one with whitespace or a quote is put
 * in double quotes, with `"` and every backslash that would read as an
 * escape escaped.
 */
export function joinArgs(args) {
  return (Array.isArray(args) ? args : [])
    .map((arg) => {
      const value = String(arg);
      if (value !== '' && !/[\s"']/.test(value)) return value;
      let quoted = '';
      for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        const next = value[i + 1];
        if (ch === '"') quoted += '\\"';
        else if (ch === '\\' && (next === undefined || next === '"' || next === '\\')) quoted += '\\\\';
        else quoted += ch;
      }
      return `"${quoted}"`;
    })
    .join(' ');
}

// The status texts are shared with Settings › Security (#462).
export { describeConnection };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function initMcpPanel({ api }) {
  const list = document.getElementById('settings-mcp-list');
  const empty = document.getElementById('settings-mcp-empty');
  const errorEl = document.getElementById('settings-mcp-error');
  const btnReload = document.getElementById('btn-reload-mcp');
  const btnAdd = document.getElementById('btn-add-mcp-server');

  const overlay = document.getElementById('mcp-server-overlay');
  const dialog = document.getElementById('dialog-mcp-server');
  const dialogTitle = document.getElementById('dialog-mcp-server-title');
  const btnClose = document.getElementById('btn-mcp-server-close');
  const btnCancel = document.getElementById('btn-mcp-server-cancel');
  const btnSave = document.getElementById('btn-mcp-server-save');
  const btnTest = document.getElementById('btn-mcp-server-test');
  const btnDelete = document.getElementById('btn-mcp-server-delete');
  const fieldId = document.getElementById('mcp-field-id');
  const fieldLabel = document.getElementById('mcp-field-label');
  const fieldCommand = document.getElementById('mcp-field-command');
  const fieldArgs = document.getElementById('mcp-field-args');
  const fieldCwd = document.getElementById('mcp-field-cwd');
  const envList = document.getElementById('mcp-env-list');
  const btnEnvAdd = document.getElementById('btn-mcp-env-add');
  const formError = document.getElementById('mcp-form-error');
  const testResult = document.getElementById('mcp-test-result');
  const testHint = document.getElementById('mcp-test-hint');

  const importOverlay = document.getElementById('mcp-import-overlay');
  const importDialog = document.getElementById('dialog-mcp-import');
  const btnImportOpen = document.getElementById('btn-import-mcp-servers');
  const btnImportClose = document.getElementById('btn-mcp-import-close');
  const btnImportCancel = document.getElementById('btn-mcp-import-cancel');
  const btnImportApply = document.getElementById('btn-mcp-import-apply');
  const importInput = document.getElementById('mcp-import-input');
  const importError = document.getElementById('mcp-import-error');
  const importAnnouncer = document.getElementById('mcp-import-announcer');
  const importCount = document.getElementById('mcp-import-count');
  const importList = document.getElementById('mcp-import-list');
  const importSkipped = document.getElementById('mcp-import-skipped');
  const importNote = document.getElementById('mcp-import-note');

  let servers = [];
  let connections = [];
  let skipped = [];
  /** Der gerade bearbeitete Server; null = neu anlegen. */
  let editing = null;
  /**
   * Where the focus goes when a dialog closes. The server dialog remembers
   * the server rather than the button: by then the list may have been
   * redrawn and the button replaced (CR-B14-07).
   */
  let dialogOpener = { node: null, serverId: null };
  let importOpener = null;
  /**
   * Counts the openings and closings of each dialog. A request remembers the
   * count it started under; an answer that arrives under another one belongs
   * to an earlier dialog and is dropped there (CR-B14-04) — a slow test must
   * not write into the next server's dialog, a slow save not close it.
   */
  let dialogGeneration = 0;
  let importGeneration = 0;
  /** A request of the server dialog is running; its actions are inert. */
  let dialogBusy = false;
  let importBusy = false;
  /**
   * The form as it was opened, i.e. as it is stored. *Test connection* tests
   * the stored server, so it waits while the form says something else
   * (CR-B14-09).
   */
  let storedFormState = '';
  let formUnsaved = false;
  /** The catalogue could not be read — then "no server yet" would be a claim. */
  let readFailed = false;
  /** The kind of import error last said out loud (see refreshImportPreview). */
  let announcedImportError = null;
  /** Erkannte Kandidaten des Import-Dialogs, in der Reihenfolge der Anzeige. */
  let importCandidates = [];
  /** Kennungen der abgewaehlten Kandidaten — abwaehlen ueberlebt das Neulesen. */
  let importUnchecked = new Set();

  function connectionOf(id) {
    return connections.find((entry) => entry.serverId === id) || null;
  }

  function setError(node, message) {
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('hidden', !message);
  }

  /** The list control that has the focus, by server and kind — it survives a redraw. */
  function focusedListControl() {
    const active = document.activeElement;
    if (!active || !list?.contains(active)) return null;
    return { serverId: active.dataset?.serverId || null, action: active.dataset?.mcpAction || null };
  }

  function listControl(serverId, action) {
    return [...(list?.querySelectorAll('[data-mcp-action]') || [])]
      .find((node) => node.dataset.serverId === serverId && node.dataset.mcpAction === action) || null;
  }

  function render() {
    if (!list) return;
    // A redraw replaces every row. The control that had the focus gets it
    // back on its new node; a server that is gone hands it to "Add server"
    // instead of dropping it to the page (CR-B14-07).
    const focused = focusedListControl();
    list.replaceChildren();
    empty?.classList.toggle('hidden', servers.length > 0 || readFailed);

    for (const server of servers) {
      const connection = connectionOf(server.id);
      const status = describeConnection(server, connection);
      const row = el('li', 'mcp-row');

      const main = el('div', 'mcp-row__main');
      main.append(el('span', 'mcp-row__name', server.label || server.id));
      const meta = el('span', 'mcp-row__meta', `${server.command} ${joinArgs(server.args)}`.trim());
      meta.title = meta.textContent;
      main.append(meta);
      row.append(main);

      row.append(connectionStatusElement(status));

      const actions = el('div', 'mcp-row__actions');
      const edit = el('button', 'btn-secondary btn-compact', t('settings.mcp.edit'));
      edit.type = 'button';
      edit.setAttribute('aria-label', t('settings.mcp.edit.label', { name: server.label || server.id }));
      edit.dataset.serverId = server.id;
      edit.dataset.mcpAction = 'edit';
      edit.addEventListener('click', () => openDialog(server));
      actions.append(edit);

      const toggle = el('input', 'ds-switch');
      toggle.type = 'checkbox';
      toggle.setAttribute('role', 'switch');
      toggle.checked = Boolean(server.enabled);
      toggle.setAttribute('aria-label', t('settings.mcp.enabled.label', { name: server.label || server.id }));
      toggle.dataset.serverId = server.id;
      toggle.dataset.mcpAction = 'switch';
      toggle.addEventListener('change', async () => {
        // A refused save leaves the list as it was, so the box has to go back.
        if (!(await setEnabled(server, toggle.checked))) toggle.checked = Boolean(server.enabled);
      });
      actions.append(toggle);
      row.append(actions);

      if (status.kind === 'error' && (status.detail || status.stderr)) {
        const box = el('div', 'mcp-row__error');
        if (status.detail) box.append(el('p', null, status.detail));
        if (status.stderr) box.append(el('pre', null, status.stderr));
        row.append(box);
      }
      list.append(row);
    }

    if (skipped.length > 0) {
      const note = el('li', 'mcp-row mcp-row--note');
      note.append(el('p', null,
        `${tPlural('settings.mcp.skippedTools', skipped.length)} `
        + skipped.map((entry) => `${entry.serverId}/${entry.name}`).join(', ')));
      list.append(note);
    }

    if (focused) (listControl(focused.serverId, focused.action) || btnAdd)?.focus();
  }

  function adopt(result, { failed = false } = {}) {
    readFailed = failed;
    servers = Array.isArray(result?.servers) ? result.servers : [];
    connections = Array.isArray(result?.connections) ? result.connections : [];
    skipped = Array.isArray(result?.skippedTools) ? result.skippedTools : [];
    render();
  }

  async function load() {
    try {
      adopt(typeof api.getMcpCatalog === 'function' ? await api.getMcpCatalog() : null);
      setError(errorEl, '');
    } catch {
      adopt(null, { failed: true });
      setError(errorEl, t('settings.mcp.readFailed'));
    }
  }

  async function reload() {
    try {
      const result = await api.reloadMcpServers?.();
      if (result?.ok) {
        adopt(result);
        setError(errorEl, '');
      } else {
        setError(errorEl, tMessage(result?.error) || t('settings.mcp.reloadFailed'));
      }
    } catch {
      setError(errorEl, t('settings.mcp.reloadFailed'));
    }
  }

  /** Ein-/Ausschalten geht ohne Umweg über den Dialog. */
  async function setEnabled(server, enabled) {
    const payload = toPayload(server, { enabled, env: keepAllEnv(server) });
    let result = null;
    try {
      result = await api.saveMcpServer?.(payload);
    } catch {
      // A rejected call is a failed save — the switch goes back (CR-B14-04).
      result = null;
    }
    if (result?.ok) {
      // The list is redrawn with the new status; render() hands the focus
      // to the new switch.
      adopt(result);
      setError(errorEl, '');
      return true;
    }
    setError(errorEl, tMessage(result?.errors?.[0]) || tMessage(result?.error) || t('settings.mcp.updateFailed'));
    return false;
  }

  /** Beim bloßen Umschalten bleiben alle env-Werte, wie sie sind. */
  function keepAllEnv(server) {
    const env = {};
    for (const entry of server.env || []) {
      env[entry.key] = entry.secret ? { secret: true, keep: true } : { secret: false, value: entry.value ?? '' };
    }
    return env;
  }

  function toPayload(server, patch = {}) {
    return {
      id: server.id,
      label: server.label,
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      enabled: server.enabled,
      // One switch per tool since #449, on the Security page; the server keeps
      // no deselection of its own (mcp-disabled-tools-migration.js).
      disabledTools: [],
      knownTools: server.knownTools,
      ...patch,
    };
  }

  // --- Unterdialog -------------------------------------------------------

  /**
   * One environment variable. A stored secret never comes back: it shows as
   * a placeholder and goes out as `keep` until the user types a new value
   * (CR-B14-02). Focus alone changes nothing — the field empties for typing
   * and fills again on blur when nothing was typed. While the stored value is
   * kept, its name and its "secret" box are locked: renaming it or storing it
   * in plain text needs the value, which this side does not know.
   */
  function envRow(entry = { key: '', secret: true, hasValue: false, value: '' }) {
    const stored = entry.secret === true && entry.hasValue === true;
    const row = el('div', 'mcp-env-row');

    const key = el('input', 'modal-input modal-input--mono mcp-env-row__key');
    key.type = 'text';
    key.value = entry.key || '';
    key.placeholder = 'NAME';
    key.autocomplete = 'off';
    key.spellcheck = false;
    key.setAttribute('aria-label', t('mcpDialog.env.name'));

    const value = el('input', 'modal-input modal-input--mono mcp-env-row__value');
    value.autocomplete = 'off';
    value.spellcheck = false;
    value.setAttribute('aria-label', t('mcpDialog.env.value'));

    const opts = el('div', 'mcp-env-row__opts');
    const secretLabel = el('label', 'mcp-env-row__secret');
    const secret = el('input');
    secret.type = 'checkbox';
    secret.checked = entry.secret !== false;
    secretLabel.append(secret, el('span', null, t('mcpDialog.env.secret')));
    opts.append(secretLabel);

    // A value meant to be secret is masked while it is typed.
    const syncMask = () => { value.type = secret.checked ? 'password' : 'text'; };
    secret.addEventListener('change', syncMask);

    function setKept(kept) {
      if (kept) {
        value.dataset.keep = 'true';
        value.value = SECRET_PLACEHOLDER;
        key.value = entry.key;
        secret.checked = true;
        syncMask();
      } else {
        delete value.dataset.keep;
      }
      key.readOnly = kept;
      secret.disabled = kept;
      // The hint below the list says why both are locked.
      for (const node of [key, secret]) {
        if (kept) node.setAttribute('aria-describedby', 'mcp-env-hint');
        else node.removeAttribute('aria-describedby');
      }
    }

    if (stored) {
      row.dataset.storedKey = entry.key;
      value.placeholder = t('mcpDialog.env.keptPlaceholder');
      setKept(true);
      value.addEventListener('focus', () => {
        if (value.dataset.keep === 'true') value.value = '';
      });
      value.addEventListener('input', () => {
        if (value.dataset.keep === 'true' && value.value !== '') setKept(false);
      });
      value.addEventListener('blur', () => {
        if (value.value === '') setKept(true);
      });
    } else {
      value.value = entry.value || '';
      syncMask();
    }

    const remove = el('button', 'settings-dialog__icon-close');
    remove.type = 'button';
    remove.innerHTML = CLOSE_ICON_HTML;
    remove.setAttribute('aria-label', t('mcpDialog.env.remove'));
    remove.addEventListener('click', () => {
      // The pressed button goes with its row; the focus moves to the next
      // row, else the previous one, else "Add variable" (CR-B14-07).
      const neighbour = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      (neighbour?.querySelector('.mcp-env-row__key') || btnEnvAdd)?.focus();
      updateUnsaved();
    });
    opts.append(remove);

    row.append(key, value, opts);
    return row;
  }

  function readEnv() {
    const env = {};
    for (const row of envList?.querySelectorAll('.mcp-env-row') || []) {
      const key = row.querySelector('.mcp-env-row__key');
      const value = row.querySelector('.mcp-env-row__value');
      const secret = row.querySelector('.mcp-env-row__secret input');
      // A stored secret with an empty field is unchanged — also while the
      // field still has the focus and its blur has not run yet. It goes out
      // under the name it is stored under.
      const unchanged = value?.value === ''
        || (value?.dataset.keep === 'true' && value.value === SECRET_PLACEHOLDER);
      if (row.dataset.storedKey && unchanged) {
        env[row.dataset.storedKey] = { secret: true, keep: true };
        continue;
      }
      const name = String(key?.value || '').trim();
      if (!name) continue;
      env[name] = { secret: secret?.checked === true, value: String(value?.value ?? '') };
    }
    return env;
  }

  /**
   * Die Tool-Namen eines Servers: bevorzugt die der laufenden Verbindung,
   * sonst der gespeicherte Katalog der letzten Verbindung. Ohne beides bleibt
   * die Liste leer — dann war der Server noch nie erreichbar.
   */
  function knownToolsOf(server) {
    const connection = connectionOf(server?.id);
    const live = connection?.state === MCP_CONNECTION_STATES.READY ? connection.toolNames || [] : [];
    if (live.length > 0) return live;
    return Array.isArray(server?.knownTools) ? server.knownTools : [];
  }

  /**
   * Test, Save and Remove take no second press while a request runs. They are
   * marked `aria-disabled` rather than disabled: a disabled button loses the
   * focus to the top of the window (CR-B13-03). Cancel stays live — it is how
   * a slow test is left behind.
   */
  function setDialogBusy(busy) {
    dialogBusy = busy;
    syncDialogActions();
  }

  function syncDialogActions() {
    const inert = [
      [btnSave, dialogBusy],
      [btnDelete, dialogBusy],
      [btnTest, dialogBusy || formUnsaved],
    ];
    for (const [button, off] of inert) {
      if (off) button?.setAttribute('aria-disabled', 'true');
      else button?.removeAttribute('aria-disabled');
    }
    // The hint says why Test waits; it is the button's description meanwhile.
    testHint?.classList.toggle('hidden', !formUnsaved);
    if (formUnsaved) btnTest?.setAttribute('aria-describedby', 'mcp-test-hint');
    else btnTest?.removeAttribute('aria-describedby');
  }

  function formState() {
    return JSON.stringify([fieldLabel.value, fieldCommand.value, fieldArgs.value, fieldCwd.value, readEnv()]);
  }

  /** Test only applies to a stored server whose form shows what is stored. */
  function updateUnsaved() {
    formUnsaved = Boolean(editing) && formState() !== storedFormState;
    syncDialogActions();
  }

  function openDialog(server) {
    dialogGeneration += 1;
    setDialogBusy(false);
    editing = server || null;
    dialogOpener = { node: document.activeElement, serverId: server?.id || null };
    setError(formError, '');
    if (testResult) testResult.replaceChildren();

    dialogTitle.textContent = server ? t('mcpDialog.title.edit') : t('mcpDialog.title.add');
    fieldId.value = server?.id || '';
    fieldId.disabled = Boolean(server);
    fieldLabel.value = server?.label || '';
    fieldCommand.value = server?.command || '';
    fieldArgs.value = joinArgs(server?.args);
    fieldCwd.value = server?.cwd || '';
    envList.replaceChildren();
    for (const entry of server?.env || []) envList.append(envRow(entry));
    btnDelete.classList.toggle('hidden', !server);
    btnTest.classList.toggle('hidden', !server);
    storedFormState = formState();
    updateUnsaved();

    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    queueMicrotask(() => (server ? fieldLabel : fieldId).focus());
  }

  function closeDialog() {
    const wasOpen = !overlay.classList.contains('hidden');
    dialogGeneration += 1;
    formUnsaved = false;
    setDialogBusy(false);
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    editing = null;
    if (!wasOpen) return;
    // Back to the row's Edit button — the one on screen now, after a save,
    // a test or a reload redrew the list. A removed server leaves "Add
    // server" as the nearest place.
    const { node, serverId } = dialogOpener;
    const target = serverId
      ? listControl(serverId, 'edit') || btnAdd
      : (node?.isConnected ? node : btnAdd);
    target?.focus();
  }

  /** The arguments as typed — or exactly as stored when the line was not edited. */
  function readArgs() {
    if (editing && fieldArgs.value === joinArgs(editing.args)) return [...(editing.args || [])];
    return splitArgs(fieldArgs.value);
  }

  /**
   * Runs one request of the server dialog: inert while it runs, its answer
   * dropped once the dialog has moved on. A rejection counts as no answer.
   * Returns `{ stale, result }`.
   */
  async function dialogRequest(call) {
    const generation = dialogGeneration;
    setDialogBusy(true);
    let result = null;
    try {
      result = await call();
    } catch {
      result = null;
    }
    const stale = generation !== dialogGeneration;
    if (!stale) setDialogBusy(false);
    return { stale, result };
  }

  async function save() {
    if (dialogBusy) return;
    const payload = {
      id: String(fieldId.value || '').trim().toLowerCase(),
      label: String(fieldLabel.value || '').trim(),
      command: String(fieldCommand.value || '').trim(),
      args: readArgs(),
      cwd: String(fieldCwd.value || '').trim(),
      enabled: editing ? editing.enabled : true,
      disabledTools: [],
      knownTools: knownToolsOf(editing),
      env: readEnv(),
      // "Add server" never replaces an existing one; main refuses a taken id
      // (CR-B14-03). Editing — and the import, which says "replaces" — do.
      ...(editing ? {} : { create: true }),
    };
    const { stale, result } = await dialogRequest(() => api.saveMcpServer?.(payload));
    // What was saved is saved: the list shows it even when the dialog that
    // asked is gone. Only that dialog is closed or told why not.
    if (result?.ok) adopt(result);
    if (stale) return;
    if (result?.ok) {
      closeDialog();
      setError(errorEl, '');
      return;
    }
    setError(formError, tMessage(result?.errors?.[0]) || tMessage(result?.error) || t('settings.mcp.saveFailed'));
  }

  async function remove() {
    if (!editing || dialogBusy) return;
    const id = editing.id;
    const { stale, result } = await dialogRequest(() => api.deleteMcpServer?.(id));
    if (result?.ok) adopt(result);
    if (stale) return;
    if (result?.ok) {
      closeDialog();
      return;
    }
    setError(formError, tMessage(result?.errors?.[0]) || tMessage(result?.error) || t('settings.mcp.deleteFailed'));
  }

  async function test() {
    if (!editing || !testResult || dialogBusy || formUnsaved) return;
    const id = editing.id;
    testResult.replaceChildren(el('p', 'mcp-test__pending', t('mcpDialog.test.running')));
    const { stale, result } = await dialogRequest(() => api.testMcpServer?.(id));
    if (stale) {
      // The test still changed the connection; the list shows it.
      await load();
      return;
    }
    testResult.replaceChildren();
    if (!result?.ok || !result.status) {
      testResult.append(el('p', 'mcp-test__fail', tMessage(result?.error) || t('mcpDialog.test.failed')));
      return;
    }
    const status = result.status;
    if (status.state === MCP_CONNECTION_STATES.READY) {
      const count = result.tools?.length ?? 0;
      testResult.append(el('p', 'mcp-test__ok', tPlural('mcpDialog.test.ok', count)));
      if (count > 0) testResult.append(el('p', 'mcp-test__tools', result.tools.join(', ')));
    } else {
      testResult.append(el('p', 'mcp-test__fail', tMessage(status.error) || t('mcpDialog.test.noAnswer')));
      if (status.stderr) testResult.append(el('pre', null, status.stderr));
    }
    await load();
  }

  // --- Import (Issue #110) -----------------------------------------------
  //
  // Variant B of the import mockup: the input field
  // bleibt stehen, die Vorschau waechst darunter mit. Gelesen wird ausschliesslich der eingefuegte Text —
  // es wird keine fremde Konfigurationsdatei geoeffnet.
  //
  // Geparst wird im Renderer, gespeichert wird ueber denselben Weg wie ein
  // von Hand eingetragener Server. Die Vorschau ist damit nur eine Ansicht;
  // die Hoheit ueber Gueltigkeit und Geheimnisse bleibt im Main-Prozess.

  /** Ein Hinweis unter der Vorschauzeile, optional mit Marke davor. */
  function importNoteRow(text, badge = null, warn = false) {
    const row = el('li', 'mcp-import__note');
    if (badge) {
      row.append(el('span', `mcp-import__badge${warn ? ' mcp-import__badge--warn' : ''}`, badge));
    }
    row.append(el('span', null, text));
    return row;
  }

  /**
   * Die Hinweise einer Zeile. Was eine Entscheidung verlangt — ein Server
   * wuerde ersetzt, ein Wert ist noch ein Platzhalter — bekommt die auffaellige
   * Marke; der Rest bleibt ruhig.
   */
  function importNotesFor(candidate) {
    const notes = [];
    if (candidate.conflict) {
      notes.push(importNoteRow(
        t('mcpImport.candidate.duplicate', { id: candidate.id }), t('mcpImport.candidate.replaces'), true));
    }
    if (candidate.cwd) notes.push(importNoteRow(t('mcpImport.candidate.cwd', { cwd: candidate.cwd })));
    const secrets = candidate.env.filter((entry) => entry.secret).map((entry) => entry.key);
    if (secrets.length > 0) {
      notes.push(importNoteRow(
        tPlural('mcpImport.candidate.secrets', secrets.length, { names: secrets.join(', ') }), t('mcpImport.candidate.secret')));
    }
    // Encrypted is the default, so what is not encrypted has to be said —
    // a `DATABASE_URL` can carry a password without looking like a secret
    // (CR-B14-02). An empty value has its own note below.
    const plain = candidate.env.filter((entry) => !entry.secret && entry.value !== '').map((entry) => entry.key);
    if (plain.length > 0) {
      notes.push(importNoteRow(
        tPlural('mcpImport.candidate.plainValues', plain.length, { names: plain.join(', ') }), t('mcpImport.candidate.plain')));
    }
    // A placeholder or a missing value has to be dealt with before the server
    // is switched on — that is what the loud mark is for. Recognised by the
    // key, not by the wording (issue #293).
    for (const note of candidate.notes) {
      const warn = note?.key === 'mcpImport.note.envPlaceholder'
        || note?.key === 'mcpImport.note.envValueEmpty';
      notes.push(importNoteRow(tMessage(note), warn ? t('mcpImport.candidate.check') : null, warn));
    }
    return notes;
  }

  function renderImportPreview() {
    if (!importList) return;
    importList.replaceChildren();

    for (const candidate of importCandidates) {
      const row = el('li', 'mcp-import__row');

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'mcp-import__check';
      check.checked = !importUnchecked.has(candidate.id);
      check.setAttribute('aria-label', t('mcpImport.candidate.apply', { name: candidate.label }));
      check.addEventListener('change', () => {
        if (check.checked) importUnchecked.delete(candidate.id);
        else importUnchecked.add(candidate.id);
        updateImportApply();
      });
      row.append(check);

      const main = el('div', null);
      const head = el('div', null);
      head.append(el('span', 'mcp-import__name', candidate.label));
      // Der Name darf alles sein, die Kennung nicht — beide zeigen, sonst
      // ueberrascht spaeter der Tool-Namensraum.
      head.append(el('span', 'mcp-import__id', candidate.id));
      main.append(head);
      main.append(el('div', 'mcp-import__cmd', `${candidate.command} ${joinArgs(candidate.args)}`.trim()));

      const notes = importNotesFor(candidate);
      if (notes.length > 0) {
        const list = el('ul', 'mcp-import__notes');
        for (const note of notes) list.append(note);
        main.append(list);
      }
      row.append(main);
      importList.append(row);
    }

    importNote?.classList.toggle('hidden', importCandidates.length === 0);
  }

  function renderImportSkipped(skippedEntries) {
    if (!importSkipped) return;
    importSkipped.replaceChildren();
    importSkipped.classList.toggle('hidden', skippedEntries.length === 0);
    if (skippedEntries.length === 0) return;

    importSkipped.append(el('h4', null,
      tPlural('mcpImport.skipped', skippedEntries.length)));
    const list = el('ul', null);
    for (const entry of skippedEntries) {
      const item = el('li', null);
      item.append(el('strong', null, entry.name));
      item.append(document.createTextNode(` — ${tMessage(entry.reason)}`));
      list.append(item);
    }
    importSkipped.append(list);
  }

  function selectedImportCandidates() {
    return importCandidates.filter((candidate) => !importUnchecked.has(candidate.id));
  }

  /** While the import saves, its button is inert but keeps the focus. */
  function setImportBusy(busy) {
    importBusy = busy;
    if (busy) btnImportApply?.setAttribute('aria-disabled', 'true');
    else btnImportApply?.removeAttribute('aria-disabled');
  }

  function updateImportApply() {
    if (!btnImportApply) return;
    const count = selectedImportCandidates().length;
    btnImportApply.disabled = count === 0;
    btnImportApply.textContent = count === 0
      ? t('mcpImport.apply')
      : tPlural('mcpImport.apply.count', count);
  }

  /** Bei jeder Eingabe neu lesen — der Block ist klein, das kostet nichts. */
  function refreshImportPreview() {
    const text = importInput?.value ?? '';
    const result = parseMcpServersBlock(text, { existingIds: servers.map((server) => server.id) });

    importCandidates = result.candidates;
    // Abgewaehlte Kennungen, die es nicht mehr gibt, vergessen.
    importUnchecked = new Set([...importUnchecked].filter(
      (id) => importCandidates.some((candidate) => candidate.id === id)));

    // Ein leeres Feld ist kein Fehler, sondern der Ausgangszustand.
    const error = text.trim() ? result.errors[0] || null : null;
    setError(importError, error ? tMessage(error) : '');
    importInput?.setAttribute('aria-invalid', error ? 'true' : 'false');
    // The line is rewritten on every keystroke, so it is no live region
    // itself. What is said out loud is a change of the kind of error — a
    // JSON position that moves along with the cursor is not news (CR-B14-09).
    const kind = error?.key || null;
    if (kind !== announcedImportError) {
      announcedImportError = kind;
      announceImport(error ? tMessage(error) : '');
    }
    if (importCount) {
      const gefunden = result.candidates.length;
      const gesamt = gefunden + result.skipped.length;
      importCount.textContent = gesamt === 0
        ? ''
        : gefunden === gesamt
          ? tPlural('mcpImport.count.all', gefunden)
          : tPlural('mcpImport.count.partial', gefunden, { total: gesamt });
    }
    renderImportPreview();
    renderImportSkipped(result.skipped);
    updateImportApply();
  }

  function announceImport(message) {
    if (importAnnouncer) importAnnouncer.textContent = message || '';
  }

  function openImport() {
    importGeneration += 1;
    setImportBusy(false);
    importOpener = document.activeElement;
    if (importInput) importInput.value = '';
    importCandidates = [];
    importUnchecked = new Set();
    announcedImportError = null;
    announceImport('');
    setError(importError, '');
    refreshImportPreview();
    importOverlay?.classList.remove('hidden');
    importOverlay?.setAttribute('aria-hidden', 'false');
    queueMicrotask(() => importInput?.focus());
  }

  function closeImport() {
    const wasOpen = importOverlay ? !importOverlay.classList.contains('hidden') : false;
    importGeneration += 1;
    setImportBusy(false);
    importOverlay?.classList.add('hidden');
    importOverlay?.setAttribute('aria-hidden', 'true');
    if (wasOpen) (importOpener?.isConnected ? importOpener : btnImportOpen)?.focus();
  }

  /**
   * Uebernimmt die angehakten Kandidaten — einen nach dem anderen, ueber
   * denselben Speicherweg wie ein von Hand eingetragener Server.
   *
   * Ein Fehlschlag bricht nicht ab: Die uebrigen sind unabhaengig voneinander,
   * und ein halb durchgelaufener Import, der nichts sagt, waere schlimmer als
   * einer, der nennt, was nicht ging.
   */
  async function applyImport() {
    const auswahl = selectedImportCandidates();
    if (auswahl.length === 0 || importBusy) return;

    const generation = importGeneration;
    setImportBusy(true);
    const gescheitert = [];
    let letztes = null;

    for (const candidate of auswahl) {
      let result = null;
      try {
        result = await api.saveMcpServer?.(toMcpServerInput(candidate));
      } catch {
        result = null;
      }
      if (result?.ok) letztes = result;
      else gescheitert.push(`${candidate.label}: ${tMessage(result?.errors?.[0]) || tMessage(result?.error) || t('mcpImport.failed.unknown')}`);
    }

    if (letztes) adopt(letztes);
    // Closed or reopened meanwhile: what went through is in the list, the
    // report belonged to the dialog that is gone (CR-B14-04).
    if (generation !== importGeneration) return;
    setImportBusy(false);
    if (gescheitert.length === 0) {
      closeImport();
      setError(errorEl, '');
      return;
    }
    // Was durchging, ist gespeichert und steht in der Liste; der Dialog bleibt
    // offen, damit der Rest nicht unbemerkt verloren geht.
    //
    // Erst neu lesen, dann melden: Die Vorschau setzt die Fehlerzeile aus dem
    // Parse-Ergebnis und wuerde eine vorher gesetzte Meldung gleich wieder
    // loeschen. Nebenbei stehen die eben gespeicherten Server jetzt als
    // „ersetzt" da, was sie ab sofort ja auch sind.
    refreshImportPreview();
    const report = t('mcpImport.failed', { details: gescheitert.join(' · ') });
    setError(importError, report);
    announceImport(report);
  }

  btnReload?.addEventListener('click', reload);
  btnAdd?.addEventListener('click', () => openDialog(null));
  btnClose?.addEventListener('click', closeDialog);
  btnCancel?.addEventListener('click', closeDialog);
  btnSave?.addEventListener('click', save);
  btnDelete?.addEventListener('click', remove);
  btnTest?.addEventListener('click', test);
  dialog?.addEventListener('input', updateUnsaved);
  dialog?.addEventListener('change', updateUnsaved);
  btnImportOpen?.addEventListener('click', openImport);
  btnImportClose?.addEventListener('click', closeImport);
  btnImportCancel?.addEventListener('click', closeImport);
  btnImportApply?.addEventListener('click', applyImport);
  importInput?.addEventListener('input', refreshImportPreview);
  // Einfuegen meldet sich vor dem Aktualisieren des Feldes — deshalb erst im
  // naechsten Tick lesen, sonst sieht die Vorschau den alten Stand.
  importInput?.addEventListener('paste', () => queueMicrotask(refreshImportPreview));
  importDialog?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeImport();
  });
  btnEnvAdd?.addEventListener('click', () => {
    const row = envRow();
    envList.append(row);
    row.querySelector('input')?.focus();
  });
  // Escape schliesst nur den Unterdialog, nicht den ganzen
  // Einstellungs-Dialog darunter.
  dialog?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeDialog();
  });

  // Language change (epic #277): the server list and the import preview are
  // built entirely here, out of reach of `applyTranslations`.
  onLocaleChange(() => {
    render();
    renderImportPreview();
  });

  return {
    async open() {
      await load();
    },
    close() {
      closeDialog();
      closeImport();
    },
  };
}
