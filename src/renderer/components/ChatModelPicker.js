import { dismissOnFocusLeave, dismissOnOutsideClick } from '../utils/helpers.js';
import { onLocaleChange, t, tMessage } from '../i18n.js';
// Titel-Inferenz aus der Contract-Schicht: Kopfzeile und Verlaufsliste zeigen
// denselben Kurztitel, auch bevor die Konversation gespeichert wurde.
import contracts from '../generated/contracts.js';

const { resolveChatTitle } = contracts;

export function initChatModelPicker({
  api,
  appStore,
  onLlmStateChanged,
}) {
  const chatTitleEl = document.getElementById('chat-title');
  const chatHint = document.getElementById('chat-hint');
  const btnChatSend = document.getElementById('btn-chat-send');
  const chatModelPickerWrap = document.getElementById('chat-model-picker-wrap');
  const btnChatModelPicker = document.getElementById('btn-chat-model-picker');
  const chatModelPillLabel = document.getElementById('chat-model-pill-label');
  // The popup: the models (a listbox) and, below them, the chat's reasoning
  // level (a radio group) — variant C of #723, built in #727.
  const chatModelMenu = document.getElementById('chat-model-menu');
  const chatModelList = document.getElementById('chat-model-list');
  const chatReasoning = document.getElementById('chat-reasoning');
  const chatReasoningLevels = document.getElementById('chat-reasoning-levels');
  const chatReasoningHint = document.getElementById('chat-reasoning-hint');
  const chatReasoningStatus = document.getElementById('chat-reasoning-status');
  const chatLiveDot = document.getElementById('chat-live-dot');

  let chatModelMenuOpen = false;
  // Set by a press or by Space on a level: the choice that follows closes the
  // menu (#737). The arrow keys leave it unset — they walk the group, and
  // closing on the first step would put the levels behind it out of reach.
  let closeAfterLevel = false;

  function findProviderView(providerId) {
    return (appStore.llmState.providers || []).find((p) => p.id === providerId) || null;
  }

  function activeProviderConfigured() {
    const pid = appStore.llmState.chatTarget?.providerId;
    const p = pid ? findProviderView(pid) : null;
    return !!(p && p.configured);
  }

  // Ob der aktive Anbieter Bild-Anhaenge weiterreicht (Issue #93). Ohne das
  // Feld — etwa aus einem aelteren Zustand — gilt „kann keine Bilder".
  //
  // Bei Verbindung je Eintrag (Issue #202) entscheidet der **Eintrag**: Zwei
  // Zeilen desselben Anbieters koennen auf verschiedene Server zeigen, von
  // denen nur einer Bilder versteht.
  function activeProviderSupportsImages() {
    const preset = (appStore.llmState.presets || [])
      .find((pr) => pr.id === appStore.llmState.activePresetId);
    if (preset?.connection) return preset.connection.supportsImages === true;
    const pid = appStore.llmState.chatTarget?.providerId;
    const p = pid ? findProviderView(pid) : null;
    return p?.capabilities?.images === true;
  }

  /**
   * `focusPill`: back to the pill after Escape or a choice (#583), the way the
   * mode menu next to it does it. A click elsewhere leaves the focus alone.
   */
  function closeChatModelMenu({ focusPill = false } = {}) {
    chatModelMenuOpen = false;
    closeAfterLevel = false;
    if (chatModelMenu) chatModelMenu.classList.add('hidden');
    if (btnChatModelPicker) {
      btnChatModelPicker.setAttribute('aria-expanded', 'false');
      if (focusPill) btnChatModelPicker.focus();
    }
  }

  /**
   * The presets the menu offers. The active one is always among them, also
   * when it is hidden from the menu: the menu then still shows what is
   * selected, and the pill never opens an empty list (#583).
   */
  function menuPresets() {
    const presets = Array.isArray(appStore.llmState.presets) ? appStore.llmState.presets : [];
    const activeId = appStore.llmState.activePresetId;
    return presets.filter((pr) => pr.configured && (pr.menuVisible !== false || pr.id === activeId));
  }

  /** The model an entry runs; an entry from an older state only has its label. */
  function modelOf(preset) {
    return preset?.model || findProviderView(preset?.providerId)?.defaultModel || preset?.label || '';
  }

  /**
   * How the chat names an entry (#727): by its model alone — the provider is
   * left out, the model ID says enough. Only when another entry in the menu
   * carries the same model (one model on two servers, #202) does the entry's
   * name follow: "qwen3:32b · Mac Studio".
   */
  function entryTitle(preset, presets = menuPresets()) {
    const model = modelOf(preset);
    const twin = presets.some((other) => other.id !== preset?.id && modelOf(other) === model);
    return twin && preset?.entryName ? `${model} · ${preset.entryName}` : model;
  }

  function renderPillLabel(title, level) {
    chatModelPillLabel.textContent = '';
    const model = document.createElement('span');
    model.className = 'chat-model-pill-model';
    model.textContent = title;
    chatModelPillLabel.appendChild(model);
    if (!level) return;
    const suffix = document.createElement('span');
    suffix.className = 'chat-model-pill-level';
    suffix.textContent = ` · ${level}`;
    chatModelPillLabel.appendChild(suffix);
  }

  /** The chat's level and the levels its model takes; no levels, no choice. */
  function reasoningState() {
    const reasoning = appStore.llmState.reasoning;
    const levels = Array.isArray(reasoning?.levels) ? reasoning.levels : [];
    return {
      levels,
      level: levels.includes(reasoning?.level) ? reasoning.level : null,
      defaultLevel: reasoning?.defaultLevel || 'medium',
    };
  }

  function rebuildChatModelMenu() {
    if (!chatModelList) return 0;
    chatModelList.innerHTML = '';
    const activeId = appStore.llmState.activePresetId;
    const presets = menuPresets();
    const focusable = presets.some((pr) => pr.id === activeId) ? activeId : presets[0]?.id;
    let count = 0;
    for (const pr of presets) {
      count += 1;
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-model-menu-option';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', pr.id === activeId ? 'true' : 'false');
      // One stop for the whole list (#727): Tab goes on to the levels, the
      // arrow keys move within the list.
      btn.tabIndex = pr.id === focusable ? 0 : -1;
      btn.dataset.presetId = pr.id;

      const main = document.createElement('span');
      main.className = 'chat-model-menu-opt-main';

      // One line: the model. Further details such as the server address are
      // in the settings dialog, not in this quick switch.
      const title = document.createElement('span');
      title.className = 'chat-model-menu-opt-title';
      title.lang = 'en';
      title.textContent = entryTitle(pr, presets);
      main.appendChild(title);

      btn.appendChild(main);
      li.appendChild(btn);
      chatModelList.appendChild(li);
    }
    return count;
  }

  /** The levels of the active model as a radio group; absent without levels. */
  function rebuildReasoning() {
    if (!chatReasoning || !chatReasoningLevels) return;
    const { levels, level, defaultLevel } = reasoningState();
    chatReasoningLevels.innerHTML = '';
    setReasoningStatus('');
    chatReasoning.hidden = levels.length === 0;
    if (levels.length === 0) return;
    for (const value of levels) {
      const option = document.createElement('label');
      option.className = 'ds-segmented__option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.className = 'ds-segmented__input';
      input.name = 'chat-reasoning-level';
      input.value = value;
      input.checked = value === level;
      const text = document.createElement('span');
      text.lang = 'en';
      text.textContent = value;
      option.append(input, text);
      chatReasoningLevels.appendChild(option);
    }
    if (chatReasoningHint) chatReasoningHint.textContent = t('chat.reasoning.hint', { level: defaultLevel });
  }

  function setReasoningStatus(text) {
    if (!chatReasoningStatus) return;
    chatReasoningStatus.textContent = text;
    chatReasoningStatus.hidden = !text;
  }

  function checkLevel(level) {
    for (const input of chatReasoningLevels?.querySelectorAll('input') || []) {
      input.checked = input.value === level;
    }
  }

  /**
   * A level applies at once (#727); chosen with `close`, the menu closes
   * behind it and the pill shows the level a moment later (#737). Refused,
   * the menu stays open, and the group goes back to the level that holds and
   * says why — no choice without an answer.
   */
  async function chooseReasoningLevel(level, { close = false } = {}) {
    setReasoningStatus('');
    let res;
    try {
      res = await api.setReasoningEffort(level);
    } catch {
      res = null;
    }
    if (!res?.ok) {
      checkLevel(reasoningState().level);
      setReasoningStatus(res?.error ? tMessage(res.error) : t('chat.reasoning.failed'));
      return;
    }
    if (close && chatModelMenuOpen) closeChatModelMenu({ focusPill: true });
    await refreshLLMState();
  }

  async function persistActivePreset(presetId) {
    try {
      const res = await api.setActivePreset(presetId);
      if (!res?.ok) return false;
      await refreshLLMState();
      return true;
    } catch {
      return false;
    }
  }

  async function refreshLLMState() {
    appStore.llmState = await api.getLLMState();
    if (!appStore.llmState.presets) appStore.llmState.presets = [];
    const ct = appStore.llmState.chatTarget;
    if (!ct || !ct.providerId) {
      const ap = appStore.llmState.activeProvider;
      const m = findProviderView(ap);
      appStore.llmState.chatTarget = {
        providerId: ap,
        model: m?.model || '',
      };
    }
    updateChatChrome();
    onLlmStateChanged?.();
  }

  function syncLiveDot() {
    if (!chatLiveDot) return;
    const last = appStore.chatMessages[appStore.chatMessages.length - 1];
    const streaming = !!(last && last.role === 'assistant' && last.streaming);
    const configured = activeProviderConfigured();

    let state = 'offline';
    let label = t('chat.live.offline');
    if (streaming) {
      state = 'streaming';
      label = t('chat.live.streaming');
    } else if (configured) {
      state = 'live';
      label = t('chat.live.active');
    }
    chatLiveDot.dataset.state = state;
    chatLiveDot.setAttribute('aria-label', label);
  }

  /**
   * Kopfzeile: Kurztitel der Konversation statt des Ordnernamens. Ein
   * geladener Chat bringt seinen gespeicherten Titel mit; im laufenden Chat
   * wird er aus der ersten Nutzerfrage abgeleitet, damit die Zeile schon vor
   * dem ersten Speichern stimmt. Der Ordner steht in der Dateiliste.
   */
  function syncChatTitle() {
    if (!chatTitleEl) return;
    const stored = typeof appStore.currentChatTitle === 'string' ? appStore.currentChatTitle.trim() : '';
    const messages = Array.isArray(appStore.chatMessages)
      ? appStore.chatMessages.filter((m) => !m.greeting)
      : [];
    // A fallback title comes back as a message descriptor and is put into
    // words in the interface language (#359).
    const title = tMessage(resolveChatTitle(stored, messages));
    chatTitleEl.textContent = title;
    chatTitleEl.title = title;
    chatTitleEl.removeAttribute('lang');
  }

  /**
   * Points at the way to the settings that exists on this platform: the app
   * menu on macOS, "View" elsewhere, with the shortcut both share (#670).
   */
  function noModelHint() {
    const mac = navigator.userAgent.includes('Mac');
    const menu = mac ? 'Snotra Agent' : t('menu.view');
    return t('chat.hint.noModel', {
      path: `${menu} › ${t('menu.settings')}`,
      shortcut: mac ? '⌘,' : t('chat.hint.noModel.shortcut'),
    });
  }

  function updateChatChrome() {
    const target = appStore.llmState.chatTarget;
    const active = target?.providerId ? findProviderView(target.providerId) : null;
    const isConfigured = activeProviderConfigured();
    const activePreset = (appStore.llmState.presets || []).find(
      (p) => p.id === appStore.llmState.activePresetId
    );

    syncChatTitle();

    // Model and level, no provider (#727): "gpt-6-luna · medium".
    const title = activePreset ? entryTitle(activePreset) : (target?.model || '');
    const { level } = reasoningState();
    const shown = level ? `${title} · ${level}` : title;

    if (chatModelPickerWrap && btnChatModelPicker && chatModelPillLabel) {
      if (active && target?.model && isConfigured) {
        chatModelPickerWrap.classList.remove('hidden');
        btnChatModelPicker.classList.remove('hidden');
        renderPillLabel(title, level);
        // The name starts with what the pill shows (WCAG 2.5.3, #583); the
        // model name alone is marked as English, in the markup.
        const name = level
          ? t('chat.modelPicker.button.labelWithLevel', { model: title, level })
          : t('chat.modelPicker.button.label', { model: title });
        btnChatModelPicker.setAttribute('aria-label', name);
        btnChatModelPicker.title = name;
        // Without a preset to switch to, the pill is a label, not a menu.
        btnChatModelPicker.disabled = menuPresets().length === 0;
      } else {
        chatModelPickerWrap.classList.add('hidden');
        btnChatModelPicker.classList.add('hidden');
        chatModelPillLabel.textContent = '';
      }
    }
    if (!chatModelMenuOpen) {
      closeChatModelMenu();
      if (chatModelList) chatModelList.innerHTML = '';
    }

    let modelHint = '';
    if (title) {
      modelHint = shown;
    } else if (active) {
      modelHint = `${active.name}`;
    }

    if (!isConfigured) {
      if (!appStore.llmState.encryptionAvailable) {
        chatHint.textContent = t('chat.hint.noEncryption');
      } else if (active?.keyUnreadable) {
        chatHint.textContent = t('chat.hint.keyUnreadable');
      } else {
        chatHint.textContent = noModelHint();
      }
      chatHint.classList.remove('hidden');
      if (!appStore.chatInFlight) btnChatSend.disabled = true;
    } else if (!appStore.rootPath) {
      chatHint.textContent = modelHint
        ? t('chat.hint.noFolder.model', { model: modelHint })
        : t('chat.hint.noFolder');
      chatHint.classList.remove('hidden');
      if (!appStore.chatInFlight) btnChatSend.disabled = false;
    } else {
      chatHint.classList.add('hidden');
      if (!appStore.chatInFlight) btnChatSend.disabled = false;
    }

    syncLiveDot();
  }

  function toggleChatModelDropdown() {
    if (!chatModelMenu || !btnChatModelPicker) return;
    if (!chatModelMenu.classList.contains('hidden')) {
      closeChatModelMenu();
      return;
    }
    const n = rebuildChatModelMenu();
    if (n === 0) return;
    rebuildReasoning();
    chatModelMenuOpen = true;
    chatModelMenu.classList.remove('hidden');
    keepMenuInWindow();
    btnChatModelPicker.setAttribute('aria-expanded', 'true');
    // Into the list, on the option that is selected (#583).
    const options = menuOptions();
    (options.find((o) => o.getAttribute('aria-selected') === 'true') || options[0])?.focus();
  }

  function menuOptions() {
    return chatModelList ? [...chatModelList.querySelectorAll('.chat-model-menu-option')] : [];
  }

  /**
   * The popup opens from the pill's left edge, inside the chat column, which
   * cuts off whatever reaches past it. With the levels it can be wider than
   * the space to the right of the pill: it moves left as far as the column
   * allows, and in a column narrower than itself it takes the column's width
   * and lets the levels wrap.
   */
  function keepMenuInWindow() {
    chatModelMenu.style.left = '';
    chatModelMenu.style.maxWidth = '';
    const column = chatModelPickerWrap?.closest('#chat-panel')?.getBoundingClientRect()
      || { left: 0, right: window.innerWidth };
    const left = column.left + 8;
    const right = column.right - 8;
    chatModelMenu.style.maxWidth = `${Math.max(0, right - left)}px`;
    const box = chatModelMenu.getBoundingClientRect();
    const overflow = box.right - right;
    if (overflow > 0) chatModelMenu.style.left = `${-Math.min(overflow, box.left - left)}px`;
  }

  dismissOnOutsideClick({
    isOpen: () => chatModelMenuOpen && !!chatModelMenu && !!btnChatModelPicker,
    ownsTarget: (t) => !!t?.closest?.('.chat-model-picker-wrap'),
    onDismiss: closeChatModelMenu,
  });

  if (btnChatModelPicker) {
    btnChatModelPicker.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChatModelDropdown();
    });
  }

  if (chatModelMenu) {
    chatModelMenu.addEventListener('click', async (e) => {
      const opt = e.target.closest('.chat-model-menu-option');
      if (!opt) return;
      const pid = opt.dataset.presetId;
      if (!pid) return;
      closeChatModelMenu({ focusPill: true });
      await persistActivePreset(pid);
    });

    // The keyboard model of a listbox, the same as the mode menu's (#583).
    // The levels below are a radio group and keep the arrow keys of their own.
    chatModelMenu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeChatModelMenu({ focusPill: true });
        return;
      }
      const options = menuOptions();
      const index = options.indexOf(document.activeElement);
      if (index < 0) return;
      let next = null;
      if (e.key === 'ArrowDown') next = options[(index + 1) % options.length];
      else if (e.key === 'ArrowUp') next = options[(index - 1 + options.length) % options.length];
      else if (e.key === 'Home') next = options[0];
      else if (e.key === 'End') next = options[options.length - 1];
      if (!next) return;
      e.preventDefault();
      for (const option of options) option.tabIndex = option === next ? 0 : -1;
      next.focus();
    });
  }

  if (chatModelMenu) {
    // A press on a level would move the focus to nowhere — a label takes none
    // — and the menu closes on a focus that leaves it, before the click
    // arrives (#727). The level's radio takes the focus instead; a press on
    // the popup's text leaves the focus where it is.
    chatModelMenu.addEventListener('mousedown', (e) => {
      const input = e.target.closest?.('#chat-reasoning-levels label')?.querySelector('input');
      if (input) {
        e.preventDefault();
        input.focus();
        closeAfterLevel = true;
        return;
      }
      if (!e.target.closest?.('button, input')) e.preventDefault();
    });
  }

  if (chatReasoningLevels) {
    chatReasoningLevels.addEventListener('change', (e) => {
      const input = e.target;
      if (input?.type !== 'radio' || !input.checked) return;
      const close = closeAfterLevel;
      closeAfterLevel = false;
      void chooseReasoningLevel(input.value, { close });
    });

    // The level that already holds sends no `change`: nothing to apply, only
    // the menu to close. A new level is checked by the time the click
    // arrives, but the state still holds the old one.
    chatReasoningLevels.addEventListener('click', (e) => {
      const input = e.target;
      if (input?.type !== 'radio' || !closeAfterLevel) return;
      if (input.value !== reasoningState().level) return;
      closeChatModelMenu({ focusPill: true });
    });

    // Space checks the level and closes, like a click. Enter does the same —
    // a radio would otherwise ignore it. The arrow keys only walk.
    chatReasoningLevels.addEventListener('keydown', (e) => {
      const input = e.target;
      if (input?.type !== 'radio') return;
      if (e.key === ' ') {
        closeAfterLevel = true;
        return;
      }
      closeAfterLevel = false;
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (input.value === reasoningState().level) {
        closeChatModelMenu({ focusPill: true });
        return;
      }
      input.checked = true;
      void chooseReasoningLevel(input.value, { close: true });
    });
  }

  // Tabbing out closes the menu; it does not stay open behind the focus.
  dismissOnFocusLeave({
    container: chatModelPickerWrap,
    isOpen: () => chatModelMenuOpen,
    onDismiss: () => closeChatModelMenu(),
  });

  // The pill, the hint below the composer and the label of the live dot are
  // written at runtime, so a language change has to repaint them (#290).
  onLocaleChange(() => {
    updateChatChrome();
    syncLiveDot();
    // The names of the local providers carry a word — "(local)" — and come
    // from the main process in the stored language (#310).
    void refreshLLMState().then(syncLiveDot);
  });

  return {
    findProviderMeta: findProviderView,
    findProviderView,
    activeProviderConfigured,
    activeProviderSupportsImages,
    refreshLLMState,
    updateChatChrome,
    syncChatTitle,
    syncLiveDot,
    closeChatModelMenu,
  };
}
