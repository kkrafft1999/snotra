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
  const chatModelMenu = document.getElementById('chat-model-menu');
  const chatLiveDot = document.getElementById('chat-live-dot');

  let chatModelMenuOpen = false;

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

  function rebuildChatModelMenu() {
    if (!chatModelMenu) return 0;
    chatModelMenu.innerHTML = '';
    const activeId = appStore.llmState.activePresetId;
    let count = 0;
    for (const pr of menuPresets()) {
      count += 1;
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-model-menu-option';
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', pr.id === activeId ? 'true' : 'false');
      btn.dataset.presetId = pr.id;

      const main = document.createElement('span');
      main.className = 'chat-model-menu-opt-main';

      // Einzeilig: Anbieter und Modell, dahinter gedaempft der Zusatz
      // (z. B. das Reasoning-Level). Weitere Preset-Details wie Serveradresse
      // stehen im Einstellungsdialog, nicht in diesem Schnellwechsel-Menue.
      const title = document.createElement('span');
      title.className = 'chat-model-menu-opt-title';
      title.lang = 'en';
      title.textContent = pr.labelBase || pr.label || '';
      main.appendChild(title);

      if (pr.optionSuffix) {
        const suffix = document.createElement('span');
        suffix.className = 'chat-model-menu-opt-suffix';
        suffix.lang = 'en';
        suffix.textContent = pr.optionSuffix;
        main.appendChild(suffix);
      }

      btn.appendChild(main);
      li.appendChild(btn);
      chatModelMenu.appendChild(li);
    }
    return count;
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
        reasoningEffort: null,
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

  function updateChatChrome() {
    const target = appStore.llmState.chatTarget;
    const active = target?.providerId ? findProviderView(target.providerId) : null;
    const isConfigured = activeProviderConfigured();
    const activePreset = (appStore.llmState.presets || []).find(
      (p) => p.id === appStore.llmState.activePresetId
    );

    syncChatTitle();

    if (chatModelPickerWrap && btnChatModelPicker && chatModelPillLabel) {
      if (active && target?.model && isConfigured) {
        chatModelPickerWrap.classList.remove('hidden');
        btnChatModelPicker.classList.remove('hidden');
        const model = activePreset?.label || `${active.name} · ${target.model}`;
        chatModelPillLabel.textContent = model;
        // The name starts with what the pill shows (WCAG 2.5.3, #583); the
        // model name alone is marked as English, in the markup.
        const name = t('chat.modelPicker.button.label', { model });
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
      if (chatModelMenu) chatModelMenu.innerHTML = '';
    }

    let modelHint = '';
    if (activePreset?.label) {
      modelHint = activePreset.label;
    } else if (active && target?.model) {
      modelHint = `${active.name} · ${target.model}`;
    } else if (active) {
      modelHint = `${active.name}`;
    }

    if (!isConfigured) {
      if (!appStore.llmState.encryptionAvailable) {
        chatHint.textContent = t('chat.hint.noEncryption');
      } else if (active?.keyUnreadable) {
        chatHint.textContent = t('chat.hint.keyUnreadable');
      } else {
        chatHint.textContent = t('chat.hint.noModel');
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
    chatModelMenuOpen = true;
    chatModelMenu.classList.remove('hidden');
    btnChatModelPicker.setAttribute('aria-expanded', 'true');
    // Into the list, on the option that is selected (#583).
    const options = menuOptions();
    (options.find((o) => o.getAttribute('aria-selected') === 'true') || options[0])?.focus();
  }

  function menuOptions() {
    return chatModelMenu ? [...chatModelMenu.querySelectorAll('.chat-model-menu-option')] : [];
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
    chatModelMenu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeChatModelMenu({ focusPill: true });
        return;
      }
      const options = menuOptions();
      if (options.length === 0) return;
      const index = options.indexOf(document.activeElement);
      let next = null;
      if (e.key === 'ArrowDown') next = options[(index + 1) % options.length];
      else if (e.key === 'ArrowUp') next = options[(index - 1 + options.length) % options.length];
      else if (e.key === 'Home') next = options[0];
      else if (e.key === 'End') next = options[options.length - 1];
      if (!next) return;
      e.preventDefault();
      next.focus();
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
