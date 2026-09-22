import contracts from '../generated/contracts.js';
import { t, tPlural, onLocaleChange } from '../i18n.js';

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
 * Werte. Bewusst simpel an Leerraum getrennt: MCP-Argumente sind Paketnamen
 * und Schalter, keine Sätze. Wer ein Leerzeichen im Argument braucht, kann
 * es in Anführungszeichen setzen.
 */
export function splitArgs(text) {
  const source = typeof text === 'string' ? text : '';
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = re.exec(source);
  while (match) {
    out.push(match[1] ?? match[2] ?? match[3]);
    match = re.exec(source);
  }
  return out;
}

/** Rückweg für die Anzeige; Argumente mit Leerraum bekommen Anführungszeichen. */
export function joinArgs(args) {
  return (Array.isArray(args) ? args : [])
    .map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
    .join(' ');
}

/**
 * Statuszeile eines Servers. Die Form trägt die Aussage, nicht die Farbe
 * (Regelwerk: keine grünen Statusfarben) — gefüllter Punkt heißt verbunden,
 * hohler Ring ausgeschaltet, Ausrufezeichen Fehler.
 */
export function describeConnection(server, connection) {
  if (!server?.enabled) return { kind: 'off', text: 'ausgeschaltet' };
  const state = connection?.state;
  if (state === MCP_CONNECTION_STATES.READY) {
    const count = connection.toolCount ?? 0;
    return { kind: 'on', text: `verbunden · ${count} ${count === 1 ? 'Tool' : 'Tools'}` };
  }
  if (state === MCP_CONNECTION_STATES.FAILED) {
    return { kind: 'error', text: t('settings.mcp.state.startFailed'), detail: connection.error, stderr: connection.stderr };
  }
  if (state === MCP_CONNECTION_STATES.STARTING) return { kind: 'off', text: t('settings.mcp.state.starting') };
  // IDLE heisst: eingeschaltet, aber noch nie gebraucht. Traeges Verbinden
  // ist Absicht (#106) — das soll hier nicht wie ein Fehler aussehen.
  return { kind: 'off', text: t('settings.mcp.state.notConnected') };
}

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
  const toolsBlock = document.getElementById('mcp-tools-block');
  const toolsList = document.getElementById('mcp-tools-list');
  const toolsCount = document.getElementById('mcp-tools-count');
  const formError = document.getElementById('mcp-form-error');
  const testResult = document.getElementById('mcp-test-result');

  const importOverlay = document.getElementById('mcp-import-overlay');
  const importDialog = document.getElementById('dialog-mcp-import');
  const btnImportOpen = document.getElementById('btn-import-mcp-servers');
  const btnImportClose = document.getElementById('btn-mcp-import-close');
  const btnImportCancel = document.getElementById('btn-mcp-import-cancel');
  const btnImportApply = document.getElementById('btn-mcp-import-apply');
  const importInput = document.getElementById('mcp-import-input');
  const importError = document.getElementById('mcp-import-error');
  const importCount = document.getElementById('mcp-import-count');
  const importList = document.getElementById('mcp-import-list');
  const importSkipped = document.getElementById('mcp-import-skipped');
  const importNote = document.getElementById('mcp-import-note');

  let servers = [];
  let connections = [];
  let skipped = [];
  /** Der gerade bearbeitete Server; null = neu anlegen. */
  let editing = null;
  let lastFocus = null;
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

  function statusNode(status) {
    const wrap = el('span', 'mcp-status');
    if (status.kind === 'error') {
      const badge = el('span', 'mcp-status__badge', '!');
      badge.setAttribute('aria-hidden', 'true');
      wrap.append(badge);
    } else {
      const dot = el('span', `mcp-status__dot mcp-status__dot--${status.kind}`);
      dot.setAttribute('aria-hidden', 'true');
      wrap.append(dot);
    }
    wrap.append(el('span', null, status.text));
    return wrap;
  }

  function render() {
    if (!list) return;
    list.replaceChildren();
    empty?.classList.toggle('hidden', servers.length > 0);

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

      row.append(statusNode(status));

      const actions = el('div', 'mcp-row__actions');
      const edit = el('button', 'btn-secondary btn-compact', t('settings.mcp.edit'));
      edit.type = 'button';
      edit.setAttribute('aria-label', `${server.label || server.id} bearbeiten`);
      edit.addEventListener('click', () => openDialog(server));
      actions.append(edit);

      const toggle = el('button', 'mcp-switch');
      toggle.type = 'button';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', server.enabled ? 'true' : 'false');
      toggle.setAttribute('aria-label', `${server.label || server.id} aktiv`);
      toggle.addEventListener('click', () => setEnabled(server, !server.enabled));
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
  }

  function adopt(result) {
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
      adopt(null);
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
        setError(errorEl, result?.error || t('settings.mcp.reloadFailed'));
      }
    } catch {
      setError(errorEl, t('settings.mcp.reloadFailed'));
    }
  }

  /** Ein-/Ausschalten geht ohne Umweg über den Dialog. */
  async function setEnabled(server, enabled) {
    const payload = toPayload(server, { enabled, env: keepAllEnv(server) });
    const result = await api.saveMcpServer?.(payload);
    if (result?.ok) {
      adopt(result);
      setError(errorEl, '');
    } else {
      setError(errorEl, result?.errors?.[0] || result?.error || t('settings.mcp.updateFailed'));
    }
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
      disabledTools: server.disabledTools,
      knownTools: server.knownTools,
      ...patch,
    };
  }

  // --- Unterdialog -------------------------------------------------------

  function envRow(entry = { key: '', secret: true, hasValue: false, value: '' }) {
    const row = el('div', 'mcp-env-row');
    const key = el('input', 'modal-input modal-input--mono');
    key.type = 'text';
    key.value = entry.key || '';
    key.placeholder = 'NAME';
    key.setAttribute('aria-label', t('mcpDialog.env.name'));

    const value = el('input', 'modal-input modal-input--mono');
    value.type = 'text';
    value.setAttribute('aria-label', t('mcpDialog.env.value'));
    // Ein gespeichertes Geheimnis kommt nicht zurueck — es steht als
    // Platzhalter da und bleibt unangetastet, solange niemand hineinschreibt.
    if (entry.secret && entry.hasValue) {
      value.value = SECRET_PLACEHOLDER;
      value.dataset.keep = 'true';
      value.addEventListener('focus', () => {
        if (value.dataset.keep === 'true') {
          value.value = '';
          delete value.dataset.keep;
        }
      });
    } else {
      value.value = entry.value || '';
    }

    const opts = el('div', 'mcp-env-row__opts');
    const secretLabel = el('label', 'mcp-env-row__secret');
    const secret = el('input');
    secret.type = 'checkbox';
    secret.checked = entry.secret !== false;
    secretLabel.append(secret, el('span', null, 'geheim'));
    opts.append(secretLabel);

    const remove = el('button', 'settings-dialog__icon-close');
    remove.type = 'button';
    remove.innerHTML = CLOSE_ICON_HTML;
    remove.setAttribute('aria-label', 'Umgebungsvariable entfernen');
    remove.addEventListener('click', () => row.remove());
    opts.append(remove);

    row.append(key, value, opts);
    return row;
  }

  function readEnv() {
    const env = {};
    for (const row of envList?.querySelectorAll('.mcp-env-row') || []) {
      const [key, value] = row.querySelectorAll('input[type="text"]');
      const secret = row.querySelector('input[type="checkbox"]');
      const name = String(key?.value || '').trim();
      if (!name) continue;
      if (value?.dataset.keep === 'true') {
        env[name] = { secret: true, keep: true };
        continue;
      }
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

  function renderTools(server) {
    const known = knownToolsOf(server);
    toolsBlock?.classList.toggle('hidden', !server || known.length === 0);
    if (!toolsList) return;
    toolsList.replaceChildren();
    const disabled = new Set(server?.disabledTools || []);
    for (const name of known) {
      const row = el('label', 'mcp-tool-row');
      const box = el('input');
      box.type = 'checkbox';
      box.value = name;
      box.checked = !disabled.has(name);
      row.append(box, el('code', null, name));
      toolsList.append(row);
    }
    if (toolsCount) {
      const active = known.length - known.filter((name) => disabled.has(name)).length;
      toolsCount.textContent = t('settings.mcp.state.toolsActive', { active, total: known.length });
    }
  }

  /**
   * Die abgewaehlten Tools aus dem Dialog. Zeigt der Dialog gar keine Liste —
   * weil der Server nicht laeuft und noch kein Katalog gespeichert ist —,
   * bleibt die gespeicherte Auswahl stehen. Ein leeres Formularfeld heisst
   * „unbekannt", nicht „alles wieder einschalten" (Issue #170).
   */
  function readDisabledTools() {
    const boxes = [...(toolsList?.querySelectorAll('input[type="checkbox"]') || [])];
    if (boxes.length === 0) return editing?.disabledTools || [];
    return boxes.filter((box) => !box.checked).map((box) => box.value);
  }

  function openDialog(server) {
    editing = server || null;
    lastFocus = document.activeElement;
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
    renderTools(server);
    btnDelete.classList.toggle('hidden', !server);
    btnTest.classList.toggle('hidden', !server);

    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
    queueMicrotask(() => (server ? fieldLabel : fieldId).focus());
  }

  function closeDialog() {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    editing = null;
    try {
      lastFocus?.focus();
    } catch {
      /* das Element kann inzwischen weg sein */
    }
  }

  async function save() {
    const payload = {
      id: String(fieldId.value || '').trim().toLowerCase(),
      label: String(fieldLabel.value || '').trim(),
      command: String(fieldCommand.value || '').trim(),
      args: splitArgs(fieldArgs.value),
      cwd: String(fieldCwd.value || '').trim(),
      enabled: editing ? editing.enabled : true,
      disabledTools: readDisabledTools(),
      knownTools: knownToolsOf(editing),
      env: readEnv(),
    };
    const result = await api.saveMcpServer?.(payload);
    if (result?.ok) {
      adopt(result);
      closeDialog();
      setError(errorEl, '');
      return;
    }
    setError(formError, result?.errors?.[0] || result?.error || t('settings.mcp.saveFailed'));
  }

  async function remove() {
    if (!editing) return;
    const result = await api.deleteMcpServer?.(editing.id);
    if (result?.ok) {
      adopt(result);
      closeDialog();
      return;
    }
    setError(formError, result?.errors?.[0] || result?.error || t('settings.mcp.deleteFailed'));
  }

  async function test() {
    if (!editing || !testResult) return;
    testResult.replaceChildren(el('p', 'mcp-test__pending', t('mcpDialog.test.running')));
    const result = await api.testMcpServer?.(editing.id);
    testResult.replaceChildren();
    if (!result?.ok || !result.status) {
      testResult.append(el('p', 'mcp-test__fail', result?.error || t('mcpDialog.test.failed')));
      return;
    }
    const status = result.status;
    if (status.state === MCP_CONNECTION_STATES.READY) {
      const count = result.tools?.length ?? 0;
      testResult.append(el('p', 'mcp-test__ok',
        `Verbindung steht — ${count} ${count === 1 ? 'Tool' : 'Tools'} gefunden.`));
      if (count > 0) testResult.append(el('p', 'mcp-test__tools', result.tools.join(', ')));
      // Der Katalog des Servers ist jetzt bekannt — Haekchen anbieten.
      renderTools({ ...editing, knownTools: result.tools || [] });
    } else {
      testResult.append(el('p', 'mcp-test__fail', status.error || t('mcpDialog.test.noAnswer')));
      if (status.stderr) testResult.append(el('pre', null, status.stderr));
    }
    await load();
  }

  // --- Import (Issue #110) -----------------------------------------------
  //
  // Variante B aus `docs/ui-design/mcp-import-mockup.html`: Das Eingabefeld
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
        t('mcpImport.candidate.duplicate', { id: candidate.id }), 'ersetzt', true));
    }
    const secrets = candidate.env.filter((entry) => entry.secret).map((entry) => entry.key);
    if (secrets.length > 0) {
      notes.push(importNoteRow(
        tPlural('mcpImport.candidate.secrets', secrets.length, { names: secrets.join(', ') }), 'geheim'));
    }
    for (const note of candidate.notes) {
      const warn = note.includes('Platzhalter') || note.includes(t('mcpImport.candidate.noValue'));
      notes.push(importNoteRow(note, warn ? t('mcpImport.candidate.check') : null, warn));
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
      item.append(document.createTextNode(` — ${entry.reason}`));
      list.append(item);
    }
    importSkipped.append(list);
  }

  function selectedImportCandidates() {
    return importCandidates.filter((candidate) => !importUnchecked.has(candidate.id));
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
    setError(importError, text.trim() ? (result.errors[0] || '') : '');
    if (importCount) {
      const gefunden = result.candidates.length;
      const gesamt = gefunden + result.skipped.length;
      importCount.textContent = gesamt === 0
        ? ''
        : gefunden === gesamt
          ? tPlural('mcpImport.count.all', gefunden)
          : t('mcpImport.count.partial', { count: gefunden, total: gesamt });
    }
    renderImportPreview();
    renderImportSkipped(result.skipped);
    updateImportApply();
  }

  function openImport() {
    lastFocus = document.activeElement;
    if (importInput) importInput.value = '';
    importCandidates = [];
    importUnchecked = new Set();
    setError(importError, '');
    refreshImportPreview();
    importOverlay?.classList.remove('hidden');
    importOverlay?.setAttribute('aria-hidden', 'false');
    queueMicrotask(() => importInput?.focus());
  }

  function closeImport() {
    importOverlay?.classList.add('hidden');
    importOverlay?.setAttribute('aria-hidden', 'true');
    try {
      lastFocus?.focus();
    } catch {
      /* das Element kann inzwischen weg sein */
    }
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
    if (auswahl.length === 0) return;

    if (btnImportApply) btnImportApply.disabled = true;
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
      else gescheitert.push(`${candidate.label}: ${result?.errors?.[0] || result?.error || t('mcpImport.failed.unknown')}`);
    }

    if (letztes) adopt(letztes);
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
    setError(importError, t('mcpImport.failed', { details: gescheitert.join(' · ') }));
  }

  btnReload?.addEventListener('click', reload);
  btnAdd?.addEventListener('click', () => openDialog(null));
  btnClose?.addEventListener('click', closeDialog);
  btnCancel?.addEventListener('click', closeDialog);
  btnSave?.addEventListener('click', save);
  btnDelete?.addEventListener('click', remove);
  btnTest?.addEventListener('click', test);
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
