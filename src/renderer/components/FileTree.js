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
  });
  const projectName = document.getElementById('project-name');
  const btnFolderHistory = document.getElementById('btn-folder-history');
  const btnHiddenFiles = document.getElementById('btn-toggle-hidden-files');
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
    // The marks name paths of the folder left (#347).
    agentMarks.clearAll();
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
    const overtaken = () => ticket !== treeGeneration;
    if (overtaken()) return true;
    appStore.rootPath = folderPath;
    const name = basenameOf(folderPath);
    projectName.textContent = name;
    projectName.title = folderPath;
    document.title = 'Snotra AI';

    // A selection belongs to the folder it was made in: left standing, the
    // next question would tell the model about a file of the folder just
    // left (#633).
    clearSelection();
    contentPane.clear();
    // The folder left goes at once, not when the queue gets round to it: its
    // rows would stay clickable under the new name meanwhile.
    treeContainer.innerHTML = '';
    treeContainer.removeAttribute('aria-busy');

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
    const focusedPath = focused?.dataset.path ?? null;
    folderHistoryRebuilding = true;
    try {
      fillFolderHistory(paths);
    } finally {
      folderHistoryRebuilding = false;
    }
    const items = folderHistoryItems();
    const restored = focused ? items.find((el) => el.dataset.path === focusedPath) : null;
    setCurrentFolderHistoryItem(restored || items[0]);
    restored?.focus();
  }

  function fillFolderHistory(paths) {
    folderHistoryMenu.innerHTML = '';
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
    const neighbour = row?.nextElementSibling || row?.previousElementSibling || null;
    const neighbourPath = neighbour?.dataset?.path || null;

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
    const target = items.find((el) => el.dataset.path === neighbourPath) || items[0] || btnFolderHistory;
    target.focus();
  }

  function openFolderHistoryMenu() {
    folderHistoryMenu.classList.remove('hidden');
    folderHistoryMenu.setAttribute('aria-hidden', 'false');
    btnFolderHistory.setAttribute('aria-expanded', 'true');
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
    btnFolderHistory.setAttribute('aria-expanded', 'false');
    if (focusButton) btnFolderHistory.focus();
  }

  btnFolderHistory.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isOpen = btnFolderHistory.getAttribute('aria-expanded') === 'true';
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
    ownsTarget: (t) => folderHistoryMenu.contains(t) || btnFolderHistory.contains(t),
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
      parentEl.appendChild(buildUnreadableNote(unreadable, depth));
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

    if (hidden > 0) parentEl.appendChild(buildHiddenEntriesNote(hidden, depth));

    // A complete listing tells which marked entries are gone — deleted,
    // renamed or moved, by whoever (#347). One cut at the cap (#76) does not.
    if (hidden === 0) {
      agentMarks.pruneListing(dirPath, items.map((item) => item.path), hiddenByFilter);
    }
    applyAgentMarks(parentEl.querySelectorAll(':scope > .tree-item'));
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
    btn.title = t('tree.reference');
    btn.innerHTML = svgAt();
    btn.addEventListener('click', (e) => {
      // Ohne stopPropagation würde die Zeile zusätzlich auswählen bzw. aufklappen.
      e.preventDefault();
      e.stopPropagation();
      referenceInChat(item);
    });
    return btn;
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
  async function openFileContextMenu(item) {
    try {
      const result = await api.showFileContextMenu(item.path, {
        agentMark: Boolean(rowForPath(item.path)?.querySelector(':scope > .tree-mark')),
      });
      if (result?.error) console.warn('Context menu refused:', result.error);
    } catch (err) {
      console.warn('Context menu failed:', err?.message ?? err);
    }
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
    const arrow = row.querySelector('.arrow');
    const depth = loadDepthFromTreeRow(row);
    childContainer.innerHTML = '';
    await loadTreeLevel(childContainer, dirPath, depth);
    childContainer.dataset.loaded = 'true';
    childContainer.classList.add('expanded');
    if (arrow) arrow.classList.add('expanded');
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
    childContainer.classList.add('expanded');
    row?.querySelector('.arrow')?.classList.add('expanded');
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
  async function openFromPreview(targetPath) {
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
      row.click();
      return { ok: true };
    }

    // Not drawn: either it does not exist, or the listing left it out (#76) —
    // or the link spells the name in another case than the disk. Whatever
    // reads, is shown; the tree then has no row to mark.
    const probe = await api.readFile(targetPath);
    if (stale()) return { ok: false, reason: 'stale' };
    if (!probe || probe.error) {
      return { ok: false, reason: 'not-found' };
    }
    const shown = await contentPane.open({
      path: targetPath,
      name: basenameOf(targetPath),
      size: probe.size,
      modified: probe.modified,
    });
    if (stale()) return { ok: false, reason: 'stale' };
    if (shown) {
      agentMarks.markSeen(targetPath);
      appStore.activeTreeItem?.classList.remove('active');
      appStore.activeTreeItem = null;
      appStore.selectedPath = targetPath;
      appStore.selectedIsDirectory = false;
    }
    return { ok: true };
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
      if (wasExpanded) {
        childContainer.classList.add('expanded');
        const arrow = row?.querySelector('.arrow');
        if (arrow) arrow.classList.add('expanded');
      }
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
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('span');
      el.className = 'tree-mark';
      // Not colour alone, nor the letter alone: the label says it in words.
      el.setAttribute('role', 'img');
      row.insertBefore(el, row.querySelector(':scope > .tree-item-reference'));
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
  }

  /**
   * A tool of the chat `chatId` read or changed `relativePath`. ChatStream
   * passes only runs in the open folder; the path is the tool's, relative.
   */
  function recordAgentFile(kind, relativePath, chatId) {
    const path = markPathFor(appStore.rootPath, relativePath);
    if (!path || !chatId) return;
    if (kind === 'write') agentMarks.recordWrite(chatId, path);
    else agentMarks.recordRead(chatId, path);
  }

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
    btnHiddenFiles?.focus();
  });

  api.onFsClearAgentMark?.(({ path } = {}) => {
    if (typeof path === 'string' && path) agentMarks.clear(appStore.currentChatId, path);
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
      target?.focus?.();
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

  // The label stays "Show hidden files" and aria-pressed carries the state;
  // the title names what a click does next, with the shortcut.
  function renderHiddenFilesButton() {
    if (!btnHiddenFiles) return;
    const on = appStore.showHiddenFiles === true;
    btnHiddenFiles.setAttribute('aria-pressed', on ? 'true' : 'false');
    const action = t(on ? 'sidebar.hiddenFiles.hide' : 'sidebar.hiddenFiles.show');
    btnHiddenFiles.title = `${action} (${hiddenFilesShortcut()})`;
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

  btnHiddenFiles?.addEventListener('click', () => {
    void toggleHiddenFiles();
  });
  renderHiddenFilesButton();

  /**
   * Opens or closes a folder row. Its first load runs in the queue (#636) and
   * is shared with a second click while it lasts. The arrow turns at once, so
   * the click shows it was taken, and a slow listing shows itself (#639).
   */
  async function toggleFolder(row, childContainer, dirPath) {
    const arrow = row.querySelector('.arrow');
    // Selected before the load: a redraw while it runs puts the highlight on
    // the new row by the path.
    setActiveItem(row);
    appStore.selectedPath = dirPath;
    appStore.selectedIsDirectory = true;

    if (childContainer.classList.contains('expanded')) {
      childContainer.classList.remove('expanded');
      arrow.classList.remove('expanded');
      return;
    }
    if (childContainer.dataset.loaded === 'true') {
      childContainer.classList.add('expanded');
      arrow.classList.add('expanded');
      return;
    }
    arrow.classList.add('expanded');
    const opened = await withLoadingState(row, loadFolderOnce(dirPath));
    // A load that failed leaves the folder closed; the arrow turns back.
    if (!opened) arrow.classList.remove('expanded');
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

  async function selectFile(row, item) {
    // Die Vorschau lebt in der mittleren Spalte. Ist die zu — beim Start neben
    // einem wiederhergestellten Chat (Issue #208) oder weil sie weggeschaltet
    // wurde —, waere der Klick auf eine Datei sonst folgenlos.
    revealContentPane?.();
    // The selection follows only once the pane shows the file: an editor with
    // unsaved changes may keep it, and a quicker second click overtakes this
    // one — either way the row must not claim a file that is not on show.
    const generation = treeGeneration;
    if (!(await contentPane.open(item))) return;
    // Nor a row of a folder left meanwhile (#633).
    if (generation !== treeGeneration) return;
    agentMarks.markSeen(item.path);
    setActiveItem(row);
    appStore.selectedPath = item.path;
    appStore.selectedIsDirectory = false;
  }

  function clearSelection() {
    appStore.selectedPath = null;
    appStore.selectedIsDirectory = false;
    appStore.activeTreeItem = null;
  }

  function setActiveItem(row) {
    if (appStore.activeTreeItem) {
      appStore.activeTreeItem.classList.remove('active');
    }
    row.classList.add('active');
    appStore.activeTreeItem = row;
  }

  /**
   * Sprachwechsel (Epic #277). Der Rahmen des Baums traegt `data-i18n` und
   * wird von `applyTranslations` erledigt; hier stehen die Stellen, die zur
   * Laufzeit gebaut werden — die Beschriftungen der Zeilen und das
   * Verlaufsmenue. Die mittlere Spalte folgt der Sprache in
   * `file-views/host.js`.
   */
  onLocaleChange(() => {
    if (!appStore.rootPath) projectName.textContent = t('sidebar.noFolder');
    renderHiddenFilesButton();
    for (const btn of treeContainer.querySelectorAll('.tree-item-reference')) {
      const name = btn.dataset.itemName || '';
      btn.setAttribute('aria-label', t('tree.reference.label', { name }));
      btn.title = t('tree.reference');
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
    /** Hidden files on or off (#436); resolves once the tree is redrawn. */
    setShowHiddenFiles,
    toggleHiddenFiles,
    /** A menu command for the file on show, e.g. 'toggle-source' (#344). */
    runPreviewCommand: (name) => contentPane.runCommand(name),
  };
}
