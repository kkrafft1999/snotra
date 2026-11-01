import { formatHistoryTime } from '../chat/messageUtils.js';
import { t, tMessage, tPlural, onLocaleChange } from '../i18n.js';
import contracts from '../generated/contracts.js';
import { formatCostAmount } from './CostPanel.js';
import { formatCount } from '../utils/helpers.js';

const { CHAT_ACTIVATION, normalizeSessionCost, summarizeSessionCost } = contracts;

/**
 * Der Chat-Verlauf als Spalte neben dem Chat (Epic #223, Phase B).
 *
 * Bis 1.7.0 war er ein Ausklapper ueber den Nachrichten: Er schob den Chat nach
 * unten, ging beim Klick daneben und bei Escape wieder zu und war nach jeder
 * Auswahl weg. Als Spalte bleibt er stehen — man sieht den laufenden Chat und
 * die Liste gleichzeitig, und das Umschalten kostet keine Gedaechtnisleistung
 * mehr. Deshalb schliesst hier nichts mehr von selbst.
 *
 * Ein- und ausgeblendet wird die Spalte inzwischen wie ihre drei Geschwister
 * ueber die Titelzeile; in der Kopfzeile des Verlaufs steht stattdessen der
 * Knopf fuer einen neuen Chat — so wie "Ordner oeffnen" in der Kopfzeile des
 * Baums steht.
 */
const NO_RUNS = Object.freeze({
  detach: () => {},
  canAttach: () => false,
  attach: () => false,
  afterSwitch: () => {},
  syncComposer: () => {},
  discard: () => {},
  stateOf: () => null,
  holdSwitch: () => () => {},
});

// Which run state a row shows, and the words for it. The words are part of the
// row's accessible name too — the dot alone would say nothing to a screen
// reader (WCAG 1.4.1).
const RUN_STATE_LABELS = Object.freeze({
  running: 'history.entry.running',
  awaiting: 'history.entry.awaiting',
});

const BIN_ICON_HTML =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

// A bookmark: outlined while a chat is not kept, filled once it is (#1320).
const KEEP_ICON_HTML =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

const CHEVRON_ICON_HTML =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

const FOLDER_GONE_ICON_HTML =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="9" y1="14" x2="15" y2="14"/></svg>';

/** The last part of a folder path, on either platform's separator. */
function folderName(root) {
  const parts = String(root || '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || String(root || '');
}

export function initChatHistoryPanel({
  api,
  appStore,
  stopChatVoiceListening,
  renderChatMessages,
  updateChatChrome,
  onInputChanged,
  setChatTokenUsage,
  resetChatTokenUsage,
  seedGreetingIfWorkspace,
  onNewChatStarted,
  // Modell und Freigabemodus des Chats herstellen (Issue #211).
  activateChatSession = async () => {},
  // Nach dem Ein- oder Ausblenden teilt der Resizer die Breiten neu auf.
  onVisibilityChanged = () => {},
  // Wer einen Chat aus dem Verlauf anklickt, will ihn sehen — auch wenn die
  // Chat-Spalte gerade zu ist (Spiegelbild zum Klick auf eine Datei im Baum).
  revealChatPanel = () => {},
  // Runs per chat (#320): a chat that is still running opens from memory, a
  // deleted one stops, and its row says whether it is working or waiting.
  runs = NO_RUNS,
}) {
  const appRoot = document.getElementById('app');
  const chatHistoryList = document.getElementById('chat-history-list');
  const chatHistoryEmpty = document.getElementById('chat-history-empty');
  // Der Schalter steht in der Titelzeile, gespiegelt zu denen der linken
  // Haelfte — nicht mehr in der Kopfzeile des Chats.
  const btnChatHistory = document.getElementById('btn-toggle-chat-history');
  // The row that asks "Delete this chat?" right now, if any (#582).
  let pendingRemoval = null;
  // Says what *Keep* and *Assign to this folder* did (#1320); the list is
  // redrawn after an assignment, so the words cannot sit in a row.
  const chatHistoryStatus = document.getElementById('chat-history-status');
  // Whether the note about chats from missing folders is unfolded; it stays
  // so across redraws, and folds again with the next folder (#1320).
  let orphansOpen = false;
  let orphansRoot = null;
  // The chats a folder keeps, for the bookmark's tooltip.
  let folderLimit = null;

  function isHistoryOpen() {
    return !appRoot.classList.contains('app--no-history');
  }

  /**
   * `persist: false` beim Herstellen des gemerkten Zustands und beim
   * automatischen Wegklappen im zu schmalen Fenster — was der Nutzer zuletzt
   * wollte, soll ein Platzmangel nicht ueberschreiben.
   */
  function setHistoryOpen(open, { persist = true } = {}) {
    // Folded away — by hand or for lack of room — the column does not take
    // the focus with it (#586).
    if (!open && document.getElementById('chat-history')?.contains(document.activeElement)) {
      btnChatHistory?.focus();
    }
    appRoot.classList.toggle('app--no-history', !open);
    const label = open ? t('titlebar.history.hide') : t('titlebar.history.show');
    // aria-pressed statt aria-expanded: Der Knopf schaltet eine Spalte, er
    // klappt nichts aus — genau wie seine drei Nachbarn in der Titelzeile.
    btnChatHistory?.setAttribute('aria-pressed', open ? 'true' : 'false');
    btnChatHistory?.setAttribute('aria-label', label);
    if (btnChatHistory) btnChatHistory.title = label;
    onVisibilityChanged(open, { persisted: persist });
    if (persist) void api.setUIPrefs({ chatHistoryVisible: open }).catch(() => {});
  }

  /**
   * A failed read shows a line in place of the list (#586) — before, the
   * rejection escaped the click handler and the column never opened.
   */
  async function renderHistoryList() {
    let hist;
    try {
      hist = await api.getChatHistory();
    } catch {
      hist = null;
    }
    pendingRemoval = null;
    chatHistoryList.innerHTML = '';
    if (!hist) {
      chatHistoryEmpty.textContent = t('history.loadFailed');
      chatHistoryEmpty.classList.remove('hidden');
      return;
    }
    const sessions = Array.isArray(hist.sessions) ? [...hist.sessions] : [];
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    folderLimit = Number.isInteger(hist.limits?.folder?.max) ? hist.limits.folder.max : null;
    if (orphansRoot !== (hist.workspaceRoot ?? null)) {
      orphansRoot = hist.workspaceRoot ?? null;
      orphansOpen = false;
    }
    const orphaned = Array.isArray(hist.orphaned) ? hist.orphaned : [];
    if (orphaned.length > 0) chatHistoryList.appendChild(buildOrphanNote(orphaned));
    chatHistoryEmpty.textContent = t('history.empty');
    chatHistoryEmpty.classList.toggle('hidden', sessions.length > 0);
    for (const s of sessions) {
      chatHistoryList.appendChild(buildRow(s));
    }
    // The ceiling across all folders is never applied by dropping chats
    // (#1320): reaching it is said here, quietly, and the user decides.
    const overall = hist.limits?.overall;
    if (overall?.reached) {
      const note = document.createElement('p');
      note.className = 'chat-history-ceiling';
      note.textContent = t('history.ceiling', { count: formatCount(overall.count), max: formatCount(overall.max) });
      chatHistoryList.appendChild(note);
    }
  }

  function announce(text) {
    if (!chatHistoryStatus) return;
    chatHistoryStatus.textContent = '';
    chatHistoryStatus.textContent = text;
  }

  /**
   * Chats whose folder is gone (#1320) — renamed, moved or deleted. One quiet
   * note above the list says how many; unfolded, it groups them by the folder
   * they were in, each group with *Assign all* and each chat with *Assign*.
   * They do not open from here: the open folder hands out only its own
   * chats (#68), so a chat is assigned first.
   */
  function buildOrphanNote(orphaned) {
    const box = document.createElement('section');
    box.className = 'chat-history-orphans';
    const regionId = 'chat-history-orphans-list';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chat-history-orphans-toggle';
    toggle.setAttribute('aria-expanded', orphansOpen ? 'true' : 'false');
    toggle.setAttribute('aria-controls', regionId);
    const icon = document.createElement('span');
    icon.className = 'chat-history-orphans-icon';
    icon.innerHTML = FOLDER_GONE_ICON_HTML;
    const text = document.createElement('span');
    text.className = 'chat-history-orphans-text';
    text.textContent = tPlural('history.orphans.summary', orphaned.length, { count: formatCount(orphaned.length) });
    const action = document.createElement('span');
    action.className = 'chat-history-orphans-action';
    const actionText = document.createElement('span');
    const chevron = document.createElement('span');
    chevron.className = 'chat-history-orphans-chevron';
    chevron.innerHTML = CHEVRON_ICON_HTML;
    action.append(actionText, chevron);
    toggle.append(icon, text, action);
    box.appendChild(toggle);

    const list = document.createElement('div');
    list.className = 'chat-history-orphans-list';
    list.id = regionId;
    /** @type {Map<string, any[]>} */
    const byRoot = new Map();
    for (const chat of orphaned) {
      const root = chat.workspaceRoot || '';
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(chat);
    }
    for (const [root, chats] of byRoot) {
      chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      list.appendChild(buildOrphanGroup(root, chats));
    }
    box.appendChild(list);

    const draw = () => {
      toggle.setAttribute('aria-expanded', orphansOpen ? 'true' : 'false');
      list.hidden = !orphansOpen;
      actionText.textContent = t(orphansOpen ? 'history.orphans.hide' : 'history.orphans.review');
    };
    draw();
    toggle.addEventListener('click', () => {
      orphansOpen = !orphansOpen;
      draw();
    });
    return box;
  }

  function buildOrphanGroup(root, chats) {
    const group = document.createElement('div');
    group.className = 'chat-history-orphans-group';
    group.setAttribute('role', 'group');
    const name = folderName(root);
    group.setAttribute('aria-label', t('history.orphans.group', { folder: root }));
    const head = document.createElement('div');
    head.className = 'chat-history-orphans-path';
    const label = document.createElement('span');
    label.className = 'chat-history-orphans-folder';
    label.textContent = name;
    // The whole path on hover; the name alone fits the column.
    label.title = root;
    const count = document.createElement('span');
    count.className = 'chat-history-orphans-count';
    count.textContent = String(chats.length);
    count.setAttribute('aria-hidden', 'true');
    head.append(label, count);
    if (chats.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'chat-history-orphans-assign-all';
      all.textContent = t('history.orphans.assignAll');
      all.setAttribute('aria-label', tPlural('history.orphans.assignAll.label', chats.length, { count: chats.length, folder: name }));
      all.addEventListener('click', () => assignAll(root, all));
      head.appendChild(all);
    }
    group.appendChild(head);
    for (const chat of chats) group.appendChild(buildOrphanRow(chat));
    return group;
  }

  function buildOrphanRow(chat) {
    const row = document.createElement('div');
    row.className = 'chat-history-orphan';
    row.dataset.orphanId = chat.id;
    const body = document.createElement('div');
    body.className = 'chat-history-orphan-body';
    const title = tMessage(chat.title) || t('chat.title.new');
    const titleEl = document.createElement('span');
    titleEl.className = 'chat-history-row-title';
    titleEl.textContent = title;
    titleEl.title = title;
    const meta = document.createElement('span');
    meta.className = 'chat-history-row-meta';
    meta.textContent = formatHistoryTime(chat.updatedAt);
    body.append(titleEl, meta);
    const assign = document.createElement('button');
    assign.type = 'button';
    assign.className = 'chat-history-orphan-assign';
    assign.textContent = t('history.orphans.assign');
    assign.title = t('history.orphans.assign.hint');
    assign.setAttribute('aria-label', t('history.orphans.assign.label', { title }));
    assign.addEventListener('click', () => assignOne(chat.id, title, assign));
    row.append(body, assign);
    return row;
  }

  /** After an assignment the focus stays in the note, or goes to the list once the note is gone. */
  function focusAfterAssign() {
    const next = chatHistoryList.querySelector('.chat-history-orphans-assign-all, .chat-history-orphan-assign')
      || chatHistoryList.querySelector('.chat-history-row-main');
    if (next) {
      next.focus();
      return;
    }
    chatHistoryEmpty.tabIndex = -1;
    chatHistoryEmpty.focus();
  }

  /**
   * Busy rather than disabled while main answers: a disabled button would
   * drop the focus. `undefined` while one is under way, `null` when it failed.
   */
  async function whileBusy(button, run) {
    if (button.getAttribute('aria-busy') === 'true') return undefined;
    button.setAttribute('aria-busy', 'true');
    try {
      return await run();
    } catch {
      // Not quiet: `null` makes the caller say in the status line that it failed.
      return null;
    } finally {
      button.removeAttribute('aria-busy');
    }
  }

  async function assignOne(id, title, button) {
    const result = await whileBusy(button, () => api.assignChatToFolder(id));
    if (result === undefined) return;
    if (!result?.ok) {
      announce(t('history.orphans.failed'));
      return;
    }
    await renderHistoryList();
    announce(t('history.orphans.assigned', { title }));
    focusAfterAssign();
  }

  async function assignAll(root, button) {
    const result = await whileBusy(button, () => api.assignFolderChatsToFolder(root));
    if (result === undefined) return;
    if (!result?.ok) {
      announce(t('history.orphans.failed'));
      return;
    }
    await renderHistoryList();
    announce(tPlural('history.orphans.assignedAll', result.count, { count: result.count }));
    focusAfterAssign();
  }

  /**
   * *Keep* (#1320): a bookmark next to the bin. It shows on hover and focus,
   * and stays once the chat is kept. Its name stays the same; `aria-pressed`
   * says whether it is on.
   */
  function buildKeepToggle(s, title) {
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'chat-history-row-keep';
    keep.setAttribute('aria-label', t('history.entry.keep'));
    keep.innerHTML = KEEP_ICON_HTML;
    const draw = () => {
      keep.setAttribute('aria-pressed', s.keep === true ? 'true' : 'false');
      keep.title = s.keep === true
        ? t('history.entry.keep.on')
        : (folderLimit ? t('history.entry.keep.off', { max: formatCount(folderLimit) }) : t('history.entry.keep'));
    };
    draw();
    keep.addEventListener('click', async () => {
      const wanted = s.keep !== true;
      const result = await whileBusy(keep, () => api.setChatKeep(s.id, wanted));
      if (result === undefined) return;
      if (!result?.ok) {
        announce(t('history.entry.keep.failed'));
        return;
      }
      s.keep = result.keep === true;
      draw();
      announce(t(s.keep ? 'history.entry.keep.done' : 'history.entry.keep.undone', { title }));
    });
    return keep;
  }

  /**
   * One row: the button that opens the chat and the bin next to it, as
   * siblings (#582). Nested inside a `role="button"`, the bin was presentational
   * for screen readers, and its Enter bubbled up and opened the chat instead.
   */
  function buildRow(s) {
    const row = document.createElement('div');
    row.className = 'chat-history-row';
    const current = s.id === appStore.currentChatId;
    if (current) row.classList.add('chat-history-row--current');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-history-row-main';
    if (current) open.setAttribute('aria-current', 'true');
    // Main sends the title to show — the chat's own, or a descriptor for one
    // without (#985): the list carries no messages to work it out from.
    const title = tMessage(s.title) || t('chat.title.new');
    const titleEl = document.createElement('span');
    titleEl.className = 'chat-history-row-title';
    titleEl.textContent = title;
    // Cut off with an ellipsis, a long title is readable on hover (#586).
    open.title = title;
    const meta = document.createElement('span');
    meta.className = 'chat-history-row-meta';
    const time = document.createElement('span');
    time.className = 'chat-history-row-time';
    time.textContent = formatHistoryTime(s.updatedAt);
    meta.appendChild(time);
    // What the chat cost so far (#949) — only once it cost anything.
    const cost = normalizeSessionCost(s.cost);
    if (cost) {
      const summary = summarizeSessionCost(cost);
      const costEl = document.createElement('span');
      costEl.className = 'chat-history-row-cost';
      costEl.textContent = formatCostAmount(summary);
      costEl.title = summary.usd === null
        ? t('cost.chip.label.unknown')
        : t(summary.complete ? 'cost.chip.label' : 'cost.chip.label.partial', { amount: costEl.textContent });
      meta.appendChild(costEl);
    }
    open.appendChild(titleEl);
    open.appendChild(meta);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-history-row-delete';
    del.title = t('history.entry.remove');
    del.setAttribute('aria-label', t('history.entry.remove'));
    del.innerHTML = BIN_ICON_HTML;
    row.appendChild(open);
    row.appendChild(buildKeepToggle(s, title));
    row.appendChild(del);
    row.dataset.chatId = s.id;
    applyRunState(row, runs.stateOf(s.id));

    // The padding around the button opens the chat as well; the bookmark, the
    // bin and the confirmation are excluded.
    row.addEventListener('click', (e) => {
      if (e.target.closest('.chat-history-row-keep, .chat-history-row-delete, .chat-history-row-confirm')) return;
      void openChatSession(s.id);
    });
    del.addEventListener('click', () => askToRemove(row, s.id));
    return row;
  }

  /**
   * The bin asks first (#582): one click used to delete the chat and its
   * attachments for good. The question takes the row's place; Cancel sits
   * where the bin was, so a double click on the bin cancels instead of
   * deleting, and Cancel also has the focus for the same reason.
   */
  function askToRemove(row, id) {
    cancelPendingRemoval();
    row.classList.add('chat-history-row--confirm');
    const box = document.createElement('div');
    box.className = 'chat-history-row-confirm';
    box.setAttribute('role', 'group');
    const promptId = `chat-history-confirm-${id}`;
    box.setAttribute('aria-labelledby', promptId);
    const prompt = document.createElement('span');
    prompt.className = 'chat-history-row-confirm-text';
    prompt.id = promptId;
    prompt.textContent = t('history.entry.remove.confirm');
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'chat-history-row-confirm-delete btn-destructive';
    yes.textContent = t('history.entry.remove.yes');
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'chat-history-row-confirm-cancel btn-secondary';
    no.textContent = t('history.entry.remove.no');
    box.append(prompt, yes, no);
    row.appendChild(box);

    const cancel = ({ focusBin = false } = {}) => {
      if (pendingRemoval?.row !== row) return;
      pendingRemoval = null;
      box.remove();
      row.classList.remove('chat-history-row--confirm');
      if (focusBin) row.querySelector('.chat-history-row-delete')?.focus();
    };
    pendingRemoval = { row, cancel };
    // Busy rather than disabled: a disabled button drops the focus, and the
    // focus is what moves on to the next row afterwards.
    let busy = false;

    no.addEventListener('click', () => {
      if (!busy) cancel({ focusBin: true });
    });
    yes.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      box.setAttribute('aria-busy', 'true');
      const result = await removeChatFromHistory(id, { restoreFocus: true });
      if (result.ok) return;
      // The chat stays where it is, and the row says why.
      busy = false;
      box.removeAttribute('aria-busy');
      prompt.textContent = t('history.entry.remove.failed');
      prompt.setAttribute('role', 'alert');
      yes.focus();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (!busy) cancel({ focusBin: true });
    });
    // A click or a Tab elsewhere is a "no".
    box.addEventListener('focusout', (e) => {
      if (busy) return;
      if (e.relatedTarget && box.contains(e.relatedTarget)) return;
      cancel();
    });
    no.focus();
  }

  function cancelPendingRemoval() {
    pendingRemoval?.cancel();
  }

  /**
   * After a delete the focus stays in the list (#582): on the row that took
   * the place of the deleted one, on the one before it if that was the last,
   * and on the empty state when nothing is left.
   */
  function focusAfterRemoval(index) {
    const rows = chatHistoryList.querySelectorAll('.chat-history-row-main');
    const target = rows[Math.min(index, rows.length - 1)];
    if (target) {
      target.focus();
      return;
    }
    chatHistoryEmpty.tabIndex = -1;
    chatHistoryEmpty.focus();
  }

  /**
   * Der Verlauf haengt am aktiven Ordner: `getChatHistory` liefert nur die
   * Chats des Workspace, den der Main-Prozess gerade fuehrt (Issue #68).
   * Beim Start steht der aber erst fest, nachdem der zuletzt benutzte Ordner
   * aktiviert wurde — eine Liste, die davor gezeichnet wird, bleibt leer und
   * fuellte sich bisher erst beim naechsten Anlass (neuer Chat, Ein- und
   * Ausblenden). Deshalb wird sie nach jedem Ordnerwechsel nachgezogen.
   * Ist die Spalte zu, genuegt das Rendern beim naechsten Einblenden.
   */
  async function refreshIfOpen() {
    if (!isHistoryOpen()) return;
    await renderHistoryList();
  }

  async function openChatSession(id) {
    if (!id || id === appStore.currentChatId) return;
    // A send while the history is read waits for this chat (#721).
    const release = runs.holdSwitch();
    try {
      await showChatSession(id);
    } finally {
      release();
    }
  }

  async function showChatSession(id) {
    // Erst die Spalte, dann der Inhalt: Sonst liefe das Rendern in eine
    // weggeschaltete Flaeche und die Eingabezeile kaeme ohne Hoehe zurueck.
    revealChatPanel();
    stopChatVoiceListening();
    appStore.chatSessionId += 1;
    // A chat whose run is still in memory opens from there (#320): the file
    // only knows the state from when the run left the screen. Any other one
    // brings its messages now; the list has none (#985).
    let s = null;
    if (!runs.canAttach(id)) {
      s = (await api.getChatSession(id))?.session;
      if (!s || !Array.isArray(s.messages)) {
        // Gone, or its file could not be read and was put aside — the list
        // shows what is left, and a notice says what happened.
        await renderHistoryList();
        return;
      }
    }
    // The chat on screen takes its run into the background.
    runs.detach();
    if (!runs.attach(id)) {
      appStore.currentChatId = id;
      appStore.currentChatWorkspace = s.workspaceRoot || null;
      appStore.chatMessages = s.messages;
      appStore.currentChatTitle = s.title || '';
      appStore.currentChatTaskKind = s.taskKind || null;
      setChatTokenUsage?.(s.tokenUsage, { cost: s.cost });
    }
    onInputChanged();
    // The composer follows the chat on screen at once, not after the round
    // trips below (#411) — and so does the list: from here on this chat's
    // run counts as on screen, and its events would otherwise be drawn into
    // the previous chat's list (#593).
    runs.syncComposer();
    renderChatMessages();
    await api.setActiveChatId(id);
    // Ausdruecklicher Wechsel: Dieser Chat bekommt sein Modell und seinen
    // Freigabemodus zurueck — auch „Auto“, das er nur nach einer nativen
    // Bestaetigung tragen kann (Issue #211).
    await activateChatSession(id, CHAT_ACTIVATION.EXPLICIT);
    runs.afterSwitch();
    updateChatChrome();
    await renderHistoryList();
  }

  /**
   * `restoreFocus`: the delete came from the row, so the focus moves on to a
   * neighbour once the list is redrawn.
   * @returns {Promise<{ ok: boolean }>} `ok: false` when main did not delete
   *   it (#582) — the chat then stays on screen and in the list.
   */
  async function removeChatFromHistory(id, { restoreFocus = false } = {}) {
    const rows = [...chatHistoryList.querySelectorAll('.chat-history-row[data-chat-id]')];
    const index = rows.findIndex((row) => row.dataset.chatId === id);
    // First the run: it must not write the chat back once it is gone (#320).
    // A delete that fails afterwards has stopped it all the same.
    runs.discard(id);
    let result;
    try {
      result = await api.deleteChatSession(id);
    } catch {
      result = null;
    }
    if (!result?.ok) {
      runs.afterSwitch();
      return { ok: false };
    }
    if (id === appStore.currentChatId) {
      stopChatVoiceListening();
      appStore.chatSessionId += 1;
      appStore.currentChatId = crypto.randomUUID();
      appStore.currentChatWorkspace = appStore.rootPath || null;
      appStore.chatMessages = [];
      appStore.currentChatTitle = '';
      appStore.currentChatTaskKind = null;
      seedGreetingIfWorkspace?.(appStore.currentChatWorkspace);
      resetChatTokenUsage?.();
      onInputChanged();
      await api.setActiveChatId(null);
      // Der Ersatz ist ein neuer Chat: Standard-Modell, Modus „Intelligent“.
      await activateChatSession(appStore.currentChatId, CHAT_ACTIVATION.EXPLICIT);
      renderChatMessages();
      updateChatChrome();
    }
    runs.afterSwitch();
    await renderHistoryList();
    if (restoreFocus) focusAfterRemoval(Math.max(0, index));
    return { ok: true };
  }

  /**
   * Marks a row as running or waiting for an approval (#320). The state goes
   * into the meta line in place of the time — shape, colour and words
   * together, so it is never carried by colour alone.
   */
  function applyRunState(row, state) {
    const meta = row.querySelector('.chat-history-row-meta');
    if (!meta) return;
    const label = RUN_STATE_LABELS[state] ? t(RUN_STATE_LABELS[state]) : '';
    const shown = meta.querySelector('.chat-history-row-run');
    // Unchanged: leave the node alone, so the pulse does not restart.
    if ((row.dataset.runState || '') === (label ? state : '') && (shown?.textContent || '') === label) return;
    shown?.remove();
    if (!label) {
      delete row.dataset.runState;
      return;
    }
    row.dataset.runState = state;
    const run = document.createElement('span');
    run.className = 'chat-history-row-run';
    const dot = document.createElement('span');
    dot.className = 'chat-history-row-run-dot';
    dot.setAttribute('aria-hidden', 'true');
    run.appendChild(dot);
    run.append(label);
    meta.prepend(run);
  }

  /** Re-reads the run state of every row without fetching the history again. */
  function syncRunMarkers() {
    for (const row of chatHistoryList.querySelectorAll('.chat-history-row[data-chat-id]')) {
      applyRunState(row, runs.stateOf(row.dataset.chatId));
    }
  }

  async function startNewChatWithHistory() {
    await onNewChatStarted();
    await renderHistoryList();
  }

  btnChatHistory?.addEventListener('click', async () => {
    const open = !isHistoryOpen();
    if (open) await renderHistoryList();
    setHistoryOpen(open);
  });

  // Language change (epic #277): the button text depends on state and the rows
  // are built here — `applyTranslations` reaches neither.
  onLocaleChange(() => {
    setHistoryOpen(isHistoryOpen(), { persist: false });
    void refreshIfOpen();
  });

  return {
    isHistoryOpen,
    setHistoryOpen,
    renderHistoryList,
    refreshIfOpen,
    openChatSession,
    removeChatFromHistory,
    startNewChatWithHistory,
    syncRunMarkers,
  };
}
