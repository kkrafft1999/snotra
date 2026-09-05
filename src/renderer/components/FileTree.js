import {
  isTextFile,
  getExtension,
  formatSize,
  svgChevron,
  svgFolder,
  svgFile,
  dismissOnOutsideClick,
} from '../utils/helpers.js';

/** Reine Hilfen für den Dateibaum (Phase 4.6.2 — Extraktion ohne DOM). */

export function folderDepthSortKey(dirPath) {
  return dirPath.split('/').filter(Boolean).length;
}

export function parentDirFromItemPath(itemPath) {
  const parts = itemPath.split('/');
  parts.pop();
  return parts.join('/') || '/';
}

const QUICK_ACTION_PROMPTS = {
  analyse:
    'Erklaere mir die Struktur dieses Projekts: Welche Hauptordner gibt es, was machen sie, und wie ist der Code organisiert?',
  review:
    'Mach einen Code-Review der wichtigsten Dateien in diesem Projekt. Achte auf Architektur, Wartbarkeit und Auffaelligkeiten.',
  test:
    'Welche Tests sollten in diesem Projekt ergaenzt werden? Schlage konkrete Test-Faelle fuer die kritischen Code-Pfade vor.',
  doc:
    'Fasse zusammen, worum es in diesem Projekt geht. Nutze README, package.json und die wichtigsten Quellen.',
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
  } = deps;

  const treeContainer = document.getElementById('tree-container');
  const welcomeEl = document.getElementById('welcome');
  const filePreview = document.getElementById('file-preview');
  const fileInfo = document.getElementById('file-info');
  const previewFilename = document.getElementById('preview-filename');
  const previewMeta = document.getElementById('preview-meta');
  const previewContent = document.getElementById('preview-content');
  const infoFilename = document.getElementById('info-filename');
  const infoSize = document.getElementById('info-size');
  const infoModified = document.getElementById('info-modified');
  const infoType = document.getElementById('info-type');
  const projectName = document.getElementById('project-name');
  const btnFolderHistory = document.getElementById('btn-folder-history');
  const folderHistoryMenu = document.getElementById('folder-history-menu');
  const welcomeRecentSection = document.getElementById('welcome-recent');
  const welcomeRecentList = document.getElementById('welcome-recent-list');
  const welcomeActionsList = document.getElementById('welcome-actions-list');
  const chatInput = document.getElementById('chat-input');

  let historyDrawerCloseOnEscape = null;

  // Drag-&-Drop-State lebt komplett in diesem Component; resetDragState()
  // ist der einzige Aufräumpfad, damit keine Row-Referenzen hängenbleiben.
  let dragSourcePath = null;
  let dragSourceRow = null;
  let currentDropTarget = null;

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
      name.textContent = p.split('/').pop() || p;

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
      const prompt = QUICK_ACTION_PROMPTS[action];
      if (!prompt) return;
      chatInput.value = prompt;
      onInputChanged?.();
      chatInput.focus();
      if (appStore.rootPath && activeProviderConfigured()) {
        sendChatMessage();
      }
    });
  }

  async function openProject(folderPath) {
    const workspaceChanged = appStore.rootPath !== folderPath;
    appStore.rootPath = folderPath;
    const name = folderPath.split('/').pop() || folderPath;
    projectName.textContent = name;
    projectName.title = folderPath;
    document.title = 'Snotra AI';

    treeContainer.innerHTML = '';
    showWelcome();

    await api.setLastFolder(folderPath);
    await loadTreeLevel(treeContainer, folderPath, 0);
    if (workspaceChanged) {
      await onWorkspaceChanged?.(folderPath, workspaceChanged);
    }
    refreshFolderHistory();
    refreshWelcomeRecent();
    onProjectOpened?.();
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
      empty.textContent = 'Noch keine zuletzt geöffneten Ordner.';
      folderHistoryMenu.appendChild(empty);
      return;
    }
    for (const p of paths) {
      const displayName = p.split('/').pop() || p;

      // Kein <button> mehr: Der Entfernen-Button (Issue #57) läge sonst in
      // einem Button verschachtelt (ungültiges HTML). Stattdessen eine Zeile
      // mit role=menuitem und Tastatur-Handling wie im ChatHistoryDrawer.
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
      remove.title = 'Aus Verlauf entfernen';
      remove.setAttribute('aria-label', `${displayName} aus Verlauf entfernen`);
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
    // Phase 5 (Review #21): Escape schliesst auch den Chat-History-Drawer.
    // Reihenfolge: Folder-History zuerst, dann Chat-History.
    if (!folderHistoryMenu.classList.contains('hidden')) {
      closeFolderHistoryMenu();
      return;
    }
    if (typeof historyDrawerCloseOnEscape === 'function') {
      historyDrawerCloseOnEscape();
    }
  });

  // Ordner und leere Fläche haben (noch) kein Kontextmenü, siehe Issue #58.
  treeContainer.addEventListener('contextmenu', (e) => e.preventDefault());

  treeContainer.addEventListener('dragover', (e) => {
    if (!appStore.rootPath || !dragSourcePath) return;
    const overItem = e.target.closest('.tree-item');
    if (overItem && overItem.dataset.isDirectory === 'true') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    treeContainer.classList.add('drop-target-root');
  });

  treeContainer.addEventListener('dragleave', (e) => {
    if (!treeContainer.contains(e.relatedTarget)) {
      treeContainer.classList.remove('drop-target-root');
    }
  });

  treeContainer.addEventListener('drop', async (e) => {
    clearDragVisualState();
    if (!appStore.rootPath || !dragSourcePath) return;
    const overItem = e.target.closest('.tree-item');
    if (overItem && overItem.dataset.isDirectory === 'true') return;
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
    const items = await api.readDirectory(dirPath);

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

      row.addEventListener('dragstart', (e) => {
        dragSourcePath = item.path;
        dragSourceRow = row;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.path);
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

        row.addEventListener('click', () => toggleFolder(row, childContainer, item.path, depth + 1));
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
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void openFileContextMenu(item);
        });
      }
    }
  }

  // Issue #59: Main hat eine Datei über das Kontextmenü in den Papierkorb gelegt.
  // Baum nachziehen; war die Datei ausgewählt, Vorschau schließen.
  api.onFsItemDeleted?.(({ path: deletedPath } = {}) => {
    void handleFsItemDeleted(deletedPath);
  });

  async function handleFsItemDeleted(deletedPath) {
    if (!appStore.rootPath || typeof deletedPath !== 'string' || !deletedPath) return;
    if (appStore.selectedPath === deletedPath) {
      appStore.selectedPath = null;
      appStore.selectedIsDirectory = false;
      appStore.activeTreeItem = null;
      showWelcome();
    }
    await refreshParentOf(deletedPath);
  }

  // Issue #58: natives Kontextmenü (Öffnen / Im Finder bzw. Explorer anzeigen / Löschen).
  // Das Menü selbst baut der Main-Prozess, hier wird nur der Pfad übergeben.
  async function openFileContextMenu(item) {
    try {
      const result = await api.showFileContextMenu(item.path);
      if (result?.error) console.warn('Kontextmenü abgelehnt:', result.error);
    } catch (err) {
      console.warn('Kontextmenü fehlgeschlagen:', err?.message ?? err);
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }

  function handleDragEnter(e) {
    e.preventDefault();
    const row = e.currentTarget;
    if (row === dragSourceRow) return;
    clearDropTarget();
    row.classList.add('drop-target');
    currentDropTarget = row;
  }

  function handleDragLeave(e) {
    const row = e.currentTarget;
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove('drop-target');
      if (currentDropTarget === row) currentDropTarget = null;
    }
  }

  function clearDropTarget() {
    if (currentDropTarget) {
      currentDropTarget.classList.remove('drop-target');
      currentDropTarget = null;
    }
  }

  function clearDragVisualState() {
    treeContainer.classList.remove('drop-target-root');
    for (const el of treeContainer.querySelectorAll('.tree-item.drop-target')) {
      el.classList.remove('drop-target');
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
    const unique = [...new Set(paths)].sort(
      (a, b) => folderDepthSortKey(a) - folderDepthSortKey(b)
    );
    for (const p of unique) {
      await expandFolderAtPath(p);
    }
  }

  function loadDepthFromTreeRow(row) {
    if (!row) return 1;
    const w = parseInt(row.querySelector('.indent')?.style.width || '4', 10);
    return Math.round(w / 16) + 1;
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

  async function refreshParentOf(itemPath) {
    const parts = itemPath.split('/');
    parts.pop();
    const parentDir = parts.join('/') || '/';
    await refreshFolder(parentDir);
  }

  // Wird nach einem write_file_text-Tool-Aufruf (KI hat eine Datei angelegt/
  // überschrieben) aus app.js gerufen, damit Baum und Vorschau ohne manuelles
  // Neuladen den aktuellen Stand zeigen.
  async function notifyExternalFileWrite(relativePath) {
    if (!appStore.rootPath || typeof relativePath !== 'string') return;
    const rel = relativePath.trim().replace(/^\.\/?/, '').replace(/^\/+/, '');
    if (!rel) return;
    const rootPath = appStore.rootPath.replace(/\/$/, '');
    const absPath = `${rootPath}/${rel}`;

    await refreshParentOf(absPath);

    if (appStore.selectedPath === absPath && !appStore.selectedIsDirectory) {
      const result = await api.readFile(absPath);
      if (!result.error) {
        welcomeEl.classList.add('hidden');
        filePreview.classList.remove('hidden');
        fileInfo.classList.add('hidden');
        previewFilename.textContent = absPath.split('/').pop() || absPath;
        previewMeta.textContent = formatSize(result.size);
        previewContent.textContent = result.content;
      }
    }
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
    setActiveItem(row);
    appStore.selectedPath = item.path;
    appStore.selectedIsDirectory = false;
    await showFileContent(item);
  }

  function setActiveItem(row) {
    if (appStore.activeTreeItem) {
      appStore.activeTreeItem.classList.remove('active');
    }
    row.classList.add('active');
    appStore.activeTreeItem = row;
  }

  function showWelcome() {
    welcomeEl.classList.remove('hidden');
    filePreview.classList.add('hidden');
    fileInfo.classList.add('hidden');
  }

  async function showFileContent(item) {
    welcomeEl.classList.add('hidden');

    if (isTextFile(item.name)) {
      const result = await api.readFile(item.path);

      if (result.error) {
        showFileInfo(item, result.error);
        return;
      }

      filePreview.classList.remove('hidden');
      fileInfo.classList.add('hidden');
      previewFilename.textContent = item.name;
      previewMeta.textContent = formatSize(result.size);
      previewContent.textContent = result.content;
    } else {
      showFileInfo(item);
    }
  }

  function showFileInfo(item, errorMsg) {
    filePreview.classList.add('hidden');
    fileInfo.classList.remove('hidden');
    infoFilename.textContent = item.name;
    infoSize.textContent = errorMsg || formatSize(item.size);
    infoModified.textContent = new Date(item.modified).toLocaleString('de-DE');
    infoType.textContent = getExtension(item.name) || 'Unbekannt';
  }

  function setHistoryDrawerCloseOnEscape(fn) {
    historyDrawerCloseOnEscape = typeof fn === 'function' ? fn : null;
  }

  return {
    openProject,
    refreshFolderHistory,
    refreshWelcomeRecent,
    setHistoryDrawerCloseOnEscape,
    closeFolderHistoryMenu,
    notifyExternalFileWrite,
  };
}
