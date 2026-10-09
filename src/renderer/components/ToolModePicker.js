import { dismissOnFocusLeave, dismissOnOutsideClick, followColumn, keepPopupInColumn } from '../utils/helpers.js';
import { toolModeOptions, modeLabel, describeModePill, describeWorkspaceDefault } from '../utils/tool-approval-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { onLocaleChange, t, tMessage } from '../i18n.js';

/**
 * Modus-Pille in der Chat-Leiste (Issue #67, Konzept §3/§8): zeigt den aktiven
 * Berechtigungsmodus neben der Modell-Auswahl und wechselt ihn per Menü. Der
 * Wechsel läuft über den Main; „Auto“ bestätigt dieser in einem nativen Dialog
 * – die Pille zeigt erst danach den neuen Modus.
 *
 * `onOpenSandboxSettings`: the way from the menu notice to the sandbox switch
 * (#396), the same one the approval card offers.
 *
 * Below the list sits the workspace default (#413): a checkbox that makes the
 * chat's mode the one every new chat in this folder starts with, and a tag on
 * the option that is the default. Main confirms "Auto" natively.
 */
export function initToolModePicker({ toolPermissions, onOpenSandboxSettings, onOpenSecuritySettings }) {
  const wrap = document.getElementById('chat-tool-mode-wrap');
  const btn = document.getElementById('btn-chat-tool-mode');
  const label = document.getElementById('chat-tool-mode-label');
  const menu = document.getElementById('chat-tool-mode-menu');
  const list = document.getElementById('chat-tool-mode-list');
  const notice = document.getElementById('chat-tool-mode-notice');
  const noticeHeading = document.getElementById('chat-tool-mode-notice-heading');
  const noticeText = document.getElementById('chat-tool-mode-notice-text');
  const noticeLink = document.getElementById('chat-tool-mode-notice-link');
  const securityLink = document.getElementById('chat-tool-mode-security-link');
  const status = document.getElementById('chat-tool-mode-status');
  const footer = document.getElementById('chat-tool-mode-footer');
  const remember = document.getElementById('chat-tool-mode-remember');
  const rememberLabel = document.getElementById('chat-tool-mode-remember-label');
  const rememberHint = document.getElementById('chat-tool-mode-remember-hint');
  if (!wrap || !btn || !label || !menu || !list || !toolPermissions) {
    return { close() {}, isOpen: () => false };
  }

  let open = false;
  let statusTimer = 0;
  let rememberBusy = false;
  // True while the list is rebuilt: the focused option goes away for a moment.
  let rebuilding = false;

  function setStatus(text) {
    if (!status) return;
    clearTimeout(statusTimer);
    status.textContent = text || '';
    status.classList.toggle('hidden', !text);
    if (text) {
      statusTimer = setTimeout(() => {
        status.textContent = '';
        status.classList.add('hidden');
      }, 4000);
    }
  }

  function rebuild(activeMode, defaults = describeWorkspaceDefault(toolPermissions.get())) {
    const focusedMode = list.contains(document.activeElement) ? document.activeElement.dataset.mode : null;
    rebuilding = true;
    try {
      fillList(activeMode, defaults);
    } finally {
      rebuilding = false;
    }
    // A state change while the menu is open keeps the focus on its option.
    if (focusedMode) list.querySelector(`[data-mode="${CSS.escape(focusedMode)}"]`)?.focus();
  }

  function fillList(activeMode, defaults) {
    list.innerHTML = '';
    for (const option of toolModeOptions(toolPermissions.get(), activeMode)) {
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'chat-model-menu-option chat-tool-mode-option';
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', option.value === activeMode ? 'true' : 'false');
      opt.dataset.mode = option.value;
      // Not offered where it cannot take effect (#419); still read out.
      if (option.unavailable) {
        opt.disabled = true;
        opt.setAttribute('aria-disabled', 'true');
      }
      const main = document.createElement('span');
      main.className = 'chat-tool-mode-opt-main';
      const title = document.createElement('span');
      title.className = 'chat-model-menu-opt-title';
      title.textContent = option.label;
      const desc = document.createElement('span');
      desc.className = 'chat-tool-mode-opt-desc';
      desc.textContent = option.description;
      if (defaults.tagMode === option.value) {
        const head = document.createElement('span');
        head.className = 'chat-tool-mode-opt-head';
        const tag = document.createElement('span');
        tag.className = 'chat-tool-mode-default-tag';
        tag.textContent = defaults.tag;
        head.appendChild(title);
        head.appendChild(tag);
        main.appendChild(head);
      } else {
        main.appendChild(title);
      }
      main.appendChild(desc);
      opt.appendChild(main);
      li.appendChild(opt);
      list.appendChild(li);
    }
  }

  /** The notice on top of the menu (#396): why the pill warns, and the way to the switch. */
  function renderNotice(view) {
    if (!notice) return;
    notice.hidden = !view.unisolated;
    if (noticeHeading) noticeHeading.textContent = view.heading;
    if (noticeText) noticeText.textContent = view.warning;
    if (noticeLink) {
      const offered = !!view.settingsLabel && typeof onOpenSandboxSettings === 'function';
      noticeLink.hidden = !offered;
      noticeLink.textContent = offered ? view.settingsLabel : '';
    }
    // The notice sits outside the listbox, so the listbox points at it.
    if (view.unisolated) list.setAttribute('aria-describedby', 'chat-tool-mode-notice-heading chat-tool-mode-notice-text');
    else list.removeAttribute('aria-describedby');
  }

  /** The checkbox under the list (#413). Kept as it is while main decides. */
  function renderFooter(defaults) {
    if (!footer || !remember) return;
    footer.hidden = !defaults.visible;
    if (!defaults.visible || rememberBusy) return;
    remember.checked = defaults.checked;
    remember.disabled = defaults.disabled;
    remember.dataset.target = defaults.targetMode;
    if (rememberLabel) {
      rememberLabel.textContent = defaults.label.before;
      if (defaults.label.folder) {
        const strong = document.createElement('strong');
        strong.textContent = defaults.label.folder;
        rememberLabel.appendChild(strong);
      }
      rememberLabel.append(defaults.label.after);
    }
    if (rememberHint) rememberHint.textContent = defaults.hint;
  }

  function render(state) {
    const view = describeModePill(state);
    const defaults = describeWorkspaceDefault(state);
    label.textContent = view.label;
    wrap.dataset.mode = view.mode;
    // "Auto" with an execution tool that would run unisolated warns in amber
    // (#357, #396): those runs have the user's full rights and ask nothing.
    // Tooltip and accessible name begin with the visible label.
    if (view.unisolated) {
      wrap.dataset.unisolated = 'true';
      btn.title = t('chat.toolMode.button.titleUnisolated', { mode: view.label, warning: view.warning });
      btn.setAttribute('aria-label', t('chat.toolMode.button.labelUnisolated', { mode: view.label, warning: view.warning }));
    } else if (defaults.isDefault) {
      delete wrap.dataset.unisolated;
      btn.title = t('chat.toolMode.button.titleDefault', { mode: view.label, folder: defaults.folder });
      btn.setAttribute('aria-label', t('chat.toolMode.button.labelDefault', { mode: view.label, folder: defaults.folder }));
    } else {
      delete wrap.dataset.unisolated;
      btn.title = t('chat.toolMode.button.title', { mode: view.label });
      btn.setAttribute('aria-label', t('chat.toolMode.button.label', { mode: view.label }));
    }
    renderNotice(view);
    renderFooter(defaults);
    if (open) {
      rebuild(view.mode, defaults);
      keepPopupInColumn(menu, wrap);
    }
  }

  function close() {
    open = false;
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    rebuild(toolPermissions.mode());
    open = true;
    menu.classList.remove('hidden');
    keepPopupInColumn(menu, wrap);
    btn.setAttribute('aria-expanded', 'true');
    list.querySelector('[aria-selected="true"]')?.focus();
  }

  async function choose(mode) {
    close();
    btn.focus();
    if (mode === toolPermissions.mode()) return;
    setStatus('');
    const result = await toolPermissions.setMode(mode);
    if (result?.ok) {
      setStatus(t('chat.toolMode.changed', { mode: modeLabel(mode) }));
      return;
    }
    if (isCancelledResult(result)) {
      setStatus(t('chat.toolMode.unchanged'));
      return;
    }
    setStatus(tMessage(result?.error) || t('chat.toolMode.failed'));
  }

  /**
   * Ticked: the chat's mode becomes the workspace default; unticked: the
   * default goes back to "Smart". The menu stays open, so the result can be
   * read where the click happened.
   */
  async function rememberForWorkspace() {
    const target = remember.dataset.target;
    const folder = describeWorkspaceDefault(toolPermissions.get()).folder;
    rememberBusy = true;
    remember.disabled = true;
    setStatus('');
    let result;
    try {
      result = await toolPermissions.setWorkspaceMode(target);
    } finally {
      rememberBusy = false;
    }
    if (result?.ok) {
      setStatus(t(target === 'smart' ? 'chat.toolMode.remember.cleared' : 'chat.toolMode.remember.set', {
        folder,
        mode: modeLabel(target),
      }));
    } else if (isCancelledResult(result)) {
      setStatus(t('chat.toolMode.remember.unchanged'));
    } else {
      setStatus(tMessage(result?.error) || t('chat.toolMode.remember.failed'));
    }
    // Whatever happened, the checkbox shows what main holds.
    render(toolPermissions.get());
    if (open) remember.focus();
  }

  remember?.addEventListener('change', () => {
    void rememberForWorkspace();
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.chat-tool-mode-option');
    if (!opt?.dataset.mode) return;
    void choose(opt.dataset.mode);
  });

  // Focus goes back to the pill first, so that closing the settings lands there.
  noticeLink?.addEventListener('click', () => {
    close();
    btn.focus();
    onOpenSandboxSettings?.();
  });
  if (securityLink) securityLink.hidden = typeof onOpenSecuritySettings !== 'function';
  securityLink?.addEventListener('click', () => {
    close();
    btn.focus();
    onOpenSecuritySettings?.();
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const options = [...list.querySelectorAll('.chat-tool-mode-option:not(:disabled)')];
    if (options.length === 0) return;
    e.preventDefault();
    const index = options.indexOf(document.activeElement);
    // From the notice link (index -1) the arrows enter the list at its ends.
    let next;
    if (index === -1) next = e.key === 'ArrowDown' ? options[0] : options[options.length - 1];
    else if (e.key === 'ArrowDown') next = options[(index + 1) % options.length];
    else next = options[(index - 1 + options.length) % options.length];
    next.focus();
  });

  dismissOnOutsideClick({
    isOpen: () => open,
    ownsTarget: (t) => !!t?.closest?.('#chat-tool-mode-wrap'),
    onDismiss: close,
  });
  followColumn(menu, wrap, () => open);
  // Tab past the menu closes it as well (#586). The checkbox is disabled
  // while main decides, which drops its focus for a moment.
  dismissOnFocusLeave({
    container: wrap,
    isOpen: () => open,
    isPaused: () => rebuilding || rememberBusy,
    onDismiss: close,
  });

  toolPermissions.subscribe(render);
  // The pill, its tooltip and the open menu are built at runtime, so a
  // language change has to redraw them (#290).
  onLocaleChange(() => render(toolPermissions.get()));
  render(toolPermissions.get());

  return { close, isOpen: () => open };
}
