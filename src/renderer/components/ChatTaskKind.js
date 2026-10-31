import { dismissOnFocusLeave, dismissOnOutsideClick, followColumn, keepPopupInColumn } from '../utils/helpers.js';
import { onLocaleChange, t } from '../i18n.js';
import contracts from '../generated/contracts.js';

const { TASK_KIND_IDS, classifiedTaskKindId, normalizeTaskKind } = contracts;

/** Where a kind came from, as the popup and the pill's name say it (#1282). */
const SOURCE_KEYS = Object.freeze({
  model: 'chat.taskKind.source.model',
  estimate: 'chat.taskKind.source.estimate',
  user: 'chat.taskKind.source.user',
});

/**
 * The chat's kind of task in the header (#1282, concept #1259 section 6): a
 * pill after the title — variant A of the mockup — that opens the six kinds
 * and says where the current one came from. A pick is stored as the user's.
 *
 * The kind on screen is `appStore.currentChatTaskKind`; whoever switches the
 * chat sets it, and `sync()` draws it with the title.
 */
export function initChatTaskKind({ api, appStore }) {
  const wrap = document.getElementById('chat-kind-wrap');
  const pill = document.getElementById('btn-chat-kind');
  const pillLabel = document.getElementById('chat-kind-label');
  const menu = document.getElementById('chat-kind-menu');
  const list = document.getElementById('chat-kind-list');
  const sourceLine = document.getElementById('chat-kind-source');
  const status = document.getElementById('chat-kind-status');
  if (!wrap || !pill || !menu || !list) return { sync() {}, close() {} };

  let open = false;
  let saving = false;

  /** The kind the chat counts under, with its source; null when unclassified. */
  function current() {
    const kind = normalizeTaskKind(appStore.currentChatTaskKind);
    const id = classifiedTaskKindId(kind);
    return id ? { id, source: kind.source } : null;
  }

  /**
   * Only a chat that exists in the history can carry a kind: one with a
   * question in it. A fresh chat shows nothing yet.
   */
  function chatHasStarted() {
    const messages = Array.isArray(appStore.chatMessages) ? appStore.chatMessages : [];
    return !!appStore.currentChatId && messages.some((m) => m && m.role === 'user' && !m.greeting);
  }

  function sync() {
    const shown = chatHasStarted();
    wrap.classList.toggle('hidden', !shown);
    if (!shown) {
      if (open) close();
      return;
    }
    const kind = current();
    pill.classList.toggle('chat-kind-pill--unclassified', !kind);
    pillLabel.textContent = kind ? t(`taskKind.${kind.id}`) : t('taskKind.unclassified');
    const name = kind
      ? t('chat.taskKind.button.label', { kind: t(`taskKind.${kind.id}`), source: t(SOURCE_KEYS[kind.source]) })
      : t('chat.taskKind.button.labelUnclassified');
    pill.setAttribute('aria-label', name);
    pill.title = name;
    if (open) rebuild();
  }

  function rebuild() {
    const kind = current();
    list.innerHTML = '';
    const focusable = kind?.id || TASK_KIND_IDS[0];
    for (const id of TASK_KIND_IDS) {
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-kind-option';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', kind?.id === id ? 'true' : 'false');
      btn.tabIndex = id === focusable ? 0 : -1;
      btn.dataset.kind = id;

      const check = document.createElement('span');
      check.className = 'chat-kind-option-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      const text = document.createElement('span');
      text.className = 'chat-kind-option-text';
      const title = document.createElement('span');
      title.className = 'chat-kind-option-title';
      title.textContent = t(`taskKind.${id}`);
      const definition = document.createElement('span');
      definition.className = 'chat-kind-option-definition';
      definition.textContent = t(`taskKind.${id}.definition`);
      text.append(title, definition);

      btn.append(check, text);
      li.appendChild(btn);
      list.appendChild(li);
    }
    sourceLine.textContent = kind ? t(SOURCE_KEYS[kind.source]) : t('chat.taskKind.source.none');
  }

  function options() {
    return [...list.querySelectorAll('.chat-kind-option')];
  }

  function showStatus(text) {
    if (!status) return;
    status.textContent = text;
    status.hidden = !text;
  }

  function openMenu() {
    rebuild();
    showStatus('');
    open = true;
    menu.classList.remove('hidden');
    keepPopupInColumn(menu, wrap);
    pill.setAttribute('aria-expanded', 'true');
    const all = options();
    (all.find((o) => o.getAttribute('aria-selected') === 'true') || all[0])?.focus();
  }

  /** `focusPill`: back to the pill after Escape or a pick, as the model menu does. */
  function close({ focusPill = false } = {}) {
    open = false;
    menu.classList.add('hidden');
    pill.setAttribute('aria-expanded', 'false');
    if (focusPill) pill.focus();
  }

  async function choose(kindId) {
    if (saving) return;
    const chatId = appStore.currentChatId;
    if (current()?.id === kindId && current()?.source === 'user') {
      close({ focusPill: true });
      return;
    }
    saving = true;
    let taskKind = null;
    try {
      taskKind = (await api.setChatTaskKind(chatId, kindId))?.taskKind || null;
    } catch (error) {
      // Said in the popup below; the console keeps the cause.
      console.warn('[task-kind] the kind was not saved:', error);
      taskKind = null;
    } finally {
      saving = false;
    }
    // Switched to another chat meanwhile: what was stored belongs to that one.
    if (appStore.currentChatId !== chatId) return;
    if (!taskKind) {
      showStatus(t('chat.taskKind.error'));
      return;
    }
    appStore.currentChatTaskKind = taskKind;
    close({ focusPill: true });
    sync();
  }

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) close();
    else openMenu();
  });

  menu.addEventListener('click', (e) => {
    const option = e.target.closest?.('.chat-kind-option');
    // choose() shows a failed save in the popup; this only logs the unexpected.
    if (option?.dataset.kind) choose(option.dataset.kind).catch((error) => console.error('[task-kind]', error));
  });

  // A press on the popup's text would move the focus to nowhere and close it.
  menu.addEventListener('mousedown', (e) => {
    if (!e.target.closest?.('button')) e.preventDefault();
  });

  // The keyboard model of a listbox, the same as the model menu's (#583).
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close({ focusPill: true });
      return;
    }
    const all = options();
    const index = all.indexOf(document.activeElement);
    if (index < 0) return;
    let next = null;
    if (e.key === 'ArrowDown') next = all[(index + 1) % all.length];
    else if (e.key === 'ArrowUp') next = all[(index - 1 + all.length) % all.length];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    if (!next) return;
    e.preventDefault();
    for (const option of all) option.tabIndex = option === next ? 0 : -1;
    next.focus();
  });

  dismissOnOutsideClick({
    isOpen: () => open,
    ownsTarget: (target) => !!target?.closest?.('#chat-kind-wrap'),
    onDismiss: close,
  });
  dismissOnFocusLeave({ container: wrap, isOpen: () => open, onDismiss: close });
  followColumn(menu, wrap, () => open);
  onLocaleChange(() => sync());

  return { sync, close };
}
