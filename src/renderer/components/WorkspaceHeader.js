import { t, onLocaleChange } from '../i18n.js';
import { basenameOf } from '../utils/nativePath.js';
import { tildePath } from '../utils/program-allowance-view.js';
import { fitMiddle } from '../utils/middleEllipsis.js';

/**
 * Where the open workspace is named (#676): in the title bar, on the switcher
 * at the top of the tree with its path underneath, and in the window's title.
 * The agent reads, writes and runs commands in that folder, so it has to be
 * plain which one it is in every layout — sidebar open or hidden, wide or at
 * its minimum.
 *
 * Name and path are cut in the middle when they do not fit, and fitted again
 * whenever the header changes width. The switcher's label carries both whole,
 * so the path is there for the keyboard and a screen reader too.
 */
export function initWorkspaceHeader({ getHomeDir = () => '', subscribeHomeDir } = {}) {
  const switcher = document.getElementById('btn-workspace');
  const nameEl = document.getElementById('project-name');
  const pathEls = ['project-path', 'project-path-narrow']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const titlebarWorkspace = document.getElementById('titlebar-workspace');
  const titlebarName = document.getElementById('titlebar-workspace-name');
  const header = document.getElementById('tree-header');

  let rootPath = null;

  const displayPath = () => tildePath(rootPath, getHomeDir());

  /** Name and path into their boxes, cut where they have to be. */
  function fit() {
    if (!rootPath) {
      nameEl.textContent = t('sidebar.noFolder');
      return;
    }
    fitMiddle(nameEl, basenameOf(rootPath));
    const path = displayPath();
    for (const el of pathEls) {
      if (el.getClientRects().length > 0) fitMiddle(el, path);
      else el.textContent = path;
    }
  }

  function render() {
    const open = Boolean(rootPath);
    const name = open ? basenameOf(rootPath) : '';
    for (const el of pathEls) el.hidden = !open;
    if (switcher) {
      switcher.setAttribute(
        'aria-label',
        open ? t('sidebar.workspace.label', { name, path: displayPath() }) : t('sidebar.workspace.labelEmpty'),
      );
      switcher.title = open ? t('sidebar.workspace.title', { path: rootPath }) : t('sidebar.recentFolders');
    }
    document.getElementById('titlebar')?.classList.toggle('titlebar--workspace', open);
    if (titlebarWorkspace) {
      titlebarWorkspace.hidden = !open;
      titlebarWorkspace.title = open ? rootPath : '';
      if (titlebarName) titlebarName.textContent = name;
    }
    // The window's title follows it, and with it Dock, window menu and the
    // app switcher (main/services/window-title.js).
    document.title = open ? `${name} — Snotra Agent` : 'Snotra Agent';
    fit();
  }

  /** The folder now open, or null. */
  function setWorkspace(folderPath) {
    rootPath = typeof folderPath === 'string' && folderPath ? folderPath : null;
    render();
  }

  // A width change refits: of the sidebar, and of the name's column when the
  // eraser comes or goes next to it. The layout of the header (one line or
  // two, #676) can change with either.
  if (header && typeof ResizeObserver === 'function') {
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    // Boxes whose width the layout sets, not the text: refitting changes no
    // size there, so a fit never triggers the next one.
    const boxes = [header, document.getElementById('folder-history-wrapper'), document.getElementById('project-path-narrow')];
    for (const el of boxes) {
      if (el) observer.observe(el);
    }
  }
  // The home folder arrives with the tool permissions, possibly after the
  // folder: then `~` replaces it.
  subscribeHomeDir?.(() => {
    if (rootPath) render();
  });
  onLocaleChange(render);
  render();

  return { setWorkspace, refit: fit };
}
