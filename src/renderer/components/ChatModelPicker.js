import { dismissOnOutsideClick } from '../utils/helpers.js';
// Titel-Inferenz aus der Contract-Schicht: Kopfzeile und Verlaufsliste zeigen
// denselben Kurztitel, auch bevor die Konversation gespeichert wurde.
import contracts from '../generated/contracts.js';

const { inferChatTitle } = contracts;

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

  function closeChatModelMenu() {
    chatModelMenuOpen = false;
    if (chatModelMenu) chatModelMenu.classList.add('hidden');
    if (btnChatModelPicker) {
      btnChatModelPicker.setAttribute('aria-expanded', 'false');
    }
  }

  function rebuildChatModelMenu() {
    if (!chatModelMenu) return 0;
    chatModelMenu.innerHTML = '';
    const presets = Array.isArray(appStore.llmState.presets) ? appStore.llmState.presets : [];
    const activeId = appStore.llmState.activePresetId;
    let count = 0;
    for (const pr of presets) {
      if (pr.menuVisible === false) continue;
      if (!pr.configured) continue;
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
      const t = document.createElement('span');
      t.className = 'chat-model-menu-opt-title';
      t.lang = 'en';
      t.textContent = pr.labelBase || pr.label || '';
      main.appendChild(t);

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
    let label = 'Kein KI-Anbieter konfiguriert';
    if (streaming) {
      state = 'streaming';
      label = 'Modell antwortet';
    } else if (configured) {
      state = 'live';
      label = 'Verbindung aktiv';
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
    const title = stored || inferChatTitle(messages);
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
        chatModelPillLabel.textContent = activePreset?.label || `${active.name} · ${target.model}`;
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
        chatHint.textContent =
          'Verschlüsselter Speicher ist nicht verfügbar. Ein API-Key kann hier nicht sicher gespeichert werden.';
      } else if (active?.keyUnreadable) {
        chatHint.textContent =
          'Der gespeicherte API-Key ist nach der Umbenennung zu Snotra AI nicht mehr lesbar. Bitte in den Einstellungen neu eingeben.';
      } else {
        chatHint.textContent = 'Konfiguriere ein Sprachmodell über das Zahnrad, um zu chatten.';
      }
      chatHint.classList.remove('hidden');
      if (!appStore.chatInFlight) btnChatSend.disabled = true;
    } else if (!appStore.rootPath) {
      chatHint.textContent =
        `${modelHint ? `Aktiv: ${modelHint}` : 'Aktives Modell'} – Tipp: Öffne einen Ordner, damit der Assistent Dateien per Tool einlesen kann.`;
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
      closeChatModelMenu();
      await persistActivePreset(pid);
    });
  }

  return {
    findProviderMeta: findProviderView,
    findProviderView,
    activeProviderConfigured,
    refreshLLMState,
    updateChatChrome,
    syncChatTitle,
    syncLiveDot,
    closeChatModelMenu,
  };
}
