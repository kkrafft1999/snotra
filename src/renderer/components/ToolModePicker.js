import { dismissOnOutsideClick } from '../utils/helpers.js';
import { toolModeOptions, modeLabel, describeModePill } from '../utils/tool-approval-view.js';
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
 */
export function initToolModePicker({ toolPermissions, onOpenSandboxSettings }) {
  const wrap = document.getElementById('chat-tool-mode-wrap');
  const btn = document.getElementById('btn-chat-tool-mode');
  const label = document.getElementById('chat-tool-mode-label');
  const menu = document.getElementById('chat-tool-mode-menu');
  const list = document.getElementById('chat-tool-mode-list');
  const notice = document.getElementById('chat-tool-mode-notice');
  const noticeHeading = document.getElementById('chat-tool-mode-notice-heading');
  const noticeText = document.getElementById('chat-tool-mode-notice-text');
  const noticeLink = document.getElementById('chat-tool-mode-notice-link');
  const status = document.getElementById('chat-tool-mode-status');
  if (!wrap || !btn || !label || !menu || !list || !toolPermissions) {
    return { close() {}, isOpen: () => false };
  }

  let open = false;
  let statusTimer = 0;

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

  function rebuild(activeMode) {
    list.innerHTML = '';
    for (const option of toolModeOptions()) {
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'chat-model-menu-option chat-tool-mode-option';
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', option.value === activeMode ? 'true' : 'false');
      opt.dataset.mode = option.value;
      const main = document.createElement('span');
      main.className = 'chat-tool-mode-opt-main';
      const title = document.createElement('span');
      title.className = 'chat-model-menu-opt-title';
      title.textContent = option.label;
      const desc = document.createElement('span');
      desc.className = 'chat-tool-mode-opt-desc';
      desc.textContent = option.description;
      main.appendChild(title);
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

  function render(state) {
    const view = describeModePill(state);
    label.textContent = view.label;
    wrap.dataset.mode = view.mode;
    // "Auto" with an execution tool that would run unisolated warns in amber
    // (#357, #396): those runs have the user's full rights and ask nothing.
    // Tooltip and accessible name begin with the visible label.
    if (view.unisolated) {
      wrap.dataset.unisolated = 'true';
      btn.title = t('chat.toolMode.button.titleUnisolated', { mode: view.label, warning: view.warning });
      btn.setAttribute('aria-label', t('chat.toolMode.button.labelUnisolated', { mode: view.label, warning: view.warning }));
    } else {
      delete wrap.dataset.unisolated;
      btn.title = t('chat.toolMode.button.title', { mode: view.label });
      btn.setAttribute('aria-label', t('chat.toolMode.button.label', { mode: view.label }));
    }
    renderNotice(view);
    if (open) rebuild(view.mode);
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

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const options = [...list.querySelectorAll('.chat-tool-mode-option')];
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

  toolPermissions.subscribe(render);
  // The pill, its tooltip and the open menu are built at runtime, so a
  // language change has to redraw them (#290).
  onLocaleChange(() => render(toolPermissions.get()));
  render(toolPermissions.get());

  return { close, isOpen: () => open };
}
