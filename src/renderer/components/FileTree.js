import { t, tPlural, onLocaleChange } from '../i18n.js';
import {
  formatCount,
  svgAt,
  svgChevron,
  svgFolder,
  svgFile,
  dismissOnOutsideClick,
} from '../utils/helpers.js';
import { basenameOf, parentDirOf, joinNative, isInsideDir } from '../utils/nativePath.js';
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
  } = deps;

  const treeContainer = document.getElementById('tree-container');
  // What the middle column shows for a file is the business of the file views
  // (#225); the tree only says which file, and when it changed or went away.
  const contentPane = createFileViewHost({ api, registry: fileViews, confirmLeave });
  const projectName = document.getElementById('project-name');
  const btnFolderHistory = document.getElementById('btn-folder-history');
  const folderHistoryMenu = document.getElementById('folder-history-menu');
  const welcomeRecentSection = document.getElementById('welcome-recent');
  const welcomeRecentList = document.getElementById('welcome-recent-list');
  const welcomeActionsList = document.getElementById('welcome-actions-list');
  const chatInput = document.getElementById('chat-input');


  // Meldungen des Dateisystem-Watchers laufen nacheinander ab (Issue #158).
  let treeSyncChain = Promise.resolve();

  // Drag-&-Drop-State lebt komplett in diesem Component; resetDragState()
  // ist der einzige Aufräumpfad, damit keine Row-Referenzen hängenbleiben.
  let dragSourcePath = null;
  let dragSourceRow = null;
  let currentDropTarget = null;
  // Laeuft gerade ein Import von aussen? Verhindert einen zweiten Drop,
  // waehrend noch kopiert wird (#101).
  let importInFlight = false;

  function resetDragState() {
    clearDragVisualState();
    dragSourcePath = null;
    dragSourceRow = null;
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
    for (const p of top) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip chip--recent';
      btn.setAttribute('role', 'listitem');
      btn.title = p;

      const main = document.createElement('span');
      main.className = 'chip-recent-main';

      const name = document.createElement('span');
      name.className = 'chip-recent-name';
      name.textContent = basenameOf(p);

      const sub = document.createElement('span');
      sub.className = 'chip-recent-path';
      sub.textContent = p;

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
      welcomeRecentList.appendChild(btn);
    }
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
   */
  async function openProject(folderPath) {
    // Unsaved changes in an editor are settled before main switches folders;
    // afterwards the file they belong to is out of reach.
    if (!(await contentPane.settleUnsaved('switch-folder'))) return false;
    const activated = await api.activateFolder(folderPath);
    if (!activated?.ok) {
      await refreshFolderHistory();
      await refreshWelcomeRecent();
      return false;
    }
    const workspaceChanged = appStore.rootPath !== folderPath;
    appStore.rootPath = folderPath;
    const name = basenameOf(folderPath);
    projectName.textContent = name;
    projectName.title = folderPath;
    document.title = 'Snotra AI';

    treeContainer.innerHTML = '';
    contentPane.clear();

    await loadTreeLevel(treeContainer, folderPath, 0);
    if (workspaceChanged) {
      await onWorkspaceChanged?.(folderPath, workspaceChanged);
    }
    refreshFolderHistory();
    refreshWelcomeRecent();
    onProjectOpened?.();
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

  function renderFolderHistory(paths) {
    folderHistoryMenu.innerHTML = '';
    if (!paths.length) {
      const empty = document.createElement('div');
      empty.className = 'folder-history-empty';
      empty.textContent = t('sidebar.history.empty');
      folderHistoryMenu.appendChild(empty);
      return;
    }
    for (const p of paths) {
      const displayName = basenameOf(p);

      // Kein <button> mehr: Der Entfernen-Button (Issue #57) läge sonst in
      // einem Button verschachtelt (ungültiges HTML). Stattdessen eine Zeile
      // mit role=menuitem und Tastatur-Handling wie im ChatHistoryPanel.
      const row = document.createElement('div');
      row.className = 'folder-history-item';
      row.setAttribute('role', 'menuitem');
      row.tabIndex = 0;
      row.title = p;
      row.dataset.path = p;

      const main = document.createElement('span');
      main.className = 'folder-history-item-main';

      const name = document.createElement('span');
      name.className = 'folder-history-name';
      name.textContent = displayName;

      const sub = document.createElement('span');
      sub.className = 'folder-history-path';
      sub.textContent = p;

      main.appendChild(name);
      main.appendChild(sub);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'folder-history-item-remove';
      remove.title = t('sidebar.history.remove');
      remove.setAttribute('aria-label', t('sidebar.history.remove.label', { name: displayName }));
      remove.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

      row.appendChild(main);
      row.appendChild(remove);

      const openThis = () => {
        closeFolderHistoryMenu();
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
    }
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
    const items = [...folderHistoryMenu.querySelectorAll('.folder-history-item')];
    const target = items.find((el) => el.dataset.path === neighbourPath) || items[0] || btnFolderHistory;
    target.focus();
  }

  function openFolderHistoryMenu() {
    folderHistoryMenu.classList.remove('hidden');
    folderHistoryMenu.setAttribute('aria-hidden', 'false');
    btnFolderHistory.setAttribute('aria-expanded', 'true');
  }

  function closeFolderHistoryMenu() {
    folderHistoryMenu.classList.add('hidden');
    folderHistoryMenu.setAttribute('aria-hidden', 'true');
    btnFolderHistory.setAttribute('aria-expanded', 'false');
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

  dismissOnOutsideClick({
    isOpen: () => !folderHistoryMenu.classList.contains('hidden'),
    ownsTarget: (t) => folderHistoryMenu.contains(t) || btnFolderHistory.contains(t),
    onDismiss: closeFolderHistoryMenu,
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
      const sources = externalSourcePathsFrom(e.dataTransfer);
      clearDragVisualState();
      await importExternalItems(sources, importDestDirFor(overItem?.dataset, appStore.rootPath));
      return;
    }
    clearDragVisualState();
    if (!dragSourcePath) return;
    e.preventDefault();
    const sourcePath = dragSourcePath;
    if (!sourcePath) return;
    const expandedBefore = collectExpandedFolderPaths();
    const result = await api.moveItem(sourcePath, appStore.rootPath);
    if (result.error) {
      console.error('Move failed:', result.error);
      clearDragVisualState();
      return;
    }
    treeContainer.innerHTML = '';
    await loadTreeLevel(treeContainer, appStore.rootPath, 0);
    await restoreExpandedFolders(expandedBefore);
    clearDragVisualState();
  });

  async function loadTreeLevel(parentEl, dirPath, depth) {
    const { entries: items = [], hidden = 0 } = (await api.readDirectory(dirPath)) || {};

    for (const item of items) {
      const row = document.createElement('div');
      row.classList.add('tree-item');
      row.dataset.path = item.path;
      row.dataset.isDirectory = item.isDirectory;
      row.setAttribute('draggable', 'true');

      const indent = document.createElement('span');
      indent.classList.add('indent');
      indent.style.width = `${depth * 16 + 4}px`;
      row.appendChild(indent);

      const arrow = document.createElement('span');
      arrow.classList.add('arrow');
      if (item.isDirectory) {
        arrow.innerHTML = svgChevron();
      } else {
        arrow.classList.add('hidden');
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
          toggleFolder(row, childContainer, item.path, depth + 1);
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
    // Lined up with the file names above it (a file row has no arrow):
    // indent + icon + its gap.
    note.style.paddingLeft = `${depth * 16 + 4 + 16 + 4}px`;
    note.textContent = hiddenEntriesText(hidden);
    return note;
  }

  function hiddenEntriesText(hidden) {
    return tPlural('tree.hiddenEntries', hidden, { count: formatCount(hidden) });
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
    treeSyncChain = treeSyncChain
      .then(() => syncTreeWithFilesystem(payload))
      .catch((err) => console.warn('Baum-Abgleich fehlgeschlagen:', err?.message ?? err));
  });

  async function handleFsItemDeleted(deletedPath) {
    if (!appStore.rootPath || typeof deletedPath !== 'string' || !deletedPath) return;
    // Bei einem gelöschten Ordner (#120) ist auch die Vorschau einer Datei
    // darin hinfällig, nicht nur die des gelöschten Eintrags selbst.
    if (appStore.selectedPath === deletedPath || isInsideDir(appStore.selectedPath, deletedPath)) {
      clearSelection();
    }
    const openPath = contentPane.openPath();
    if (openPath === deletedPath || isInsideDir(openPath, deletedPath)) {
      await contentPane.close('file-removed');
    }
    await refreshParentOf(deletedPath);
  }

  // Issue #58: natives Kontextmenü (Öffnen / Im Finder bzw. Explorer anzeigen / Löschen).
  // Das Menü selbst baut der Main-Prozess, hier wird nur der Pfad übergeben —
  // dazu die Information, ob es ein Ordner ist, damit „Öffnen“ entfällt (#120).
  async function openFileContextMenu(item) {
    try {
      const result = await api.showFileContextMenu(item.path, { isDirectory: Boolean(item.isDirectory) });
      if (result?.error) console.warn('Context menu refused:', result.error);
    } catch (err) {
      console.warn('Context menu failed:', err?.message ?? err);
    }
  }

  function handleDragOver(e) {
    const external = isExternalFileDrop(e.dataTransfer?.types, Boolean(dragSourcePath));
    if (external && !appStore.rootPath) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = external ? 'copy' : 'move';
  }

  function handleDragEnter(e) {
    const external = isExternalFileDrop(e.dataTransfer?.types, Boolean(dragSourcePath));
    if (external && !appStore.rootPath) return;
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

  async function handleDrop(e, destDir, dropRow, depth) {
    e.preventDefault();
    e.stopPropagation();

    if (isExternalFileDrop(e.dataTransfer?.types, Boolean(dragSourcePath))) {
      // Synchron aus dem DataTransfer lesen, bevor irgendetwas awaitet wird.
      const sources = externalSourcePathsFrom(e.dataTransfer);
      clearDragVisualState();
      await importExternalItems(sources, importDestDirFor(dropRow?.dataset, appStore.rootPath));
      return;
    }

    clearDragVisualState();

    const sourcePath = dragSourcePath || e.dataTransfer.getData('text/plain');
    if (!sourcePath || sourcePath === destDir) return;

    const expandedBefore = collectExpandedFolderPaths();
    const result = await api.moveItem(sourcePath, destDir);
    if (result.error) {
      console.error('Move failed:', result.error);
      clearDragVisualState();
      return;
    }

    const sourceParent = parentDirFromItemPath(sourcePath);
    await refreshParentOf(sourcePath);
    if (sourceParent !== destDir) {
      await refreshFolder(destDir);
    }
    await restoreExpandedFolders(expandedBefore);
    clearDragVisualState();
  }

  /**
   * Uebersetzt die gedroppten Dateien in echte Pfade. Muss synchron laufen:
   * nach dem ersten await ist das DataTransfer leer. Eintraege ohne Pfad
   * stammen nicht aus dem Dateisystem (z. B. Drag aus dem Browser).
   */
  function externalSourcePathsFrom(dataTransfer) {
    const files = Array.from(dataTransfer?.files ?? []);
    return files.map((file) => api.getPathForFile?.(file) ?? '').filter((p) => typeof p === 'string' && p);
  }

  /**
   * Issue #101: Dateien und Ordner von aussen uebernehmen. Der Renderer waehlt
   * nur den Zielordner — geprueft, bestaetigt und kopiert wird im Main-Prozess,
   * der Fehler auch selbst nativ meldet.
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

  async function refreshAfterImport(destDir) {
    if (destDir === appStore.rootPath) {
      // refreshFolder stellt fuer den Root die aufgeklappten Ordner selbst wieder her.
      await refreshFolder(destDir);
      return;
    }
    const expandedBefore = collectExpandedFolderPaths();
    await refreshFolder(destDir);
    await restoreExpandedFolders(expandedBefore);
    await expandFolderAtPath(destDir);
  }

  async function refreshParentOf(itemPath) {
    await refreshFolder(parentDirOf(itemPath));
  }

  // Wird nach einem write_file_text-Tool-Aufruf (KI hat eine Datei angelegt/
  // überschrieben) aus app.js gerufen, damit Baum und Vorschau ohne manuelles
  // Neuladen den aktuellen Stand zeigen.
  async function notifyExternalFileWrite(relativePath) {
    if (!appStore.rootPath || typeof relativePath !== 'string') return;
    const rel = relativePath.trim().replace(/^\.\/?/, '').replace(/^\/+/, '');
    if (!rel) return;
    // Relativer POSIX-Pfad aus dem Tool + nativer Workspace-Pfad -> der
    // Ergebnispfad muss dem Stil der Baum-Einträge entsprechen (Windows: `\`),
    // sonst schlägt der Vergleich mit appStore.selectedPath fehl (#73).
    const absPath = joinNative(appStore.rootPath, rel);

    await refreshParentOf(absPath);
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
    const { entries: items = [], hidden = 0 } = (await api.readDirectory(dirPath)) || {};
    const jetzt = items.map((item) => listingSignature(item.path, item.isDirectory));
    const vorher = rows.map((row) => listingSignature(row.dataset.path, row.dataset.isDirectory === 'true'));
    // Past the cap the drawn rows can stay the same while the count behind them moves.
    return listingsDiffer(jetzt, vorher) || hidden !== hiddenCountOfFolder(dirPath);
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
      scrollTop: treeContainer.scrollTop,
      focusPath: inTree?.closest('.tree-item')?.dataset?.path ?? null,
      focusReference: Boolean(inTree?.classList?.contains('tree-item-reference')),
    };
  }

  function restoreTreeView(view) {
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
    // Whatever sits in a collapsed folder has no row to go by: left alone.
    const inVisibleFolder = (p) => visibleFolderPaths().includes(parentDirOf(p));
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
    if (complete && !reportedDirs.includes(parentDirOf(openPath))) return;
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

  async function toggleFolder(row, childContainer, dirPath, depth) {
    const arrow = row.querySelector('.arrow');
    const isExpanded = childContainer.classList.contains('expanded');

    if (isExpanded) {
      childContainer.classList.remove('expanded');
      arrow.classList.remove('expanded');
    } else {
      if (childContainer.dataset.loaded === 'false') {
        await loadTreeLevel(childContainer, dirPath, depth);
        childContainer.dataset.loaded = 'true';
      }
      childContainer.classList.add('expanded');
      arrow.classList.add('expanded');
    }

    setActiveItem(row);
    appStore.selectedPath = dirPath;
    appStore.selectedIsDirectory = true;
  }

  async function selectFile(row, item) {
    // Die Vorschau lebt in der mittleren Spalte. Ist die zu — beim Start neben
    // einem wiederhergestellten Chat (Issue #208) oder weil sie weggeschaltet
    // wurde —, waere der Klick auf eine Datei sonst folgenlos.
    revealContentPane?.();
    // The selection follows only once the pane shows the file: an editor with
    // unsaved changes may keep it, and a quicker second click overtakes this
    // one — either way the row must not claim a file that is not on show.
    if (!(await contentPane.open(item))) return;
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
    for (const btn of treeContainer.querySelectorAll('.tree-item-reference')) {
      const name = btn.dataset.itemName || '';
      btn.setAttribute('aria-label', t('tree.reference.label', { name }));
      btn.title = t('tree.reference');
    }
    for (const note of treeContainer.querySelectorAll('.tree-hidden-entries')) {
      note.textContent = hiddenEntriesText(Number(note.dataset.hiddenCount) || 0);
    }
    if (!folderHistoryMenu.classList.contains('hidden')) void refreshFolderHistory();
  });

  return {
    openProject,
    refreshFolderHistory,
    refreshWelcomeRecent,
    closeFolderHistoryMenu,
    notifyExternalFileWrite,
  };
}
