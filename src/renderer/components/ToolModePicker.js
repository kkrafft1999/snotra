import { dismissOnOutsideClick } from '../utils/helpers.js';
import { toolModeOptions, modeLabel } from '../utils/tool-approval-view.js';
import { isCancelledResult } from '../state/tool-permissions.js';
import { onLocaleChange, t } from '../i18n.js';

/**
 * Modus-Pille in der Chat-Leiste (Issue #67, Konzept §3/§8): zeigt den aktiven
 * Berechtigungsmodus neben der Modell-Auswahl und wechselt ihn per Menü. Der
 * Wechsel läuft über den Main; „Auto“ bestätigt dieser in einem nativen Dialog
 * – die Pille zeigt erst danach den neuen Modus.
 */
export function initToolModePicker({ toolPermissions }) {
  const wrap = document.getElementById('chat-tool-mode-wrap');
  const btn = document.getElementById('btn-chat-tool-mode');
  const label = document.getElementById('chat-tool-mode-label');
  const menu = document.getElementById('chat-tool-mode-menu');
  const status = document.getElementById('chat-tool-mode-status');
  if (!wrap || !btn || !label || !menu || !toolPermissions) {
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
    menu.innerHTML = '';
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
      menu.appendChild(li);
    }
  }

  function render(state) {
    const mode = state?.mode || 'smart';
    const text = modeLabel(mode);
    label.textContent = text;
    wrap.dataset.mode = mode;
    btn.title = t('chat.toolMode.button.title', { mode: text });
    btn.setAttribute('aria-label', t('chat.toolMode.button.label', { mode: text }));
    if (open) rebuild(mode);
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
    menu.querySelector('[aria-selected="true"]')?.focus();
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
    setStatus(result?.error || t('chat.toolMode.failed'));
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

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const options = [...menu.querySelectorAll('.chat-tool-mode-option')];
    if (options.length === 0) return;
    e.preventDefault();
    const index = options.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown'
      ? options[(index + 1) % options.length]
      : options[(index - 1 + options.length) % options.length];
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
