import { t, tPlural, onLocaleChange } from '../i18n.js';
import {
  formatCount,
  svgAt,
  svgChevron,
  svgFolder,
  svgFile,
  dismissOnFocusLeave,
  dismissOnOutsideClick,
} from '../utils/helpers.js';
import { basenameOf, parentDirOf, joinNative, isInsideDir } from '../utils/nativePath.js';
import { createAgentMarks, markPathFor } from '../tree/agentMarks.js';
import { createFileChangeIndex } from '../chat/fileChanges.js';
import {
  TREE_DRAG_MIME,
  encodeTreeDragPayload,
  workspaceReferenceFor,
} from '../chat/workspaceReference.js';
// Pfad- und Baumlogik des Dateibaums, DOM-frei und einzeln getestet (#81).
import {
  foldersToCheck,
  foldersToReexpand,
  importDestDirFor,
  isExternalFileDrop,
  isHiddenTreePath,
  listingSignature,
  listingsDiffer,
  parentDirFromItemPath,
  sortFoldersTopDown,
  treeDepthFromIndentWidth,
} from '../tree/treePaths.js';
import { createFileViewHost } from '../file-views/host.js';
import { createWorkspacePathSource } from '../tree/workspacePaths.js';
import { initTreeFilter } from './TreeFilter.js';
import { initTreeActionsMenu } from './TreeActionsMenu.js';
import { initWorkspaceHeader } from './WorkspaceHeader.js';
import { pickFolderReadme } from '../utils/startupLayout.js';
import contracts from '../generated/contracts.js';

// What a quick start chip writes into the chat is the user's own message, so it
// reads in the language of the interface (#310).
const QUICK_ACTION_PROMPT_KEYS = {
  analyse: 'welcome.prompt.analyse',
  review: 'welcome.prompt.review',
  test: 'welcome.prompt.test',
  doc: 'welcome.prompt.doc',
};

export function initFileTree(deps) {
  const {
    api,
    appStore,
    onInputChanged,
    onWorkspaceChanged,
    onProjectOpened,
    sendChatMessage,
    activeProviderConfigured,
    insertChatReference,
    revealContentPane,
    // Both only for tests; the app runs with the defaults of the host.
    fileViews,
    confirmLeave,
    agentMarks = createAgentMarks(),
    fileChanges = createFileChangeIndex(),
    // The path list of the `@` menu (#350); app.js hands in the shared one.
    workspacePaths = createWorkspacePathSource({ api, appStore }),
    // Name and path of the open folder in title bar and header (#676); app.js
    // hands in one that knows the home folder.
    workspaceHeader = initWorkspaceHeader(),
    // Marks a chat switch as under way and returns its end (#721).
    holdChatSwitch = () => () => {},
  } = deps;

  const treeContainer = document.getElementById('tree-container');
  // What the middle column shows for a file is the business of the file views
  // (#225); the tree only says which file, and when it changed or went away.
  const contentPane = createFileViewHost({
    api,
    registry: fileViews,
    confirmLeave,
    openFile: (path) => openFromPreview(path),
    getWorkspaceRoot: () => appStore.rootPath,
    // The entries behind ‹ and › (#822), as a native menu.
    showHistoryMenu: typeof api.showPreviewHistoryMenu === 'function'
      ? (request) => api.showPreviewHistoryMenu(request)
      : null,
    // What the conversation on screen changed in a file (#348).
    changesFor: (path) => fileChanges.changesFor(appStore.currentChatId, path).map((change) => change.id),
  });
  // The switcher (#676): the folder's name, and the recent folders behind it.
  const btnWorkspace = document.getElementById('btn-workspace');
  const btnClearMarks = document.getElementById('btn-tree-clear-marks');
  const folderHistoryMenu = document.getElementById('folder-history-menu');
  const welcomeRecentSection = document.getElementById('welcome-recent');
  const welcomeRecentList = document.getElementById('welcome-recent-list');
  const welcomeActionsList = document.getElementById('welcome-actions-list');
  const chatInput = document.getElementById('chat-input');


  // Meldungen des Dateisystem-Watchers laufen nacheinander ab (Issue #158).
  // Since #636 so does everything else that rebuilds rows — an agent's write,
  // a delete, a move, an import, a folder's first load, a folder switch: two
  // rebuilds that both clear a container before either has appended would
  // both append. A job already running in the queue calls the drawing
  // functions directly; queueing and awaiting itself from in there would wait
  // for itself forever.
  let treeSyncChain = Promise.resolve();

  // Which folder the tree belongs to (#633). It counts up whenever main
  // switches folders, and a folder switch whose number is no longer the
  // latest has been overtaken. A listing for the folder before is not waited
  // for once it changes — a share that does not answer must not hold up the
  // queue, and with it the new folder — and what it brings is not drawn
  // (`listFolder`, `loadTreeLevel`, `folderListingChanged`, `restoreTreeView`).
  let treeGeneration = 0;
  let leaveGeneration = () => {};
  let generationLeft = new Promise((resolve) => { leaveGeneration = resolve; });

  function startTreeGeneration() {
    treeGeneration += 1;
    // The marks name paths of the folder left (#347), and so do the changes
    // the tree knows of (#348); the chat keeps its own.
    agentMarks.clearAll();
    fileChanges.clearAll();
    leaveGeneration();
    generationLeft = new Promise((resolve) => { leaveGeneration = resolve; });
  }

  /** Queues a rebuild; resolves with its result, or undefined if it failed. */
  function enqueueTreeWork(work, failure) {
    treeSyncChain = treeSyncChain
      .then(work)
      .catch((err) => console.warn(`${failure}:`, err?.message ?? err));
    return treeSyncChain;
  }

  // Main's side of a folder switch, one step at a time (#633): activating a
  // folder and announcing it to the chat never overlap. The chat reads main's
  // history for the folder it is told about, so main must not change folders
  // meanwhile — and no older call may announce a folder main has already
  // left. `reportedRoot` is the folder last announced.
  let switchSteps = Promise.resolve();
  let reportedRoot = null;

  function inSwitchOrder(step) {
    const run = switchSteps.then(step);
    switchSteps = run.catch(() => {});
    return run;
  }

  // First loads of folders while they run, by path (#636): a second click on
  // a folder that is still loading waits for that load instead of starting
  // another one, which would draw every child twice.
  const folderLoads = new Map();

  // How long a listing may take before its folder shows that it is loading
  // (#639). A quicker one would only make the state flicker.
  const LOADING_STATE_DELAY_MS = 150;

  // Drag-&-Drop-State lebt komplett in diesem Component; resetDragState()
  // ist der einzige Aufräumpfad, damit keine Row-Referenzen hängenbleiben.
  let dragSourcePath = null;
  let dragSourceRow = null;
  let currentDropTarget = null;
  // Laeuft gerade ein Import von aussen? Verhindert einen zweiten Drop,
  // waehrend noch kopiert wird (#101).
  let importInFlight = false;

  // Hidden files (#436). Whether the tree on screen was drawn with them, and
  // which hidden folders were open when they went away — they open again when
  // hidden files come back, so switching twice leaves the tree as it was.
  let drawnShowHidden = false;
  let expandedHiddenFolders = [];

  // The filter (#350) searches main's path list and opens through the same
  // door as a link from the preview: the tree unfolds to what was opened.
  const filter = initTreeFilter({
    appStore,
    paths: workspacePaths,
    openEntry: (entry) => openFromPreview(joinNative(appStore.rootPath, entry.path)),
    isHidden: (relPath) => isHiddenTreePath(joinNative(appStore.rootPath, relPath), appStore.rootPath),
    treeFocusTarget: () => syncTabStop(),
    fallbackFocus: () => document.getElementById('btn-tree-actions'),
  });

  function resetDragState() {
    clearDragVisualState();
    dragSourcePath = null;
    dragSourceRow = null;
  }

  /**
   * The path line under a folder name, in the welcome chips and the history
   * menu. The box is `direction: rtl` so the ellipsis cuts the start of a
   * long path, not the folder at its end; the path itself is isolated as
   * left-to-right, otherwise the bidi algorithm moves a leading `/` or `\\`
   * to the far end (#638).
   */
  function folderPathLine(className, folderPath, id) {
    const line = document.createElement('span');
    line.className = className;
    line.id = id;
    const text = document.createElement('bdi');
    text.dir = 'ltr';
    text.textContent = folderPath;
    line.appendChild(text);
    return line;
  }

  function renderWelcomeRecent(paths) {
    if (!welcomeRecentSection || !welcomeRecentList) return;
    welcomeRecentList.innerHTML = '';
    if (!paths || paths.length === 0) {
      welcomeRecentSection.classList.add('hidden');
      return;
    }
    // Top 4 reichen visuell — fuer mehr ist das Folder-History-Menu da.
    const top = paths.slice(0, 4);
    top.forEach((p, index) => {
      // The list item holds the button (#638): `role="listitem"` on the
      // button itself replaced its role, and Chromium announced a focusable
      // list item without a name.
      const item = document.createElement('div');
      item.className = 'chip-recent-item';
      item.setAttribute('role', 'listitem');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip chip--recent';
      btn.title = p;

      const main = document.createElement('span');
      main.className = 'chip-recent-main';

      const name = document.createElement('span');
      name.className = 'chip-recent-name';
      name.id = `welcome-recent-${index}-name`;
      name.textContent = basenameOf(p);

      const sub = folderPathLine('chip-recent-path', p, `welcome-recent-${index}-path`);
      // Name and path as two words: from the content, Chromium runs them
      // together ("snotra/Users/…").
      btn.setAttribute('aria-labelledby', `${name.id} ${sub.id}`);

      main.appendChild(name);
      main.appendChild(sub);
      btn.appendChild(main);

      const arrow = document.createElement('span');
      arrow.className = 'chip-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '\u2192';
      btn.appendChild(arrow);

      btn.addEventListener('click', () => {
        if (p !== appStore.rootPath) openProject(p);
      });
      item.appendChild(btn);
      welcomeRecentList.appendChild(item);
    });
    welcomeRecentSection.classList.remove('hidden');
  }

  async function refreshWelcomeRecent() {
    if (!welcomeRecentSection) return;
    try {
      const { paths } = await api.getFolderHistory();
      renderWelcomeRecent(Array.isArray(paths) ? paths : []);
    } catch {
      renderWelcomeRecent([]);
    }
  }

  if (welcomeActionsList) {
    welcomeActionsList.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip[data-action]');
      if (!chip) return;
      const action = chip.dataset.action;
      const promptKey = QUICK_ACTION_PROMPT_KEYS[action];
      if (!promptKey) return;
      const prompt = t(promptKey);
      chatInput.value = prompt;
      onInputChanged?.();
      chatInput.focus();
      if (appStore.rootPath && activeProviderConfigured()) {
        sendChatMessage();
      }
    });
  }

  /**
   * Aktiviert den Ordner zuerst im Main-Prozess und zeichnet erst danach die
   * Oberflaeche (Issue #68). Lehnt der Main ab — Ordner geloescht, Pfad nicht
   * im Verlauf —, bleibt der bisherige Workspace stehen.
   *
   * Only the call whose folder main switched to last draws and reports
   * (#633). One that a newer call overtook stops after its next await,
   * without touching the tree or the chat, and resolves to `true`: a folder
   * is being opened — by the newer call, which answers for it — so a caller
   * must not fall back to "no folder" underneath it.
   */
  async function openProject(folderPath) {
    // Unsaved changes in an editor are settled before main switches folders;
    // afterwards the file they belong to is out of reach.
    if (!(await contentPane.settleUnsaved('switch-folder'))) return false;
    // The number is taken in the same step as the activation, so it follows
    // the order in which main switched. A refused folder takes none and
    // overtakes nothing: main keeps what it had, and so does a switch to it
    // still being drawn.
    const ticket = await inSwitchOrder(async () => {
      const activated = await api.activateFolder(folderPath);
      if (!activated?.ok) return null;
      startTreeGeneration();
      return treeGeneration;
    });
    if (ticket === null) {
      await refreshFolderHistory();
      await refreshWelcomeRecent();
      return false;
    }
    // From here the tree shows the new folder while the chat on screen is
    // still the old folder's, until onWorkspaceChanged has brought this
    // folder's chat up. A send meanwhile waits for that chat (#721).
    const releaseChat = holdChatSwitch();
    try {
      return await showActivatedProject(folderPath, ticket);
    } finally {
      releaseChat();
    }
  }

  async function showActivatedProject(folderPath, ticket) {
    const overtaken = () => ticket !== treeGeneration;
    if (overtaken()) return true;
    appStore.rootPath = folderPath;
    // A query belongs to the folder it was typed in.
    filter.close({ restoreFocus: false });
    filter.setAvailable(true);
    workspaceHeader.setWorkspace(folderPath);
    // Something to filter and create in now (#349, #350).
    actionsMenu.setAvailable(true);

    // A selection belongs to the folder it was made in: left standing, the
    // next question would tell the model about a file of the folder just
    // left (#633).
    clearSelection();
    contentPane.clear();
    // And so does the way back through its files (#822).
    contentPane.resetHistory();
    // The folder left goes at once, not when the queue gets round to it: its
    // rows would stay clickable under the new name meanwhile.
    treeContainer.innerHTML = '';
    treeContainer.removeAttribute('aria-busy');
    describeLevel(treeContainer, null);

    // In the queue (#636), so nothing still running for this folder can
    // append its rows twice; a job for the folder before has been let go.
    await enqueueTreeWork(async () => {
      if (overtaken()) return;
      treeContainer.innerHTML = '';
      drawnShowHidden = appStore.showHiddenFiles === true;
      expandedHiddenFolders = [];
      await withTreeLoadingState(loadTreeLevel(treeContainer, folderPath, 0), ticket);
    }, 'Folder could not be drawn');
    if (overtaken()) return true;
    // Announced in switch order: a newer activation still running is waited
    // for, and then this call may be the one overtaken.
    const announced = await inSwitchOrder(async () => {
      if (overtaken()) return false;
      if (reportedRoot !== folderPath) {
        reportedRoot = folderPath;
        await onWorkspaceChanged?.(folderPath, true);
      }
      onProjectOpened?.();
      return true;
    });
    if (!announced) return true;
    refreshFolderHistory();
    refreshWelcomeRecent();
    return true;
  }

  async function refreshFolderHistory() {
    try {
      const { paths } = await api.getFolderHistory();
      renderFolderHistory(Array.isArray(paths) ? paths : []);
    } catch {
      renderFolderHistory([]);
    }
  }

  // The folder history is a menu with the keyboard model of #583: the focus
  // goes into it on open, the arrows move it, Escape hands it back to the
  // button, and Tab past it closes it (#638). One entry at a time is in the
  // Tab order; its remove button is reached with Delete, not with Tab.

  /** True while the menu is rebuilt: the focused entry goes away for a moment. */
  let folderHistoryRebuilding = false;

  function folderHistoryItems() {
    return [...folderHistoryMenu.querySelectorAll('[role="menuitem"]')];
  }

  /** Makes `item` the one entry the Tab key stops at (a roving tabindex). */
  function setCurrentFolderHistoryItem(item) {
    for (const el of folderHistoryItems()) el.tabIndex = el === item ? 0 : -1;
  }

  /**
   * A redraw of the open menu — a language switch, a removed entry — keeps
   * the focus on the entry it was on (#638).
   */
  function renderFolderHistory(paths) {
    const focused = folderHistoryMenu.contains(document.activeElement)
      ? document.activeElement.closest('[role="menuitem"]')
      : null;
    const focusedKey = focused?.dataset.path ?? focused?.dataset.action ?? null;
    folderHistoryRebuilding = true;
    try {
      fillFolderHistory(paths);
    } finally {
      folderHistoryRebuilding = false;
    }
    const items = folderHistoryItems();
    const restored = focused
      ? items.find((el) => (el.dataset.path ?? el.dataset.action) === focusedKey)
      : null;
    setCurrentFolderHistoryItem(restored || items[0]);
    restored?.focus();
  }

  function fillFolderHistory(paths) {
    folderHistoryMenu.innerHTML = '';
    // Seen, not read out: the menu is named by its button.
    const heading = document.createElement('div');
    heading.className = 'folder-history-heading';
    heading.setAttribute('aria-hidden', 'true');
    heading.textContent = t('sidebar.recentFolders');
    folderHistoryMenu.appendChild(heading);
    fillFolderHistoryEntries(paths);
    folderHistoryMenu.appendChild(openFolderEntry());
  }

  /**
   * "Open folder…" at the foot of the menu (#676): until then a button of its
   * own next to the history.
   */
  function openFolderEntry() {
    const fragment = document.createDocumentFragment();
    const separator = document.createElement('div');
    separator.className = 'folder-history-separator';
    separator.setAttribute('role', 'separator');
    fragment.appendChild(separator);
    const entry = document.createElement('div');
    entry.className = 'folder-history-item folder-history-action';
    entry.setAttribute('role', 'menuitem');
    entry.tabIndex = -1;
    entry.dataset.action = 'open-folder';
    entry.textContent = t('sidebar.openFolder');
    const run = async () => {
      closeFolderHistoryMenu({ focusButton: true });
      const folderPath = await api.openFolder?.();
      if (folderPath) await openProject(folderPath);
    };
    entry.addEventListener('click', () => void run());
    entry.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      void run();
    });
    fragment.appendChild(entry);
    return fragment;
  }

  function fillFolderHistoryEntries(paths) {
    if (!paths.length) {
      // An entry that cannot be chosen, not a bare text: a menu holds menu
      // items only, and the focus has somewhere to go when it opens (#638).
      const empty = document.createElement('div');
      empty.className = 'folder-history-empty';
      empty.setAttribute('role', 'menuitem');
      empty.setAttribute('aria-disabled', 'true');
      empty.textContent = t('sidebar.history.empty');
      folderHistoryMenu.appendChild(empty);
      return;
    }
    paths.forEach((p, index) => {
      const displayName = basenameOf(p);

      // Kein <button> mehr: Der Entfernen-Button (Issue #57) läge sonst in
      // einem Button verschachtelt (ungültiges HTML). Stattdessen eine Zeile
      // mit role=menuitem und Tastatur-Handling wie im ChatHistoryPanel.
      const row = document.createElement('div');
      row.className = 'folder-history-item';
      row.setAttribute('role', 'menuitem');
      row.tabIndex = -1;
      row.title = p;
      row.dataset.path = p;

      const main = document.createElement('span');
      main.className = 'folder-history-item-main';

      const name = document.createElement('span');
      name.className = 'folder-history-name';
      name.id = `folder-history-${index}-name`;
      name.textContent = displayName;

      const sub = folderPathLine('folder-history-path', p, `folder-history-${index}-path`);

      // Named by folder and path alone: from the content, the label of the
      // remove button ran into it (#638). Delete is announced as a hint.
      row.setAttribute('aria-labelledby', `${name.id} ${sub.id}`);
      row.setAttribute('aria-describedby', 'folder-history-hint');

      main.appendChild(name);
      main.appendChild(sub);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'folder-history-item-remove';
      // For the pointer; the keyboard has Delete on the entry (#638).
      remove.tabIndex = -1;
      remove.title = t('sidebar.history.remove');
      remove.setAttribute('aria-label', t('sidebar.history.remove.label', { name: displayName }));
      remove.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

      row.appendChild(main);
      row.appendChild(remove);

      const openThis = () => {
        // The entry goes away with the menu; the focus goes back to its
        // button, as after a choice in the model menu (#583, #638).
        closeFolderHistoryMenu({ focusButton: true });
        if (p !== appStore.rootPath) openProject(p);
      };
      row.addEventListener('click', (e) => {
        if (e.target.closest('.folder-history-item-remove')) return;
        openThis();
      });
      row.addEventListener('keydown', (e) => {
        if (e.target !== row) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openThis();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          removeFolderFromHistory(p, row);
        }
      });
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFolderFromHistory(p, row);
      });
      folderHistoryMenu.appendChild(row);
    });
  }

  /**
   * Entfernt einen Eintrag aus „Zuletzt geöffnete Ordner“ (Issue #57), ohne
   * den Ordner zu öffnen. Das Menü bleibt offen, damit man mehrere Einträge
   * nacheinander wegräumen kann; der Fokus wandert auf den Nachbareintrag.
   */
  async function removeFolderFromHistory(folderPath, row) {
    const isEntry = (el) => Boolean(el?.dataset?.path);
    const neighbour = [row?.nextElementSibling, row?.previousElementSibling].find(isEntry) || null;
    const neighbourPath = neighbour?.dataset.path || null;

    let paths = null;
    try {
      const res = await api.removeFolderFromHistory(folderPath);
      if (Array.isArray(res?.paths)) paths = res.paths;
    } catch {
      /* Fallback: unten komplett neu laden */
    }
    if (paths) {
      renderFolderHistory(paths);
      renderWelcomeRecent(paths);
    } else {
      await refreshFolderHistory();
      refreshWelcomeRecent();
    }

    // Nach dem Re-Render existieren die alten Knoten nicht mehr — den
    // Nachbarn über seinen Pfad wiederfinden, sonst ersten Eintrag bzw. Button.
    // With the last one gone, the first entry is the "nothing here" one (#638).
    const items = folderHistoryItems();
    const target = items.find((el) => el.dataset.path === neighbourPath) || items[0] || btnWorkspace;
    target.focus();
  }

  function openFolderHistoryMenu() {
    folderHistoryMenu.classList.remove('hidden');
    folderHistoryMenu.setAttribute('aria-hidden', 'false');
    btnWorkspace.setAttribute('aria-expanded', 'true');
    // Into the menu, on its first entry (#638).
    folderHistoryItems()[0]?.focus();
  }

  /**
   * `focusButton`: back to the button after Escape or a choice (#638), where
   * the focus would otherwise drop to the page with the hidden entry. A click
   * elsewhere or Tab past the menu leaves the focus where it went.
   */
  function closeFolderHistoryMenu({ focusButton = false } = {}) {
    folderHistoryMenu.classList.add('hidden');
    folderHistoryMenu.setAttribute('aria-hidden', 'true');
    btnWorkspace.setAttribute('aria-expanded', 'false');
    if (focusButton) btnWorkspace.focus();
  }

  btnWorkspace.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isOpen = btnWorkspace.getAttribute('aria-expanded') === 'true';
    if (isOpen) {
      closeFolderHistoryMenu();
      return;
    }
    await refreshFolderHistory();
    openFolderHistoryMenu();
  });

  // The entry the focus is on is the one Tab comes back to (#638).
  folderHistoryMenu.addEventListener('focusin', (e) => {
    const item = e.target.closest('[role="menuitem"]');
    if (item) setCurrentFolderHistoryItem(item);
  });

  // The keyboard model of a menu, the same as the model menu's (#583, #638).
  folderHistoryMenu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFolderHistoryMenu({ focusButton: true });
      return;
    }
    const items = folderHistoryItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement?.closest('[role="menuitem"]'));
    let next = null;
    if (e.key === 'ArrowDown') next = items[(index + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[index <= 0 ? items.length - 1 : index - 1];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    if (!next) return;
    e.preventDefault();
    next.focus();
  });

  dismissOnOutsideClick({
    isOpen: () => !folderHistoryMenu.classList.contains('hidden'),
    ownsTarget: (t) => folderHistoryMenu.contains(t) || btnWorkspace.contains(t),
    onDismiss: closeFolderHistoryMenu,
  });

  // Tabbing out closes the menu; it does not stay open behind the focus (#638).
  dismissOnFocusLeave({
    container: document.getElementById('folder-history-wrapper'),
    isOpen: () => !folderHistoryMenu.classList.contains('hidden'),
    isPaused: () => folderHistoryRebuilding,
    onDismiss: () => closeFolderHistoryMenu(),
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Frueher schloss Escape hier auch den Chat-Verlauf. Seit Epic #223
    // (Phase B) ist der eine Spalte und kein Ausklapper — eine Spalte raeumt
    // man nicht mit Escape weg, sonst verschwindet sie unter der Hand.
    if (!folderHistoryMenu.classList.contains('hidden')) {
      closeFolderHistoryMenu();
    }
  });

  // Dateien und Ordner bringen ihr eigenes Kontextmenü mit (#58, #120); auf der
  // leeren Fläche daneben bleibt nur das native Browser-Menü zu unterdrücken.
  treeContainer.addEventListener('contextmenu', (e) => e.preventDefault());

  treeContainer.addEventListener('dragover', (e) => {
    if (!appStore.rootPath) return;
    const overItem = e.target.closest('.tree-item');
    if (overItem && overItem.dataset.isDirectory === 'true') return;
    if (isExternalFileDrop(e.dataTransfer?.types, Boolean(dragSourcePath))) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      treeContainer.classList.add('drop-target-root--import');
      return;
    }
    if (!dragSourcePath) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    treeContainer.classList.add('drop-target-root');
  });

  treeContainer.addEventListener('dragleave', (e) => {
    if (!treeContainer.contains(e.relatedTarget)) {
      treeContainer.classList.remove('drop-target-root');
      treeContainer.classList.remove('drop-target-root--import');
    }
  });

  treeContainer.addEventListener('drop', async (e) => {
    if (!appStore.rootPath) return;
    const overItem = e.target.closest('.tree-item');
    if (overItem && overItem.dataset.isDirectory === 'true') return;
    if (isExternalFileDrop(e.dataTransfer?.types, Boolean(dragSourcePath))) {
      e.preventDefault();
      // Die Pfade muessen **vor** dem ersten await aus dem DataTransfer
      // geholt werden — danach ist es leer (#101).
      const sources = droppedFilesFrom(e.dataTransfer);
      clearDragVisualState();
      await importExternalItems(sources, importDestDirFor(overItem?.dataset, appStore.rootPath));
      return;
    }
    clearDragVisualState();
    if (!dragSourcePath) return;
    e.preventDefault();
    const sourcePath = dragSourcePath;
    if (!sourcePath) return;
    const result = await api.moveItem(sourcePath, appStore.rootPath);
    if (result.error) {
      console.error('Move failed:', result.error);
      clearDragVisualState();
      return;
    }
    // In the queue and through the redraw that keeps selection, focus and
    // scroll (#636).
    await enqueueTreeWork(() => redrawFolders([appStore.rootPath]), 'Tree could not be redrawn after a move');
    clearDragVisualState();
  });

  /**
   * Where a name starts in a row of the given depth (#639): the indent, the
   * arrow's slot — which a file row keeps, empty —, the icon and its gap. The
   * notes under a folder line up with the names by it.
   */
  function treeNameOffset(depth) {
    return depth * 16 + 4 + 16 + 16 + 4;
  }

  async function loadTreeLevel(parentEl, dirPath, depth) {
    const generation = treeGeneration;
    const { entries: items = [], hidden = 0, unreadable } = (await listFolder(dirPath)) || {};
    // The folder changed while this listed (#633): the rows belong to the one left.
    if (generation !== treeGeneration) return;
    if (unreadable) {
      const note = buildUnreadableNote(unreadable, depth);
      parentEl.appendChild(note);
      describeLevel(parentEl, note);
      syncTabStop();
      return;
    }

    for (const item of items) {
      const row = document.createElement('div');
      row.classList.add('tree-item');
      // Dimmed (#436): a dot entry, or anything below a dot folder.
      if (isHiddenTreePath(item.path, appStore.rootPath)) row.classList.add('tree-item--hidden');
      row.dataset.path = item.path;
      row.dataset.isDirectory = item.isDirectory;
      row.setAttribute('draggable', 'true');
      // Deep in the tree or in a narrow sidebar the name is cut off, down to
      // nothing; the tooltip still reads it in full (#641).
      row.title = item.name;
      // A WAI-ARIA tree (#74). One row at a time is the tab stop (roving
      // tabindex, `syncTabStop`); the name is set, not read from the content,
      // which would add the @ button's label and the mark to it.
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      row.setAttribute('aria-label', item.name);
      row.setAttribute('aria-selected', 'false');
      if (item.isDirectory) row.setAttribute('aria-expanded', 'false');
      row.tabIndex = -1;

      const indent = document.createElement('span');
      indent.classList.add('indent');
      indent.style.width = `${depth * 16 + 4}px`;
      row.appendChild(indent);

      const arrow = document.createElement('span');
      arrow.classList.add('arrow');
      if (item.isDirectory) {
        arrow.innerHTML = svgChevron();
      } else {
        // Keeps the arrow's slot, so a file's name lines up with a folder's
        // of the same level. Not the global `hidden`: that is `display: none`
        // and took the slot with it (#639).
        arrow.classList.add('arrow--placeholder');
      }
      row.appendChild(arrow);

      const icon = document.createElement('span');
      icon.classList.add('icon');
      icon.innerHTML = item.isDirectory ? svgFolder() : svgFile(item.name);
      row.appendChild(icon);

      const label = document.createElement('span');
      label.classList.add('label');
      label.textContent = item.name;
      row.appendChild(label);

      const referenceBtn = buildReferenceButton(item);
      if (referenceBtn) row.appendChild(referenceBtn);

      row.addEventListener('dragstart', (e) => {
        dragSourcePath = item.path;
        dragSourceRow = row;
        row.classList.add('dragging');
        // „copyMove“ statt „move“: im Baum wird verschoben, in der Chat-Eingabe
        // entsteht eine Kopie als @-Referenz (#56). Den eigenen MIME-Typ liest
        // nur die Chat-Eingabe, fremde Ziele bekommen wie bisher den Pfad.
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', item.path);
        e.dataTransfer.setData(
          TREE_DRAG_MIME,
          encodeTreeDragPayload({ path: item.path, isDirectory: Boolean(item.isDirectory) })
        );
      });

      row.addEventListener('dragend', resetDragState);

      if (item.isDirectory) {
        row.addEventListener('dragover', handleDragOver);
        row.addEventListener('dragenter', handleDragEnter);
        row.addEventListener('dragleave', handleDragLeave);
        row.addEventListener('drop', (e) => handleDrop(e, item.path, row, depth));
      }

      parentEl.appendChild(row);

      if (item.isDirectory) {
        const childContainer = document.createElement('div');
        childContainer.classList.add('tree-children');
        childContainer.setAttribute('role', 'group');
        childContainer.dataset.path = item.path;
        childContainer.dataset.loaded = 'false';
        parentEl.appendChild(childContainer);

        row.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            void openFileContextMenu(item);
            return;
          }
          void toggleFolder(row, childContainer, item.path);
        });
      } else {
        row.addEventListener('click', (e) => {
          // ⌘-Klick (macOS) bzw. Ctrl-Klick (Windows/Linux) als Alternative zum Rechtsklick.
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            void openFileContextMenu(item);
            return;
          }
          selectFile(row, item);
        });
      }

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void openFileContextMenu(item);
      });
    }

    const note = hidden > 0 ? buildHiddenEntriesNote(hidden, depth) : null;
    if (note) parentEl.appendChild(note);
    describeLevel(parentEl, note);

    // A complete listing tells which marked entries are gone — deleted,
    // renamed or moved, by whoever (#347). One cut at the cap (#76) does not.
    if (hidden === 0) {
      agentMarks.pruneListing(dirPath, items.map((item) => item.path), hiddenByFilter);
    }
    applyAgentMarks(parentEl.querySelectorAll(':scope > .tree-item'));
    syncTabStop();
  }

  // ── Keyboard (#74) ────────────────────────────────────────────────────────
  // The tree is a WAI-ARIA tree with a roving tabindex: Tab enters it once, on
  // the row last focused — or the selected one, or the first —, and the arrow
  // keys move within it. The notes under a folder are no rows; the arrows
  // pass them, and a screen reader hears them as the folder's description.

  let describedSeq = 0;

  /** A fresh id for an element another one points at with aria-describedby. */
  function describedId(prefix) {
    describedSeq += 1;
    return `${prefix}-${describedSeq}`;
  }

  /**
   * The note of a level (cut-off count or unreadable folder) describes the
   * folder row above it, or the tree for the top level; `null` takes an
   * earlier one back.
   */
  function describeLevel(parentEl, note) {
    const owner = parentEl === treeContainer ? treeContainer : parentEl.previousElementSibling;
    if (!owner) return;
    if (note) {
      note.id = describedId('tree-note');
      owner.dataset.noteId = note.id;
    } else {
      delete owner.dataset.noteId;
    }
    updateDescription(owner);
  }

  /** aria-describedby of a row or the tree: its agent mark and its note. */
  function updateDescription(el) {
    const ids = [el.querySelector(':scope > .tree-mark')?.id, el.dataset.noteId].filter(Boolean);
    if (ids.length > 0) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  }

  /** The rows that can be seen: top level and everything in open folders. */
  function visibleRows(container = treeContainer, rows = []) {
    for (const el of container.children) {
      if (el.classList.contains('tree-item')) rows.push(el);
      else if (el.classList.contains('tree-children') && el.classList.contains('expanded')) {
        visibleRows(el, rows);
      }
    }
    return rows;
  }

  function setTabStop(row) {
    for (const el of treeContainer.querySelectorAll('.tree-item[tabindex="0"]')) {
      if (el !== row) el.tabIndex = -1;
    }
    row.tabIndex = 0;
  }

  /**
   * Keeps exactly one visible row in the tab order. The one that has it keeps
   * it; a row that was redrawn away or folded out of sight hands it to the
   * selection, else to the first row. Returns the row, or null for an empty tree.
   */
  function syncTabStop() {
    const rows = visibleRows();
    const current = treeContainer.querySelector('.tree-item[tabindex="0"]');
    if (current && rows.includes(current)) return current;
    const selected = appStore.activeTreeItem;
    const next = selected && rows.includes(selected) ? selected : rows[0] ?? null;
    if (current) current.tabIndex = -1;
    if (next) next.tabIndex = 0;
    return next;
  }

  function focusRow(row) {
    if (!row) return;
    setTabStop(row);
    row.focus();
  }

  function childContainerOf(row) {
    const next = row.nextElementSibling;
    return next?.classList.contains('tree-children') ? next : null;
  }

  /** The folder row a row sits in; null on the top level. */
  function parentRowOf(row) {
    const container = row.parentElement;
    return container?.classList.contains('tree-children') ? container.previousElementSibling : null;
  }

  // A click focuses the row (tabindex -1 takes focus from the mouse), and the
  // row clicked is where Tab comes back to.
  treeContainer.addEventListener('focusin', (e) => {
    const row = e.target.closest?.('.tree-item');
    if (row) setTabStop(row);
  });

  treeContainer.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('.tree-item');
    if (!row || e.altKey || e.metaKey || e.ctrlKey) return;
    // The arrows also work from the @ button, once a click put focus there;
    // what activates is the row's own business — the button has its own Enter.
    const onRow = e.target === row;
    const isDirectory = row.dataset.isDirectory === 'true';
    const childContainer = isDirectory ? childContainerOf(row) : null;
    const expanded = Boolean(childContainer?.classList.contains('expanded'));
    const contextMenuKey = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
    // Typing into the tree starts the filter with that letter (#350). Space
    // stays out: it neither opens a row nor would make a query, and so does
    // a name field in a row (#674), which keeps its letters.
    if (e.key.length === 1 && e.key !== ' ' && !e.isComposing && !e.target.matches?.('input, textarea')) {
      if (filter.open(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (e.shiftKey && !contextMenuKey && !(e.key === 'Enter' && onRow)) return;

    const rows = () => visibleRows();
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': {
        const all = rows();
        focusRow(all[all.indexOf(row) + 1]);
        break;
      }
      case 'ArrowUp': {
        const all = rows();
        const index = all.indexOf(row);
        if (index > 0) focusRow(all[index - 1]);
        break;
      }
      case 'Home':
        focusRow(rows()[0]);
        break;
      case 'End':
        focusRow(rows().at(-1));
        break;
      case 'ArrowRight':
        if (!isDirectory) break;
        if (!expanded) void toggleFolder(row, childContainer, row.dataset.path, { select: false });
        else focusRow(childContainer.querySelector(':scope > .tree-item'));
        break;
      case 'ArrowLeft':
        if (expanded) void toggleFolder(row, childContainer, row.dataset.path, { select: false });
        else focusRow(parentRowOf(row));
        break;
      case 'F2':
        // Rename (#349), on every platform: Enter already opens.
        if (onRow) void beginRename(row.dataset.path);
        else handled = false;
        break;
      case 'Enter':
        if (!onRow) {
          handled = false;
        } else if (e.shiftKey) {
          // The @ button's job (#56), so the row stays the tree's only stop.
          if (typeof insertChatReference === 'function') referenceInChat(itemOfRow(row));
        } else {
          // The same as a click: a file opens, a folder opens or closes.
          row.click();
        }
        break;
      default:
        if (contextMenuKey && onRow) {
          void openFileContextMenu(itemOfRow(row), { at: row });
        } else {
          handled = false;
        }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // The empty space below the rows is the open folder itself (#349): its menu
  // offers "New" there, and nothing that would rename or delete it.
  treeContainer.addEventListener('contextmenu', (e) => {
    if (!appStore.rootPath || e.target.closest?.('.tree-item, .tree-edit-row')) return;
    e.preventDefault();
    void openFileContextMenu({ path: appStore.rootPath, isDirectory: true });
  });

  function itemOfRow(row) {
    return { path: row.dataset.path, isDirectory: row.dataset.isDirectory === 'true' };
  }

  /**
   * Main lists at most READ_DIRECTORY_MAX_ENTRIES per folder (#76); the rest is
   * counted here instead of drawn. Deliberately not a `.tree-item`: it is no
   * entry, so keyboard navigation, drag and drop and the refresh skip it.
   */
  function buildHiddenEntriesNote(hidden, depth) {
    const note = document.createElement('div');
    note.className = 'tree-hidden-entries';
    note.dataset.hiddenCount = String(hidden);
    // Lined up with the names above it.
    note.style.paddingLeft = `${treeNameOffset(depth)}px`;
    note.textContent = hiddenEntriesText(hidden);
    return note;
  }

  function hiddenEntriesText(hidden) {
    return tPlural('tree.hiddenEntries', hidden, { count: formatCount(hidden) });
  }

  /**
   * In place of the rows of a folder that cannot be read (#639) — drawn
   * empty, it would claim there is nothing in it. Like the cap note no
   * `.tree-item`; main gives the reason, the catalogue the words.
   */
  function buildUnreadableNote(reason, depth) {
    const note = document.createElement('div');
    note.className = 'tree-unreadable';
    note.dataset.reason = reason;
    note.style.paddingLeft = `${treeNameOffset(depth)}px`;
    note.textContent = unreadableText(reason);
    return note;
  }

  const UNREADABLE_KEYS = {
    permission: 'tree.unreadable.permission',
    missing: 'tree.unreadable.missing',
  };

  function unreadableText(reason) {
    return t(UNREADABLE_KEYS[reason] ?? 'tree.unreadable.other');
  }

  /**
   * A folder that is loading says so (#639): `aria-busy` at once, the visible
   * state only once the listing takes longer than a moment.
   */
  async function withLoadingState(row, pending) {
    row.setAttribute('aria-busy', 'true');
    const timer = setTimeout(() => row.classList.add('tree-item--loading'), LOADING_STATE_DELAY_MS);
    try {
      return await pending;
    } finally {
      clearTimeout(timer);
      row.removeAttribute('aria-busy');
      row.classList.remove('tree-item--loading');
    }
  }

  /**
   * The same for the project folder itself (#639): a slow root listing — a
   * network share — would otherwise leave an empty tree without a word. The
   * tree is busy at once; past the delay a note with the ring stands where
   * the rows will appear, and goes when they come or the switch is overtaken.
   */
  async function withTreeLoadingState(pending, generation) {
    // A listing that hangs keeps this waiting after a newer switch took
    // over; the tree is that switch's by then, and is left alone.
    const current = () => generation === treeGeneration;
    treeContainer.setAttribute('aria-busy', 'true');
    let note = null;
    const timer = setTimeout(() => {
      if (!current()) return;
      note = buildLoadingNote();
      treeContainer.prepend(note);
    }, LOADING_STATE_DELAY_MS);
    try {
      return await pending;
    } finally {
      clearTimeout(timer);
      note?.remove();
      if (current()) treeContainer.removeAttribute('aria-busy');
    }
  }

  /**
   * Like the other notes no `.tree-item`. It starts at the top level's indent:
   * the ring takes the arrow's slot, and the words start where the names will.
   */
  function buildLoadingNote() {
    const note = document.createElement('div');
    note.className = 'tree-loading';
    note.style.paddingLeft = '4px';
    const ring = document.createElement('span');
    ring.className = 'tree-loading-ring';
    ring.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'tree-loading-text';
    text.textContent = t('tree.loading');
    note.append(ring, text);
    return note;
  }

  /**
   * Der dragfreie zweite Weg zur @-Referenz (Issue #56): kleiner Knopf rechts
   * in der Zeile, sichtbar bei Hover und bei Tastaturfokus. Der einfache Klick
   * auf die Zeile bleibt davon unberührt — er wählt aus und zeigt die Vorschau.
   */
  function buildReferenceButton(item) {
    if (typeof insertChatReference !== 'function') return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tree-item-reference';
    btn.draggable = false;
    btn.dataset.itemName = item.name;
    btn.setAttribute('aria-label', t('tree.reference.label', { name: item.name }));
    btn.title = referenceTitle();
    // Out of the tab order and out of the accessibility tree (#74): a control
    // inside a treeitem would make every row two stops, and the row reaches
    // the same with Shift+Enter. The mouse still clicks it.
    btn.tabIndex = -1;
    btn.setAttribute('aria-hidden', 'true');
    btn.innerHTML = svgAt();
    btn.addEventListener('click', (e) => {
      // Ohne stopPropagation würde die Zeile zusätzlich auswählen bzw. aufklappen.
      e.preventDefault();
      e.stopPropagation();
      referenceInChat(item);
    });
    return btn;
  }

  const REFERENCE_SHORTCUT_MAC = '⇧↩';

  /** "Reference in the chat (Shift+Enter)": the tooltip names the key (#74). */
  function referenceTitle() {
    const shortcut = navigator.userAgent.includes('Mac')
      ? REFERENCE_SHORTCUT_MAC
      : t('tree.reference.shortcut');
    return `${t('tree.reference')} (${shortcut})`;
  }

  /** Übersetzt einen Baum-Eintrag in eine @-Referenz und reicht sie an den Chat. */
  function referenceInChat(item) {
    const entry = workspaceReferenceFor(item.path, appStore.rootPath, {
      isDirectory: Boolean(item.isDirectory),
    });
    if (!entry) return;
    insertChatReference(entry.path, entry.kind);
  }

  // Issue #59: Main hat eine Datei über das Kontextmenü in den Papierkorb gelegt.
  // Baum nachziehen; war die Datei ausgewählt, Vorschau schließen.
  api.onFsItemDeleted?.(({ path: deletedPath } = {}) => {
    void handleFsItemDeleted(deletedPath);
  });

  // Issue #158: Der Watcher im Main meldet jede Änderung im Projektordner —
  // gleich ob sie von der KI, aus dem Terminal, aus dem Finder oder von einem
  // anderen Editor kommt. Die Meldungen laufen der Reihe nach durch: Zwei
  // gleichzeitig laufende Neuzeichnungen kämen sich am selben DOM in die Quere.
  api.onFsTreeChanged?.((payload) => {
    // The filter's list covers folders the tree has never drawn, so it hears
    // of every report, not only of those that redraw something (#350).
    filter.refresh();
    void enqueueTreeWork(() => syncTreeWithFilesystem(payload), 'Baum-Abgleich fehlgeschlagen');
  });

  async function handleFsItemDeleted(deletedPath) {
    if (!appStore.rootPath || typeof deletedPath !== 'string' || !deletedPath) return;
    agentMarks.forget(deletedPath);
    // Bei einem gelöschten Ordner (#120) ist auch die Vorschau einer Datei
    // darin hinfällig, nicht nur die des gelöschten Eintrags selbst.
    if (appStore.selectedPath === deletedPath || isInsideDir(appStore.selectedPath, deletedPath)) {
      clearSelection();
    }
    contentPane.forgetPath(deletedPath);
    const openPath = contentPane.openPath();
    if (openPath === deletedPath || isInsideDir(openPath, deletedPath)) {
      await contentPane.close('file-removed');
    }
    // In the queue and through the redraw that keeps selection, focus and
    // scroll (#636).
    await enqueueTreeWork(
      () => redrawFolders([parentDirOf(deletedPath)]),
      'Tree could not be redrawn after a delete'
    );
  }

  // Issue #58: natives Kontextmenü (Öffnen / Im Finder bzw. Explorer anzeigen / Löschen).
  // Das Menü selbst baut der Main-Prozess, hier wird nur der Pfad übergeben —
  // dazu die Information, ob es ein Ordner ist, damit „Öffnen“ entfällt (#120).
  /**
   * `at`: the row the keyboard opened it on (#74). The menu then opens below
   * the name, not wherever the mouse pointer happens to rest.
   */
  async function openFileContextMenu(item, { at = null } = {}) {
    try {
      const result = await api.showFileContextMenu(item.path, {
        agentMark: Boolean(rowForPath(item.path)?.querySelector(':scope > .tree-mark')),
        changes: !item.isDirectory && fileChanges.changesFor(appStore.currentChatId, item.path).length > 0,
        ...(at ? { position: menuPositionFor(at) } : {}),
      });
      if (result?.error) console.warn('Context menu refused:', result.error);
    } catch (err) {
      console.warn('Context menu failed:', err?.message ?? err);
    }
  }

  /** Window coordinates in CSS pixels: under the start of the row's name. */
  function menuPositionFor(row) {
    const rowBox = row.getBoundingClientRect();
    const labelBox = row.querySelector('.label')?.getBoundingClientRect() ?? rowBox;
    return { x: Math.round(labelBox.left), y: Math.round(rowBox.bottom) };
  }

  /**
   * A folder row takes files from outside to copy and rows of the tree to
   * move — nothing else (#641). Text dragged in from elsewhere may well read
   * like a path of the workspace; a drop must not move that file unasked.
   */
  function acceptsDrag(e) {
    const external = isExternalFileDrop(e.dataTransfer?.types, Boolean(dragSourcePath));
    if (external) return appStore.rootPath ? 'copy' : null;
    return dragSourcePath ? 'move' : null;
  }

  function handleDragOver(e) {
    const effect = acceptsDrag(e);
    if (!effect) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = effect;
  }

  function handleDragEnter(e) {
    const effect = acceptsDrag(e);
    if (!effect) return;
    const external = effect === 'copy';
    e.preventDefault();
    const row = e.currentTarget;
    if (row === dragSourceRow) return;
    clearDropTarget();
    // Eigener Zustand fuer den Import: man soll sehen, dass hier kopiert und
    // nicht verschoben wird (#101).
    row.classList.add(external ? 'drop-target--import' : 'drop-target');
    currentDropTarget = row;
  }

  function handleDragLeave(e) {
    const row = e.currentTarget;
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove('drop-target');
      row.classList.remove('drop-target--import');
      if (currentDropTarget === row) currentDropTarget = null;
    }
  }

  function clearDropTarget() {
    if (currentDropTarget) {
      currentDropTarget.classList.remove('drop-target');
      currentDropTarget.classList.remove('drop-target--import');
      currentDropTarget = null;
    }
  }

  function clearDragVisualState() {
    treeContainer.classList.remove('drop-target-root');
    treeContainer.classList.remove('drop-target-root--import');
    for (const el of treeContainer.querySelectorAll('.tree-item.drop-target, .tree-item.drop-target--import')) {
      el.classList.remove('drop-target');
      el.classList.remove('drop-target--import');
    }
    for (const el of treeContainer.querySelectorAll('.tree-item.dragging')) {
      el.classList.remove('dragging');
    }
    currentDropTarget = null;
  }

  function collectExpandedFolderPaths() {
    const paths = [];
    for (const el of treeContainer.querySelectorAll('.tree-children.expanded')) {
      const p = el.dataset.path;
      if (p) paths.push(p);
    }
    return paths;
  }

  async function restoreExpandedFolders(paths) {
    for (const p of sortFoldersTopDown(paths)) {
      await expandFolderAtPath(p);
    }
  }

  function loadDepthFromTreeRow(row) {
    if (!row) return 1;
    return treeDepthFromIndentWidth(row.querySelector('.indent')?.style.width);
  }

  async function expandFolderAtPath(dirPath) {
    const childContainer = treeContainer.querySelector(
      `.tree-children[data-path="${CSS.escape(dirPath)}"]`
    );
    if (!childContainer) return;
    const row = childContainer.previousElementSibling;
    if (!row || row.dataset.isDirectory !== 'true') return;
    const depth = loadDepthFromTreeRow(row);
    childContainer.innerHTML = '';
    await loadTreeLevel(childContainer, dirPath, depth);
    childContainer.dataset.loaded = 'true';
    showExpanded(row, childContainer, true);
  }

  /**
   * Expands a folder that is already drawn, loading it on first use. A first
   * load draws rows, so this runs in the queue (#636) — found by path, since
   * a redraw ahead of it in the queue replaces the nodes.
   */
  async function ensureFolderExpanded(dirPath) {
    const childContainer = treeContainer.querySelector(
      `.tree-children[data-path="${CSS.escape(dirPath)}"]`
    );
    if (!childContainer) return false;
    const row = childContainer.previousElementSibling;
    if (childContainer.dataset.loaded !== 'true') {
      await loadTreeLevel(childContainer, dirPath, loadDepthFromTreeRow(row));
      childContainer.dataset.loaded = 'true';
    }
    showExpanded(row, childContainer, true);
    return true;
  }

  /**
   * A link in the preview points at another file of the workspace (#344):
   * unfold the folders above it, select it and show it — the same as a click
   * on its row. A folder is unfolded and selected; the preview stays.
   *
   * Resolves to `{ ok: true }` or `{ ok: false, reason }` with 'outside' (not
   * in the open folder) or 'not-found'; the view tells the user which.
   */
  async function openFromPreview(targetPath, openOptions = {}) {
    const root = appStore.rootPath;
    if (!root || typeof targetPath !== 'string' || !isInsideDir(targetPath, root)) {
      return { ok: false, reason: 'outside' };
    }
    const ancestors = [];
    for (let dir = parentDirOf(targetPath); isInsideDir(dir, root); dir = parentDirOf(dir)) {
      ancestors.unshift(dir);
    }
    // A folder switch while this waits makes the link one of the folder left
    // (#633): nothing of it is selected or opened. The view that asked is
    // gone by then, the same as for a view that was replaced.
    const generation = treeGeneration;
    const stale = () => generation !== treeGeneration;
    await enqueueTreeWork(async () => {
      for (const dir of ancestors) {
        if (!(await ensureFolderExpanded(dir))) break;
      }
    }, 'Folders could not be opened');
    if (stale()) return { ok: false, reason: 'stale' };

    const row = rowForPath(targetPath);
    if (row?.dataset.isDirectory === 'true') {
      await enqueueTreeWork(() => ensureFolderExpanded(targetPath), 'Folder could not be opened');
      if (stale()) return { ok: false, reason: 'stale' };
      // A redraw queued ahead may have replaced the row meanwhile.
      const folderRow = rowForPath(targetPath) ?? row;
      setActiveItem(folderRow);
      appStore.selectedPath = targetPath;
      appStore.selectedIsDirectory = true;
      folderRow.scrollIntoView?.({ block: 'nearest' });
      return { ok: true };
    }
    if (row) {
      row.scrollIntoView?.({ block: 'nearest' });
      if (openOptions.changes) await selectFile(row, itemForRow(row), openOptions);
      else row.click();
      return { ok: true };
    }

    // Not drawn: either it does not exist, or the listing left it out (#76) —
    // or the link spells the name in another case than the disk. Whatever
    // reads, is shown; the tree then has no row to mark.
    // A diff needs no file on disk: the agent may have written one that is
    // gone by now (#348), and main still holds what it wrote.
    const probe = openOptions.changes ? null : await api.readFile(targetPath);
    if (stale()) return { ok: false, reason: 'stale' };
    if (!openOptions.changes && (!probe || probe.error)) {
      return { ok: false, reason: 'not-found' };
    }
    const shown = await contentPane.open({
      path: targetPath,
      name: basenameOf(targetPath),
      size: probe?.size,
      modified: probe?.modified,
    }, openOptions);
    if (stale()) return { ok: false, reason: 'stale' };
    if (shown) {
      agentMarks.markSeen(targetPath);
      deselectActiveItem();
      appStore.activeTreeItem = null;
      appStore.selectedPath = targetPath;
      appStore.selectedIsDirectory = false;
    }
    return { ok: true };
  }

  /**
   * The open folder's README.md, when it can be shown (#351): a file of the
   * top level as the tree drew it, read once to make sure. Null when there is
   * none, or one too large or unreadable — the column does not open for an
   * error — or when the folder changed while it was read.
   */
  async function readableFolderReadme() {
    if (!appStore.rootPath) return null;
    const generation = treeGeneration;
    const files = [...treeContainer.querySelectorAll(':scope > .tree-item')]
      .filter((row) => row.dataset.isDirectory !== 'true')
      .map((row) => row.dataset.path);
    const readmePath = pickFolderReadme(files);
    if (!readmePath) return null;
    const probe = await api.readFile(readmePath);
    if (generation !== treeGeneration || !probe || probe.error) return null;
    return { path: readmePath, name: basenameOf(readmePath), size: probe.size, modified: probe.modified };
  }

  /**
   * Shows the folder's README in the pane (#351) — shown, not selected: the
   * user did not pick it, so no row is marked and the model is not told about
   * it as the selected file. A file already on show, or a folder switched
   * meanwhile, wins.
   */
  async function showFolderReadme(readme) {
    if (!readme || contentPane.openPath() || !isInsideDir(readme.path, appStore.rootPath)) return false;
    return contentPane.open(readme);
  }

  async function handleDrop(e, destDir, dropRow, depth) {
    e.preventDefault();
    e.stopPropagation();

    if (isExternalFileDrop(e.dataTransfer?.types, Boolean(dragSourcePath))) {
      // Synchron aus dem DataTransfer lesen, bevor irgendetwas awaitet wird.
      const sources = droppedFilesFrom(e.dataTransfer);
      clearDragVisualState();
      await importExternalItems(sources, importDestDirFor(dropRow?.dataset, appStore.rootPath));
      return;
    }

    clearDragVisualState();

    // Only a drag from the tree moves (#641) — not text that names a path.
    const sourcePath = dragSourcePath;
    if (!sourcePath || sourcePath === destDir) return;

    const result = await api.moveItem(sourcePath, destDir);
    if (result.error) {
      console.error('Move failed:', result.error);
      clearDragVisualState();
      return;
    }

    // Both folders in one redraw, in the queue, keeping selection, focus and
    // scroll (#636).
    await enqueueTreeWork(
      () => redrawFolders([parentDirFromItemPath(sourcePath), destDir]),
      'Tree could not be redrawn after a move'
    );
    clearDragVisualState();
  }

  /**
   * The dropped File objects. Must run synchronously: after the first await
   * the DataTransfer is empty, the File objects themselves stay valid. Their
   * paths are resolved in the preload, not here — the page cannot name a
   * source (#646); one that is not from the file system (a drag out of a
   * browser) has no path and is dropped there.
   */
  function droppedFilesFrom(dataTransfer) {
    return Array.from(dataTransfer?.files ?? []);
  }

  /**
   * Issue #101: Dateien und Ordner von aussen uebernehmen. Der Renderer waehlt
   * nur den Zielordner und reicht die gedroppten Dateien durch — geprueft,
   * bestaetigt und kopiert wird im Main-Prozess, der Fehler auch selbst nativ
   * meldet.
   */
  async function importExternalItems(sources, destDir) {
    if (!appStore.rootPath || !destDir || sources.length === 0 || importInFlight) return;
    importInFlight = true;
    treeContainer.classList.add('import-busy');
    try {
      // Beratend: verbindlich prueft der Import-Kanal gleich noch einmal.
      // Ein Drop, bei dem nichts zu kopieren waere (nur Verknuepfungen),
      // soll keinen Dialog ausloesen.
      const inspection = await api.inspectImport?.(sources, destDir);
      if (inspection?.ok && inspection.dirs === 0 && inspection.files === 0) return;

      const result = await api.importItems(sources, destDir);
      if (result?.cancelled) return;
      if (result?.error) {
        console.warn('Uebernehmen fehlgeschlagen:', result.error);
        return;
      }
      await refreshAfterImport(destDir);
    } catch (err) {
      console.warn('Uebernehmen fehlgeschlagen:', err?.message ?? err);
    } finally {
      importInFlight = false;
      treeContainer.classList.remove('import-busy');
    }
  }

  /**
   * In the queue and through the redraw that keeps selection, focus and
   * scroll (#636). The target folder opens, so what came in can be seen; one
   * that is drawn already keeps its open subfolders.
   */
  async function refreshAfterImport(destDir) {
    await enqueueTreeWork(async () => {
      await redrawFolders([destDir]);
      if (destDir !== appStore.rootPath) await ensureFolderExpanded(destDir);
    }, 'Tree could not be redrawn after an import');
  }

  // Wird nach jedem schreibenden Tool-Aufruf (write_file_text, edit_file,
  // apply_patch: KI hat eine Datei angelegt/geändert) aus app.js gerufen, damit Baum und Vorschau ohne manuelles
  // Neuladen den aktuellen Stand zeigen.
  async function notifyExternalFileWrite(relativePath) {
    if (!appStore.rootPath || typeof relativePath !== 'string') return;
    // Only `./` and leading slashes go: the dot of `.env` or `.github/` is
    // part of the name (#641).
    const rel = relativePath.trim().replace(/^(?:\.\/|\/)+/, '');
    if (!rel || rel === '.') return;
    // Relativer POSIX-Pfad aus dem Tool + nativer Workspace-Pfad -> der
    // Ergebnispfad muss dem Stil der Baum-Einträge entsprechen (Windows: `\`),
    // sonst schlägt der Vergleich mit appStore.selectedPath fehl (#73).
    const absPath = joinNative(appStore.rootPath, rel);

    // One patch writes several files without waiting in between: in the queue
    // each redraw finishes before the next clears, and the view stays (#636).
    await enqueueTreeWork(
      () => redrawFolders([parentDirOf(absPath)]),
      'Tree could not be redrawn after a write'
    );
    // The pane decides whether that is the file on show.
    await contentPane.refresh(absPath);
  }

  async function refreshFolder(dirPath) {
    if (dirPath === appStore.rootPath) {
      const expandedBefore = collectExpandedFolderPaths();
      treeContainer.innerHTML = '';
      await loadTreeLevel(treeContainer, appStore.rootPath, 0);
      await restoreExpandedFolders(expandedBefore);
      return;
    }
    const childContainer = treeContainer.querySelector(
      `.tree-children[data-path="${CSS.escape(dirPath)}"]`
    );
    if (childContainer && childContainer.dataset.loaded === 'true') {
      const wasExpanded = childContainer.classList.contains('expanded');
      childContainer.innerHTML = '';
      const row = childContainer.previousElementSibling;
      const depthVal = loadDepthFromTreeRow(row);
      await loadTreeLevel(childContainer, dirPath, depthVal);
      childContainer.dataset.loaded = 'true';
      if (wasExpanded) showExpanded(row, childContainer, true);
    }
  }

  // ── What the agent read or changed (#347) ─────────────────────────────────
  // The state lives in agentMarks, per conversation; here it becomes a letter
  // at the right edge of the row. A folder row always carries the loudest
  // mark below it, and the stylesheet hides it while the folder is open —
  // so no expand or collapse has to remember to redraw it.

  const MARK_LETTERS = Object.freeze({ read: 'R', changed: 'M', unseen: 'M' });
  const MARK_LABELS = Object.freeze({
    read: 'tree.mark.read',
    changed: 'tree.mark.changed',
    unseen: 'tree.mark.unseen',
  });
  const FOLDER_MARK_LABELS = Object.freeze({
    read: 'tree.mark.folder.read',
    changed: 'tree.mark.folder.changed',
    unseen: 'tree.mark.folder.unseen',
  });

  function applyAgentMarkToRow(row, summaries) {
    const isDirectory = row.dataset.isDirectory === 'true';
    const mark = isDirectory
      ? summaries.get(row.dataset.path) || null
      : agentMarks.markOf(appStore.currentChatId, row.dataset.path);
    let el = row.querySelector(':scope > .tree-mark');
    if (!mark) {
      if (el) {
        el.remove();
        updateDescription(row);
      }
      return;
    }
    if (!el) {
      el = document.createElement('span');
      el.className = 'tree-mark';
      // Not colour alone, nor the letter alone: the label says it in words.
      el.setAttribute('role', 'img');
      // The row's name is set, so the mark reaches a screen reader as the
      // row's description (#74).
      el.id = describedId('tree-mark');
      row.insertBefore(el, row.querySelector(':scope > .tree-item-reference'));
      updateDescription(row);
    }
    el.dataset.mark = mark;
    el.classList.toggle('tree-mark--folder', isDirectory);
    el.textContent = MARK_LETTERS[mark];
    const label = t((isDirectory ? FOLDER_MARK_LABELS : MARK_LABELS)[mark]);
    el.setAttribute('aria-label', label);
    el.title = label;
  }

  function applyAgentMarks(rows) {
    const summaries = agentMarks.folderSummaries(appStore.currentChatId, appStore.rootPath);
    for (const row of rows) applyAgentMarkToRow(row, summaries);
  }

  /** Draws the marks of the conversation on screen, e.g. after a chat switch. */
  function syncAgentMarks() {
    applyAgentMarks(treeContainer.querySelectorAll('.tree-item'));
    if (btnClearMarks) btnClearMarks.hidden = !agentMarks.hasMarks(appStore.currentChatId);
    // "Content | Changes" follows the conversation on screen (#348).
    contentPane.syncChanges();
  }

  /**
   * A tool of the chat `chatId` read or changed `relativePath`. ChatStream
   * passes only runs in the open folder; the path is the tool's, relative.
   */
  function recordAgentFile(kind, relativePath, chatId, change = null) {
    const path = markPathFor(appStore.rootPath, relativePath);
    if (!path || !chatId) return;
    if (kind === 'write') {
      if (change) fileChanges.record(chatId, path, change);
      agentMarks.recordWrite(chatId, path);
      // The file on show may just have got its first change (#348).
      if (contentPane.openPath() === path) contentPane.syncChanges();
    } else {
      agentMarks.recordRead(chatId, path);
    }
  }

  /**
   * Opens the diff of a file in the preview (#348) and selects its row, the
   * way a click on it would. `ids` defaults to every change the conversation
   * on screen made to it.
   */
  async function openChanges(path, ids) {
    const list = Array.isArray(ids) && ids.length
      ? ids
      : fileChanges.changesFor(appStore.currentChatId, path).map((change) => change.id);
    if (!path || list.length === 0) return { ok: false, reason: 'not-found' };
    revealContentPane?.();
    return openFromPreview(path, { changes: { ids: list } });
  }

  /**
   * A link in the chat to a file of the workspace (#479): opens it in the
   * preview column — brought back if it is hidden — and selects its row.
   * The `#fragment` reaches the view as it would from a link in a view.
   */
  function openWorkspaceFile(path, { fragment = '' } = {}) {
    if (!path || !appStore.rootPath || !isInsideDir(path, appStore.rootPath)) {
      return Promise.resolve({ ok: false, reason: 'outside' });
    }
    revealContentPane?.();
    return contentPane.openFromLink(path, { fragment });
  }

  /** "Show changes" under a message of the chat: `{ relativePath, changes }`. */
  function showFileChanges({ relativePath, changes } = {}) {
    const path = markPathFor(appStore.rootPath, relativePath);
    const ids = (Array.isArray(changes) ? changes : []).map((change) => change?.id).filter(Boolean);
    if (!path || ids.length === 0) return Promise.resolve({ ok: false, reason: 'outside' });
    return openChanges(path, ids);
  }

  api.onFsShowChanges?.(({ path } = {}) => {
    if (typeof path === 'string' && path) void openChanges(path);
  });

  // One patch marks many files at once: one redraw for all of them.
  let agentMarksQueued = false;
  agentMarks.onChange(() => {
    if (agentMarksQueued) return;
    agentMarksQueued = true;
    queueMicrotask(() => {
      agentMarksQueued = false;
      syncAgentMarks();
    });
  });

  btnClearMarks?.addEventListener('click', () => {
    agentMarks.clearChat(appStore.currentChatId);
    // The button hides under the focus; its neighbour in the header takes it.
    document.getElementById('btn-tree-actions')?.focus();
  });

  api.onFsClearAgentMark?.(({ path } = {}) => {
    if (typeof path === 'string' && path) agentMarks.clear(appStore.currentChatId, path);
  });

  // ── New file, new folder, rename (#349) ────────────────────────────────
  // The name is typed into the tree itself: into a fresh row where the new
  // entry will land, or into the row being renamed. The field holds the
  // tree's queue while it is open — a watcher report or an agent's write
  // would redraw the folder, and the field with it; they run once it closes.
  // Escape or a click elsewhere closes it unchanged; switching to another
  // window does not. Main checks the name once more and does the work.

  const NAME_FAILURES = new Set([
    ...Object.values(contracts.ITEM_NAME_REASONS),
    ...Object.values(contracts.ITEM_FAILURE_REASONS),
  ]);

  // The field that is open, as the means to close it; null without one.
  let closeNameField = null;

  function nameFailureText(failure) {
    const reason = NAME_FAILURES.has(failure?.reason) ? failure.reason : 'failed';
    return t(`tree.name.error.${reason}`, {
      name: failure?.name ?? '',
      character: failure?.character ?? '',
      detail: failure?.error ?? '',
    });
  }

  /**
   * What is wrong with the name while it is typed — the same rule main
   * applies, and a name already drawn in the folder. Nothing for an empty
   * field: that is where everyone starts. Main still has the last word on
   * the disk, including names that differ only in case.
   */
  function typedNameProblem(value, siblings, ownName) {
    const checked = contracts.validateItemName(value);
    if (!checked.ok) return checked.reason === contracts.ITEM_NAME_REASONS.EMPTY ? null : checked;
    if (checked.name !== ownName && siblings.includes(checked.name)) {
      return { reason: contracts.ITEM_FAILURE_REASONS.EXISTS, name: checked.name };
    }
    return null;
  }

  /**
   * Runs one name field until it closes. `row` carries the field after
   * `anchor`; the message about a refused name goes under the row.
   * `submit(name)` asks main and resolves with its answer. Resolves with
   * that answer once it is `ok`, or with null when the field was left.
   */
  function runNameField({ row, anchor, depth, value, selectionEnd, ariaLabel, siblings, ownName, submit, onTyped }) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tree-name-input';
    input.value = value;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', ariaLabel);
    anchor.after(input);

    const message = document.createElement('div');
    message.className = 'tree-name-error';
    message.id = describedId('tree-name-error');
    message.setAttribute('aria-live', 'polite');
    message.style.marginLeft = `${treeNameOffset(depth)}px`;
    message.hidden = true;
    // A click on the message keeps the field open.
    message.addEventListener('mousedown', (e) => e.preventDefault());
    row.after(message);

    const show = (problem) => {
      message.hidden = !problem;
      message.textContent = problem ? nameFailureText(problem) : '';
      if (problem) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', message.id);
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      }
    };

    return new Promise((resolve) => {
      let busy = false;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        closeNameField = null;
        input.remove();
        message.remove();
        resolve(result);
      };
      closeNameField = () => finish(null);

      // The row's own handlers — open, select, drag, its menu, the tree's
      // arrow keys — are not the field's.
      for (const type of ['click', 'dblclick', 'mousedown', 'contextmenu', 'dragstart']) {
        input.addEventListener(type, (e) => e.stopPropagation());
      }
      input.addEventListener('input', () => {
        onTyped?.(input.value);
        show(typedNameProblem(input.value, siblings, ownName));
      });
      input.addEventListener('keydown', async (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          if (!busy) finish(null);
          return;
        }
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        if (busy) return;
        const checked = contracts.validateItemName(input.value);
        const problem = checked.ok ? typedNameProblem(input.value, siblings, ownName) : checked;
        if (problem) {
          show(problem);
          return;
        }
        busy = true;
        let result;
        try {
          result = await submit(checked.name);
        } catch (err) {
          result = { reason: 'failed', error: err?.message ?? String(err) };
        }
        busy = false;
        if (done) return;
        if (result?.ok) {
          finish(result);
          return;
        }
        show({ ...result, name: checked.name });
        input.focus();
      });
      // Focus that goes elsewhere in the window closes the field; focus that
      // goes to another window leaves it as it is — the field stays the
      // document's active element then.
      input.addEventListener('blur', () => {
        setTimeout(() => {
          if (!done && !busy && document.activeElement !== input) finish(null);
        }, 0);
      });

      input.focus();
      input.setSelectionRange(0, selectionEnd ?? input.value.length);
    });
  }

  /**
   * Whether the focus went down with the field — Escape, or Enter on a name
   * that was no change — rather than to something the user clicked.
   */
  function focusWasDropped() {
    return !document.activeElement || document.activeElement === document.body;
  }

  /** The folders from below the root down to `dir`, top first. */
  function foldersDownTo(dir, root) {
    const folders = [];
    for (let d = dir; d !== root && isInsideDir(d, root); d = parentDirOf(d)) folders.unshift(d);
    return folders;
  }

  /**
   * Where the header's buttons create (#349): in the selected folder, next to
   * the selected file, else in the open folder.
   */
  function createTargetDir() {
    const root = appStore.rootPath;
    const selected = appStore.selectedPath;
    if (!selected || !isInsideDir(selected, root)) return root;
    return appStore.selectedIsDirectory ? selected : parentDirOf(selected);
  }

  /**
   * Asks for the name of a new file or folder in `parentDir` and creates it.
   * The new entry is selected afterwards, a file shown in the preview.
   */
  async function beginCreate(parentDir, kind) {
    const root = appStore.rootPath;
    if (!root || (parentDir !== root && !isInsideDir(parentDir, root))) return;
    closeNameField?.();
    const returnFocus = document.activeElement;
    const generation = treeGeneration;
    const left = generationLeft;
    const created = await enqueueTreeWork(async () => {
      if (generation !== treeGeneration) return null;
      for (const dir of foldersDownTo(parentDir, root)) {
        if (!(await ensureFolderExpanded(dir))) return null;
      }
      const container = folderContainer(parentDir);
      if (!container) return null;
      const rows = rowsOfFolder(parentDir) ?? [];
      const depth = parentDir === root ? 0 : loadDepthFromTreeRow(container.previousElementSibling);

      const row = document.createElement('div');
      row.className = 'tree-edit-row';
      const indent = document.createElement('span');
      indent.className = 'indent';
      indent.style.width = `${depth * 16 + 4}px`;
      const arrow = document.createElement('span');
      arrow.className = 'arrow arrow--placeholder';
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.innerHTML = kind === 'directory' ? svgFolder() : svgFile('');
      row.append(indent, arrow, icon);
      // Where the entry will land, near enough: folders first, files after.
      const before = (kind === 'directory' ? rows[0] : rows.find((r) => r.dataset.isDirectory !== 'true'))
        ?? container.querySelector(':scope > .tree-hidden-entries, :scope > .tree-unreadable');
      container.insertBefore(row, before ?? null);
      row.scrollIntoView?.({ block: 'nearest' });

      const field = runNameField({
        row,
        anchor: icon,
        depth,
        value: '',
        ariaLabel: t(kind === 'directory' ? 'tree.name.newFolder' : 'tree.name.newFile'),
        siblings: rows.map((r) => basenameOf(r.dataset.path)),
        ownName: null,
        submit: (name) => api.createItem(parentDir, name, kind),
        onTyped: kind === 'directory' ? null : (typed) => { icon.innerHTML = svgFile(typed.trim()); },
      });
      // A folder switch takes the field with it (#633).
      const result = await Promise.race([field, left.then(() => { closeNameField?.(); return null; })]);
      row.remove();
      if (!result?.ok || generation !== treeGeneration) return null;

      await redrawFolders([parentDir]);
      const newRow = rowForPath(result.path);
      if (!newRow) {
        // Not drawn — a dot file while hidden files are off (#436). It was
        // created all the same; a file at least shows.
        if (kind === 'file') await contentPane.open({ path: result.path, name: basenameOf(result.path) });
        return result;
      }
      if (kind === 'directory') {
        setActiveItem(newRow);
        appStore.selectedPath = result.path;
        appStore.selectedIsDirectory = true;
      } else {
        await selectFile(newRow, itemForRow(newRow));
      }
      newRow.scrollIntoView?.({ block: 'nearest' });
      focusRow(rowForPath(result.path) ?? newRow);
      return result;
    }, 'The new entry could not be created');
    if (!created && returnFocus?.isConnected && focusWasDropped()) returnFocus.focus?.();
  }

  /**
   * Asks for a new name in the row itself and renames. Selection, the file on
   * show and the open folders follow the new name, below a renamed folder too.
   */
  async function beginRename(itemPath) {
    const root = appStore.rootPath;
    if (!root || !isInsideDir(itemPath, root)) return;
    closeNameField?.();
    const generation = treeGeneration;
    const left = generationLeft;
    await enqueueTreeWork(async () => {
      if (generation !== treeGeneration) return;
      const row = rowForPath(itemPath);
      const label = row?.querySelector(':scope > .label');
      if (!label) return;
      const isDirectory = row.dataset.isDirectory === 'true';
      const parentDir = parentDirOf(itemPath);
      const oldName = basenameOf(itemPath);
      const dot = oldName.lastIndexOf('.');

      row.classList.add('tree-item--editing');
      row.draggable = false;
      label.hidden = true;
      const field = runNameField({
        row,
        anchor: label,
        depth: treeDepthFromIndentWidth(row.querySelector('.indent')?.style.width) - 1,
        value: oldName,
        // The name without its extension, as a file manager does.
        selectionEnd: !isDirectory && dot > 0 ? dot : oldName.length,
        ariaLabel: t('tree.name.rename', { name: oldName }),
        siblings: (rowsOfFolder(parentDir) ?? []).map((r) => basenameOf(r.dataset.path)),
        ownName: oldName,
        submit: (name) => (name === oldName
          ? Promise.resolve({ ok: true, path: itemPath, unchanged: true })
          : api.renameItem(itemPath, name)),
      });
      const result = await Promise.race([field, left.then(() => { closeNameField?.(); return null; })]);
      row.classList.remove('tree-item--editing');
      row.draggable = true;
      label.hidden = false;
      if (generation !== treeGeneration) return;
      if (!result?.ok || result.unchanged) {
        if (focusWasDropped()) focusRow(rowForPath(itemPath));
        return;
      }
      await followRename(itemPath, result.path, parentDir);
    }, 'The entry could not be renamed');
  }

  async function followRename(oldPath, newPath, parentDir) {
    const moved = (p) => {
      if (p === oldPath) return newPath;
      return p && isInsideDir(p, oldPath) ? newPath + p.slice(oldPath.length) : null;
    };
    const expanded = collectExpandedFolderPaths().map(moved).filter(Boolean);
    const selected = moved(appStore.selectedPath);
    const selectedIsDirectory = appStore.selectedIsDirectory;
    const openMoved = moved(contentPane.openPath());
    agentMarks.forget(oldPath);
    contentPane.renamePath(oldPath, newPath);

    await redrawFolders([parentDir]);
    await restoreExpandedFolders(expanded);
    // The file on show reads again under its new name — before a watcher
    // report would close it as gone.
    if (openMoved) await contentPane.open({ path: openMoved, name: basenameOf(openMoved) });
    if (selected) {
      const selectedRow = rowForPath(selected);
      if (selectedRow) setActiveItem(selectedRow);
      appStore.selectedPath = selected;
      appStore.selectedIsDirectory = selectedIsDirectory;
    }
    const newRow = rowForPath(newPath);
    newRow?.scrollIntoView?.({ block: 'nearest' });
    focusRow(newRow);
  }


  // "New File…", "New Folder…" and "Rename…" from the context menu: main
  // only says where.
  api.onFsBeginCreate?.(({ path, kind } = {}) => {
    if (typeof path === 'string' && path && (kind === 'file' || kind === 'directory')) {
      void beginCreate(path, kind);
    }
  });
  api.onFsBeginRename?.(({ path } = {}) => {
    if (typeof path === 'string' && path) void beginRename(path);
  });

  // ── Abgleich mit dem Dateisystem (Issue #158) ─────────────────────────────

  function rowForPath(itemPath) {
    if (!itemPath) return null;
    return treeContainer.querySelector(`.tree-item[data-path="${CSS.escape(itemPath)}"]`);
  }

  /** Der Projektordner und alles, was gerade aufgeklappt ist — mehr ist nicht
   *  zu sehen. Nicht sichtbare Ordner laden beim Aufklappen ohnehin frisch. */
  function visibleFolderPaths() {
    return [appStore.rootPath, ...collectExpandedFolderPaths()];
  }

  function folderContainer(dirPath) {
    return dirPath === appStore.rootPath
      ? treeContainer
      : treeContainer.querySelector(`.tree-children[data-path="${CSS.escape(dirPath)}"]`);
  }

  /** Die gezeichneten Einträge eines Ordners (nur die direkte Ebene). */
  function rowsOfFolder(dirPath) {
    const container = folderContainer(dirPath);
    if (!container) return null;
    return [...container.children].filter((el) => el.classList?.contains('tree-item'));
  }

  /** How many entries the folder's note says are cut off; 0 without a note. */
  function hiddenCountOfFolder(dirPath) {
    const note = [...(folderContainer(dirPath)?.children ?? [])]
      .find((el) => el.classList?.contains('tree-hidden-entries'));
    return note ? Number(note.dataset.hiddenCount) || 0 : 0;
  }

  /** Why the folder's note says it cannot be read (#639); null without one. */
  function unreadableReasonOfFolder(dirPath) {
    const note = [...(folderContainer(dirPath)?.children ?? [])]
      .find((el) => el.classList?.contains('tree-unreadable'));
    return note?.dataset.reason ?? null;
  }

  /**
   * Steht im Ordner etwas anderes als im Baum? Die Frage kostet ein
   * `readDirectory` und erspart im Regelfall alles Weitere: Schreibt ein
   * Build-Lauf oder die KI in eine vorhandene Datei, ändert sich der
   * Ordnerinhalt nicht — dann bleibt das DOM unangetastet, und weder Fokus
   * noch Scrollposition geraten ins Rutschen.
   */
  async function folderListingChanged(dirPath) {
    const rows = rowsOfFolder(dirPath);
    if (!rows) return false;
    const generation = treeGeneration;
    const listing = await listFolder(dirPath);
    if (generation !== treeGeneration) return false;
    const { entries: items = [], hidden = 0, unreadable = null } = listing || {};
    const jetzt = items.map((item) => listingSignature(item.path, item.isDirectory));
    const vorher = rows.map((row) => listingSignature(row.dataset.path, row.dataset.isDirectory === 'true'));
    // Past the cap the drawn rows can stay the same while the count behind them
    // moves; an unreadable folder has no rows either way, only its reason.
    return listingsDiffer(jetzt, vorher)
      || hidden !== hiddenCountOfFolder(dirPath)
      || unreadable !== unreadableReasonOfFolder(dirPath);
  }

  /**
   * Was der Nutzer gerade tut, überlebt die Aktualisierung: Auswahl,
   * Tastaturfokus und Scrollposition. Ein Refresh, der den Fokus wegnimmt,
   * bricht die Tastaturbedienung mitten im Navigieren (#74).
   */
  function captureTreeView() {
    const active = document.activeElement;
    const inTree = active && treeContainer.contains(active) ? active : null;
    return {
      generation: treeGeneration,
      scrollTop: treeContainer.scrollTop,
      focusPath: inTree?.closest('.tree-item')?.dataset?.path ?? null,
      focusReference: Boolean(inTree?.classList?.contains('tree-item-reference')),
    };
  }

  function restoreTreeView(view) {
    // A view of the folder left is no view of this one (#633).
    if (view.generation !== treeGeneration) return;
    // Die ausgewählte Zeile ist nach dem Neuzeichnen ein anderer Knoten —
    // ohne das hier verlöre die Auswahl ihre Hervorhebung.
    const selectedRow = rowForPath(appStore.selectedPath);
    if (selectedRow) setActiveItem(selectedRow);
    if (view.focusPath) {
      const row = rowForPath(view.focusPath);
      const target = view.focusReference ? row?.querySelector('.tree-item-reference') : row;
      // A focused row that went away hands the focus to the tab stop instead
      // of letting it fall out of the tree (#74).
      (target ?? syncTabStop())?.focus?.();
    }
    treeContainer.scrollTop = view.scrollTop;
  }

  /** Zeichnet die geänderten Ordner neu — von oben nach unten. */
  async function redrawFolders(dirPaths) {
    const view = captureTreeView();
    const expandedBefore = collectExpandedFolderPaths();
    const sorted = sortFoldersTopDown(dirPaths);

    if (sorted.includes(appStore.rootPath)) {
      // Der Root-Zweig zeichnet den ganzen Baum neu und stellt die
      // aufgeklappten Ordner selbst wieder her — alles Weitere erübrigt sich.
      await refreshFolder(appStore.rootPath);
    } else {
      for (const dir of sorted) await refreshFolder(dir);
      // Ein neu gezeichneter Ordner verliert seine aufgeklappten Kinder.
      await restoreExpandedFolders(
        foldersToReexpand({ expandedBefore, redrawn: sorted, rootPath: appStore.rootPath })
      );
    }

    restoreTreeView(view);
    // A write, a delete, a move or an import: the filter shows it too (#350).
    filter.refresh();
  }

  /**
   * Selection and the open file after a watcher report. They are two things:
   * clicking a folder moves the selection, but the pane keeps showing the last
   * file. A vanished selection is cleared; a vanished open file closes the
   * pane — better than a view of nothing. If the folder of the open file
   * reported, the file is read again; which file exactly was written, the
   * watcher does not know.
   */
  async function syncSelection(reportedDirs, complete) {
    // Whatever sits in a collapsed folder has no row to go by: left alone. So
    // does a hidden file while hidden files are off (#436) — it is not gone,
    // only not shown, and its preview stays.
    const inVisibleFolder = (p) =>
      visibleFolderPaths().includes(parentDirOf(p)) && !hiddenByFilter(p);
    const selected = appStore.selectedPath;
    let vanished = null;
    if (selected && inVisibleFolder(selected) && !rowForPath(selected)) {
      vanished = selected;
      clearSelection();
    }

    const openPath = contentPane.openPath();
    if (!openPath) return;
    if (vanished && (openPath === vanished || isInsideDir(openPath, vanished))) {
      await contentPane.close('file-removed');
      return;
    }
    if (!inVisibleFolder(openPath)) return;
    if (!rowForPath(openPath)) {
      await contentPane.close('file-removed');
      return;
    }
    if (complete && !reportedDirs.includes(parentDirOf(openPath))) {
      // The file is the same, but an image it shows may lie in one of the
      // reported folders (#640). The view checks by size and date first.
      await contentPane.revalidate(reportedDirs);
      return;
    }
    await contentPane.refresh(openPath);
  }

  /**
   * Eine Meldung des Watchers abarbeiten. `complete: false` heißt „da war
   * mehr, das sich keinem Ordner zuordnen ließ“ — etwa ein `git`-Wechsel, der
   * halbe Verzeichnisbäume austauscht. Dann wird einmal alles Sichtbare
   * geprüft statt hundertfach einzeln.
   */
  async function syncTreeWithFilesystem({ directories, complete } = {}) {
    if (!appStore.rootPath) return;
    const gemeldet = (Array.isArray(directories) ? directories : []).filter(
      (dir) => typeof dir === 'string' && dir
    );
    const vollstaendig = complete !== false;
    const zuPruefen = foldersToCheck({
      visible: visibleFolderPaths(),
      reported: gemeldet,
      complete: vollstaendig,
    });

    const geaendert = [];
    for (const dir of zuPruefen) {
      if (await folderListingChanged(dir)) geaendert.push(dir);
    }
    if (geaendert.length > 0) await redrawFolders(geaendert);

    await syncSelection(gemeldet, vollstaendig);
  }

  // ── Hidden files (#436) ───────────────────────────────────────────────────
  // One app-wide switch, held in `appStore.showHiddenFiles` so the `@` menu
  // reads the same value. Main filters the listing, including the system noise
  // that stays out either way; the tree asks with the flag and dims the rows
  // that lie in a hidden place.

  const HIDDEN_FILES_SHORTCUT_MAC = '⇧⌘.';

  function hiddenFilesShortcut() {
    return navigator.userAgent.includes('Mac')
      ? HIDDEN_FILES_SHORTCUT_MAC
      : t('sidebar.hiddenFiles.shortcut');
  }

  /**
   * Resolves to null instead of waiting on once the folder changes (#633):
   * the job that asked has nothing left to draw, and the queue moves on to
   * the new folder.
   */
  function listFolder(dirPath) {
    return Promise.race([
      api.readDirectory(dirPath, { showHidden: appStore.showHiddenFiles === true }),
      generationLeft.then(() => null),
    ]);
  }

  /** On disk, but not in the tree because hidden files are switched off. */
  function hiddenByFilter(itemPath) {
    return appStore.showHiddenFiles !== true && isHiddenTreePath(itemPath, appStore.rootPath);
  }

  // The check in the `⋯` menu carries the state (#676), next to the dimmed
  // rows; the label stays "Show hidden files".
  function renderHiddenFilesButton() {
    actionsMenu.setHiddenFilesChecked(appStore.showHiddenFiles === true);
  }

  /**
   * Draws the tree again for the current switch. Open folders, the scroll
   * position and the focus survive; a selection that went into hiding is let
   * go, the file on show stays where it is. Skipped when the tree already
   * matches — two quick presses in a row cancel out.
   */
  async function redrawForHiddenFiles() {
    const root = appStore.rootPath;
    const show = appStore.showHiddenFiles === true;
    if (!root || drawnShowHidden === show) return;
    const view = captureTreeView();
    const expandedBefore = collectExpandedFolderPaths();
    const toExpand = show ? [...expandedBefore, ...expandedHiddenFolders] : expandedBefore;
    expandedHiddenFolders = show ? [] : expandedBefore.filter((p) => isHiddenTreePath(p, root));
    drawnShowHidden = show;
    treeContainer.innerHTML = '';
    await loadTreeLevel(treeContainer, root, 0);
    await restoreExpandedFolders(toExpand);
    if (appStore.selectedPath && hiddenByFilter(appStore.selectedPath)) clearSelection();
    restoreTreeView(view);
  }

  /**
   * Switches hidden files on or off. The button follows at once; the redraw
   * queues behind any watcher report still running, since both rebuild the
   * same DOM. `persist: false` at start-up, where the value comes from the
   * preferences and is no new wish.
   */
  function setShowHiddenFiles(show, { persist = true } = {}) {
    const next = show === true;
    const changed = (appStore.showHiddenFiles === true) !== next;
    appStore.showHiddenFiles = next;
    renderHiddenFilesButton();
    if (!changed) return treeSyncChain;
    // The filter searches what the tree shows (#350).
    filter.refresh();
    return enqueueTreeWork(async () => {
      await redrawForHiddenFiles();
      // What counts is the state once the queue gets here: after two quick
      // presses both writes store the last one. A failed write leaves the
      // tree as asked; only the next start falls back to the stored value.
      if (persist) await api.setUIPrefs({ showHiddenFiles: appStore.showHiddenFiles === true });
    }, 'Hidden files could not be switched');
  }

  function toggleHiddenFiles() {
    return setShowHiddenFiles(appStore.showHiddenFiles !== true);
  }

  // What the header's buttons did until #676.
  const actionsMenu = initTreeActionsMenu({
    actions: {
      filter: () => filter.open(),
      'new-file': () => void beginCreate(createTargetDir(), 'file'),
      'new-folder': () => void beginCreate(createTargetDir(), 'directory'),
      'hidden-files': () => void toggleHiddenFiles(),
    },
    shortcuts: {
      filter: () => filter.shortcut(),
      'hidden-files': hiddenFilesShortcut,
    },
  });
  renderHiddenFilesButton();

  /**
   * Opens or closes a folder row. Its first load runs in the queue (#636) and
   * is shared with a second click while it lasts. The arrow turns at once, so
   * the click shows it was taken, and a slow listing shows itself (#639).
   * The arrow keys open and close without selecting (#74): `select: false`.
   */
  async function toggleFolder(row, childContainer, dirPath, { select = true } = {}) {
    if (select) {
      // Selected before the load: a redraw while it runs puts the highlight
      // on the new row by the path.
      setActiveItem(row);
      appStore.selectedPath = dirPath;
      appStore.selectedIsDirectory = true;
    }

    if (childContainer.classList.contains('expanded')) {
      showExpanded(row, childContainer, false);
      return;
    }
    if (childContainer.dataset.loaded === 'true') {
      showExpanded(row, childContainer, true);
      return;
    }
    showExpanded(row, null, true);
    const opened = await withLoadingState(row, loadFolderOnce(dirPath));
    // A load that failed leaves the folder closed; the arrow turns back.
    if (!opened) showExpanded(row, null, false);
  }

  /**
   * Open or closed, in all three places that say it: the child container,
   * the arrow and aria-expanded (#74). Without a container only the row —
   * the arrow turns ahead of a first load.
   */
  function showExpanded(row, childContainer, expanded) {
    childContainer?.classList.toggle('expanded', expanded);
    row?.querySelector('.arrow')?.classList.toggle('expanded', expanded);
    row?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    // A folder closed over the row that was the tab stop hands it on.
    if (!expanded) syncTabStop();
  }

  function loadFolderOnce(dirPath) {
    let load = folderLoads.get(dirPath);
    if (!load) {
      load = enqueueTreeWork(() => ensureFolderExpanded(dirPath), 'Folder could not be opened')
        .finally(() => folderLoads.delete(dirPath));
      folderLoads.set(dirPath, load);
    }
    return load;
  }

  /**
   * The item for a row opened by path (#348). Size and date are left out:
   * the view reads them itself, the diff has its own pill.
   */
  function itemForRow(row) {
    return { path: row.dataset.path, name: basenameOf(row.dataset.path) };
  }

  async function selectFile(row, item, openOptions) {
    // Die Vorschau lebt in der mittleren Spalte. Ist die zu — beim Start neben
    // einem wiederhergestellten Chat (Issue #208) oder weil sie weggeschaltet
    // wurde —, waere der Klick auf eine Datei sonst folgenlos.
    revealContentPane?.();
    // The selection follows only once the pane shows the file: an editor with
    // unsaved changes may keep it, and a quicker second click overtakes this
    // one — either way the row must not claim a file that is not on show.
    const generation = treeGeneration;
    if (!(await contentPane.open(item, openOptions))) return;
    // Nor a row of a folder left meanwhile (#633).
    if (generation !== treeGeneration) return;
    agentMarks.markSeen(item.path);
    setActiveItem(row);
    appStore.selectedPath = item.path;
    appStore.selectedIsDirectory = false;
  }

  function clearSelection() {
    deselectActiveItem();
    appStore.selectedPath = null;
    appStore.selectedIsDirectory = false;
    appStore.activeTreeItem = null;
  }

  function deselectActiveItem() {
    const row = appStore.activeTreeItem;
    if (!row) return;
    row.classList.remove('active');
    row.setAttribute('aria-selected', 'false');
  }

  function setActiveItem(row) {
    deselectActiveItem();
    row.classList.add('active');
    row.setAttribute('aria-selected', 'true');
    appStore.activeTreeItem = row;
    // Tab comes back to the selection — unless the keyboard is in the tree
    // already, where the focused row keeps the stop (#74).
    if (!treeContainer.contains(document.activeElement)) setTabStop(row);
  }

  /**
   * Sprachwechsel (Epic #277). Der Rahmen des Baums traegt `data-i18n` und
   * wird von `applyTranslations` erledigt; hier stehen die Stellen, die zur
   * Laufzeit gebaut werden — die Beschriftungen der Zeilen und das
   * Verlaufsmenue. Die mittlere Spalte folgt der Sprache in
   * `file-views/host.js`.
   */
  onLocaleChange(() => {
    actionsMenu.renderShortcuts();
    for (const btn of treeContainer.querySelectorAll('.tree-item-reference')) {
      const name = btn.dataset.itemName || '';
      btn.setAttribute('aria-label', t('tree.reference.label', { name }));
      btn.title = referenceTitle();
    }
    for (const note of treeContainer.querySelectorAll('.tree-hidden-entries')) {
      note.textContent = hiddenEntriesText(Number(note.dataset.hiddenCount) || 0);
    }
    for (const note of treeContainer.querySelectorAll('.tree-unreadable')) {
      note.textContent = unreadableText(note.dataset.reason);
    }
    for (const text of treeContainer.querySelectorAll('.tree-loading-text')) {
      text.textContent = t('tree.loading');
    }
    if (!folderHistoryMenu.classList.contains('hidden')) void refreshFolderHistory();
    syncAgentMarks();
  });

  return {
    openProject,
    refreshFolderHistory,
    refreshWelcomeRecent,
    closeFolderHistoryMenu,
    notifyExternalFileWrite,
    /** What the agent read ('read') or changed ('write') in a run (#347). */
    recordAgentFile,
    /** The conversation on screen changed: its marks take the tree (#347). */
    syncAgentMarks,
    /** Opens the diff of a file the chat changed, from under a message (#348). */
    showFileChanges,
    openWorkspaceFile,
    /** Hidden files on or off (#436); resolves once the tree is redrawn. */
    setShowHiddenFiles,
    toggleHiddenFiles,
    /** Opens the tree's filter, or takes its field again (#350). */
    openFilter: () => filter.open(),
    /** The folder's README the column opens with, or null (#351). */
    readableFolderReadme,
    showFolderReadme,
    /** Back and forward through the files the preview showed (#822). */
    previewBack: () => contentPane.goBack(),
    previewForward: () => contentPane.goForward(),
    /** Main's answer to the menu behind ‹ or ›. */
    choosePreviewHistory: (token, index) => contentPane.chooseFromHistory(token, index),
    /** A menu command for the file on show, e.g. 'toggle-source' (#344). */
    runPreviewCommand: (name) => contentPane.runCommand(name),
  };
}
