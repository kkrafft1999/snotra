import { describeFolderSandbox } from '../utils/sandbox-status-view.js';
import { onLocaleChange, t } from '../i18n.js';

/**
 * The shield next to the folder name (#398): whether shell_execute and
 * run_python run isolated in the open folder. A button rather than an icon,
 * because it leads to the sandbox switch — the same way the approval card and
 * the mode menu do.
 */
export function initFolderSandboxShield({ toolPermissions, onOpenSandboxSettings }) {
  const btn = document.getElementById('btn-tree-sandbox');
  if (!btn || !toolPermissions) return;

  function render(state) {
    const view = describeFolderSandbox(state);
    btn.hidden = !view.visible;
    if (view.unisolated) btn.dataset.unisolated = 'true';
    else delete btn.dataset.unisolated;
    btn.title = view.visible ? t('sidebar.sandbox.title', { state: view.text }) : '';
    if (view.visible) btn.setAttribute('aria-label', t('sidebar.sandbox.label', { state: view.text }));
    else btn.removeAttribute('aria-label');
  }

  btn.addEventListener('click', () => onOpenSandboxSettings?.());
  toolPermissions.subscribe(render);
  // Title and label are built at runtime, so a language change redraws them.
  onLocaleChange(() => render(toolPermissions.get()));
  render(toolPermissions.get());
}
