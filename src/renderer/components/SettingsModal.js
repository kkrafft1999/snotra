import contracts from '../generated/contracts.js';
import {
  groupToolCatalog,
  groupCountLabel,
  groupToggleLabel,
  toolShortText,
  toolDetailText,
  toolStatusBadge,
} from '../utils/tool-catalog-view.js';

/**
 * Bereiche, die **sofort** wirken statt erst mit „Uebernehmen": Berechtigungen
 * (Issue #67) und MCP (Issue #109). Beide gehoeren dem Main-Prozess, beide
 * schreiben beim Klick. Der Hinweis in der Fussleiste muss das sagen — sonst
 * verspricht er eine Sicherheit, die es hier nicht gibt.
 */
const IMMEDIATE_PANELS = new Set(['permissions', 'mcp']);

const APPLY_HINT_DEFERRED = 'Änderungen gelten erst mit <strong>Übernehmen</strong>.';
const APPLY_HINT_IMMEDIATE = 'Änderungen in diesem Bereich wirken <strong>sofort</strong>.';

const SETTINGS_NAV_LABELS = {
  models: 'Modelle',
  tools: 'Tools',
  permissions: 'Berechtigungen',
  skills: 'Skills',
  mcp: 'MCP',
  general: 'Allgemein',
};

/** Aufklapp-Pfeil der Tool-Zeilen (Issue #98); dreht sich per CSS. */
const CHEVRON_ICON_HTML =
  '<svg class="settings-tool-row__chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const {
  formatPresetSublabelFromView,
  presetIdentityKey,
  PRESET_DETAIL_STYLES,
  SKILL_SOURCE_ORDER,
  SKILL_SOURCE_LABELS,
  SKILL_STATUS,
  DEFAULT_SKILL_SUGGESTION_MODE,
  isSkillSuggestionMode,
} = contracts;

let settingsDraftPresets = [];
let settingsDraftActivePresetId = null;
let settingsCredentialDraft = {};
let popupPresetFieldValues = {};
let settingsToolCatalog = [];
let settingsDisabledToolsDraft = new Set();
let settingsSkillCatalog = [];
let settingsActiveSkillsDraft = new Set();

export function initSettingsModal(deps) {
  const {
    api,
    appStore,
    stopChatVoiceListening,
    closeChatModelMenu,
    refreshLLMState,
    findProviderMeta,
    updateChatChrome,
    onCheckUpdates,
    toolPermissionsPanel = null,
    mcpPanel = null,
    onSkillSuggestionModeChanged = null,
    DEFAULT_MAX_TOOL_ROUNDS = 14,
  } = deps;

  const modalSettings = document.getElementById('modal-settings');
  const modalSettingsBackdrop = document.getElementById('modal-settings-backdrop');
  const settingsPanelHeadingEl = document.getElementById('settings-panel-heading');
  const settingsNavTabs = [...document.querySelectorAll('.settings-nav-item[role="tab"]')];
  const prefModelList = document.getElementById('pref-model-list');
  const prefListEmpty = document.getElementById('pref-list-empty');
  const btnOpenAddModel = document.getElementById('btn-open-add-model');
  const addModelOverlay = document.getElementById('add-model-overlay');
  const selectProvider = document.getElementById('select-provider');
  const providerStatus = document.getElementById('provider-status');
  const providerKeyRow = document.getElementById('provider-key-row');
  const providerBaseUrlRow = document.getElementById('provider-baseurl-row');
  const inputApiKey = document.getElementById('input-api-key');
  const btnRemoveApiKey = document.getElementById('btn-remove-api-key');
  const inputBaseUrl = document.getElementById('input-base-url');
  const providerInsecureRow = document.getElementById('provider-insecure-row');
  const inputInsecureTls = document.getElementById('input-insecure-tls');
  // Felder des Providers „OpenAI-kompatibel" (Issue #193). Sie stehen fest im
  // Markup und werden je Anbieter ein- oder ausgeblendet — genau wie die drei
  // bestehenden Verbindungsfelder.
  const providerTemplateRow = document.getElementById('provider-template-row');
  const selectProviderTemplate = document.getElementById('select-provider-template');
  const providerTemplateHint = document.getElementById('provider-template-hint');
  const providerDisplayNameRow = document.getElementById('provider-display-name-row');
  const inputDisplayName = document.getElementById('input-display-name');
  const providerKeyHint = document.getElementById('provider-key-hint');
  const providerExtraHeadersRow = document.getElementById('provider-extra-headers-row');
  const inputExtraHeaders = document.getElementById('input-extra-headers');
  const btnRemoveExtraHeaders = document.getElementById('btn-remove-extra-headers');
  const providerApiStyleRow = document.getElementById('provider-api-style-row');
  const selectApiStyle = document.getElementById('select-api-style');
  const providerSendToolsRow = document.getElementById('provider-send-tools-row');
  const inputSendTools = document.getElementById('input-send-tools');
  const providerSupportsImagesRow = document.getElementById('provider-supports-images-row');
  const inputSupportsImages = document.getElementById('input-supports-images');
  const presetFieldsPopup = document.getElementById('preset-fields-popup');
  const selectModel = document.getElementById('select-model');
  const inputModel = document.getElementById('input-model');
  const modelNameOptions = document.getElementById('model-name-options');
  const btnLoadModels = document.getElementById('btn-load-models');
  const modelLoadProviderLabel = document.getElementById('model-load-provider-label');
  const modelStatus = document.getElementById('model-status');
  const btnAddPresetRow = document.getElementById('btn-add-preset-row');
  const addModelTitle = document.getElementById('dialog-add-model-title');
  const addModelIntroLead = document.getElementById('add-model-intro-lead');
  const btnAddModelCloseX = document.getElementById('btn-add-model-close-x');
  const btnAddModelClose = document.getElementById('btn-add-model-close');
  const btnSettingsSave = document.getElementById('btn-settings-save');
  const btnSettingsClose = document.getElementById('btn-settings-close');
  const btnSettingsFooterClose = document.getElementById('btn-settings-footer-close');
  const inputGlobalSystemPrompt = document.getElementById('input-global-system-prompt');
  const selectAppLocale = document.getElementById('select-app-locale');
  const selectSkillSuggestionMode = document.getElementById('settings-skill-suggestion-mode');
  const inputMaxToolRounds = document.getElementById('input-max-tool-rounds');
  const settingsToolList = document.getElementById('settings-tool-list');
  const settingsToolListEmpty = document.getElementById('settings-tool-list-empty');
  // Websuche (Issue #63): eigener Schluessel, wirkt sofort und haengt nicht am
  // Entwurf, der mit „Uebernehmen" gespeichert wird.
  const inputWebSearchKey = document.getElementById('input-web-search-key');
  const btnWebSearchSave = document.getElementById('btn-web-search-save');
  const btnWebSearchClear = document.getElementById('btn-web-search-clear');
  const webSearchStatusEl = document.getElementById('settings-web-search-status');
  let webSearchHasKey = false;
  // Python-Ausfuehrung (Issue #86): Schalter und Interpreter-Pfad haengen am
  // Entwurf und werden mit „Uebernehmen" gespeichert; der gefundene
  // Interpreter kommt direkt vom Main.
  const inputPythonEnabled = document.getElementById('input-python-enabled');
  const inputPythonInterpreter = document.getElementById('input-python-interpreter');
  const pythonStatusEl = document.getElementById('settings-python-status');
  let pythonReady = false;
  // Shell-Ausfuehrung (Issue #102): nur ein Schalter — welche Shell benutzt
  // wird, erkennt der Main und meldet es hier als Status.
  const inputShellEnabled = document.getElementById('input-shell-enabled');
  const shellStatusEl = document.getElementById('settings-shell-status');
  let shellReady = false;
  // Umgebungsangaben im Systemprompt (Issue #138). Voreingestellt an — der
  // Schalter ist da, weil der absolute Pfad den Benutzernamen enthaelt.
  const inputEnvironmentInfo = document.getElementById('input-environment-info');
  const settingsSkillList = document.getElementById('settings-skill-list');
  const settingsSkillListEmpty = document.getElementById('settings-skill-list-empty');
  const btnReloadSkills = document.getElementById('btn-reload-skills');
  const modalEncryptionWarning = document.getElementById('modal-encryption-warning');
  const modalSaveError = document.getElementById('modal-save-error');
  const btnChatSettings = document.getElementById('btn-chat-settings');
  const settingsVersionLabel = document.getElementById('settings-version-label');
  const btnCheckUpdates = document.getElementById('btn-check-updates');

  /** Anbieter, dessen Werte gerade im Popup stehen (siehe stashPopupCredentialInputs). */
  let popupProviderId = null;
  /**
   * Verbindung je Eintrag (Issue #202): Bei Anbietern mit
   * `form.connectionPerPreset` bearbeitet das Popup **eine Zeile**, nicht den
   * Anbieter. `popupEditPresetId` sagt welche (null = neue Zeile),
   * `popupConnectionDraft` haelt die Werte der laufenden Bearbeitung.
   */
  let popupEditPresetId = null;
  let popupConnectionDraft = null;

  function usesPresetConnection(providerView) {
    return providerView?.form?.connectionPerPreset === true;
  }

  /** Leerer Verbindungs-Entwurf aus den Voreinstellungen des Anbieters. */
  function emptyConnectionDraft(pv) {
    return {
      apiKey: '',
      removeApiKey: false,
      baseUrl: (pv.defaultBaseUrl || '').trim(),
      insecureTls: pv.defaultInsecureTls === true,
      displayName: '',
      apiStyle: pv.form?.defaultApiStyle || 'chat',
      extraHeaders: '',
      removeExtraHeaders: false,
      supportsImages: false,
      sendTools: true,
    };
  }

  /** Entwurf aus einer bestehenden Zeile; Geheimnisse bleiben leer. */
  function connectionDraftFromRow(pv, row) {
    const conn = row?.connection || {};
    return {
      ...emptyConnectionDraft(pv),
      baseUrl: (conn.baseUrl || pv.defaultBaseUrl || '').trim(),
      insecureTls: conn.insecureTls === true,
      displayName: typeof conn.displayName === 'string' ? conn.displayName : '',
      apiStyle: conn.apiStyle || pv.form?.defaultApiStyle || 'chat',
      supportsImages: conn.supportsImages === true,
      sendTools: conn.sendTools !== false,
    };
  }

  /** Der Entwurf, auf den die Formularfelder gerade schreiben. */
  function activeDraft(providerId) {
    const pv = findProviderView(providerId);
    if (usesPresetConnection(pv)) return popupConnectionDraft;
    return settingsCredentialDraft[providerId];
  }

  /**
   * Was zu diesem Entwurf **gespeichert** ist. Bei Verbindung je Eintrag steht
   * das an der Zeile, sonst am Anbieter — die Oberflaeche fragt nur, ob ein
   * Geheimnis liegt, nie welches.
   */
  function activeStored(providerId) {
    const pv = findProviderView(providerId);
    if (!usesPresetConnection(pv)) {
      return { hasKey: !!pv.hasKey, keyUnreadable: !!pv.keyUnreadable, hasExtraHeaders: !!pv.hasExtraHeaders };
    }
    const row = settingsDraftPresets.find((r) => r.id === popupEditPresetId);
    const conn = row?.connection || {};
    return {
      hasKey: conn.hasKey === true,
      keyUnreadable: conn.keyUnreadable === true,
      hasExtraHeaders: conn.hasExtraHeaders === true,
    };
  }

  function findProviderView(providerId) {
    return findProviderMeta(providerId);
  }

  function draftConnectionFor(providerId) {
    const pv = findProviderView(providerId);
    const draft = settingsCredentialDraft[providerId];
    if (!pv || !draft) return undefined;
    return {
      baseUrl: (draft.baseUrl || pv.baseUrl || pv.defaultBaseUrl || '').trim(),
      insecureTls: typeof draft.insecureTls === 'boolean' ? draft.insecureTls : !!pv.insecureTls,
    };
  }

  /**
   * Anbietername, wie er nach dem Speichern dastuende: Der Anzeigename aus dem
   * Entwurf sticht den gespeicherten (Issue #193) — sonst behielte die Liste
   * beim Tippen den alten Namen.
   */
  function draftProviderName(providerId) {
    const pv = findProviderView(providerId);
    if (!pv) return '';
    const draft = settingsCredentialDraft[providerId];
    if (pv.form?.showDisplayName && draft && typeof draft.displayName === 'string') {
      const typed = draft.displayName.trim();
      if (typed) return typed;
      return pv.builtInName || pv.name;
    }
    return pv.name;
  }

  /**
   * Verbindung, gegen die eine Zeile beschriftet wird: die eigene der Zeile
   * (Issue #202), sonst der Entwurf des Anbieters.
   */
  function connectionForRow(pr) {
    if (pr?.connection) return pr.connection;
    return settingsCredentialDraft[pr.providerId] ? draftConnectionFor(pr.providerId) : undefined;
  }

  function presetSublabelForDraft(pr) {
    const pv = findProviderView(pr.providerId);
    if (!pv) return pr.sublabel || '';
    const formatted = formatPresetSublabelFromView(pr, pv, connectionForRow(pr));
    return formatted.text || pr.sublabel || '';
  }

  function presetDetailClassForDraft(pr) {
    const pv = findProviderView(pr.providerId);
    if (!pv) {
      return pr.sublabelStyle === PRESET_DETAIL_STYLES.MONO
        ? 'settings-pref-detail settings-pref-detail--mono'
        : 'settings-pref-detail';
    }
    const formatted = formatPresetSublabelFromView(pr, pv, connectionForRow(pr));
    const style = formatted.text ? formatted.style : pr.sublabelStyle;
    return style === PRESET_DETAIL_STYLES.MONO
      ? 'settings-pref-detail settings-pref-detail--mono'
      : 'settings-pref-detail';
  }

  function presetToWireRow(pr) {
    const row = {
      id: pr.id,
      providerId: pr.providerId,
      model: pr.model,
      menuVisible: pr.menuVisible !== false,
    };
    const pv = findProviderView(pr.providerId);
    for (const field of pv?.presetFields || []) {
      if (field.key && pr[field.key]) {
        row[field.key] = pr[field.key];
      }
    }
    // Verbindung je Eintrag (Issue #202): Die unkritischen Felder plus die
    // Klartext-Geheimnisse, die gerade eingetippt wurden. Die Ja/Nein-Angaben
    // (`hasKey`, `hasExtraHeaders`) bleiben hier — der Main-Prozess weiss
    // selbst, was gespeichert ist.
    if (pr.connection && usesPresetConnection(pv)) {
      const { displayName, baseUrl, apiStyle, insecureTls, supportsImages, sendTools, draft } = pr.connection;
      row.connection = {
        displayName,
        baseUrl,
        apiStyle,
        insecureTls,
        supportsImages,
        sendTools,
        ...(draft || {}),
      };
    }
    return row;
  }

  function setModalError(text) {
    if (text) {
      modalSaveError.textContent = text;
      modalSaveError.classList.remove('hidden');
    } else {
      modalSaveError.textContent = '';
      modalSaveError.classList.add('hidden');
    }
  }

  function setProviderStatus(text, isError = false) {
    providerStatus.textContent = text || '';
    providerStatus.classList.toggle('error', !!isError);
  }

  function setModelStatus(text, isError = false) {
    modelStatus.textContent = text || '';
    modelStatus.classList.toggle('error', !!isError);
  }

  /** Entwurf eines Provider-Zugangs aus der gespeicherten Sicht. */
  function credentialDraftFor(pv) {
    return {
      apiKey: '',
      removeApiKey: false,
      baseUrl: (pv.baseUrl || pv.defaultBaseUrl || '').trim(),
      insecureTls: !!pv.insecureTls,
      // Issue #193: Anzeigename, API-Stil und die beiden Schalter sind
      // gespeicherte Werte; die Zusatz-Header sind ein Geheimnis und kommen wie
      // der API-Key leer herein — die View sagt nur, ob welche liegen.
      displayName: typeof pv.displayName === 'string' ? pv.displayName : '',
      apiStyle: typeof pv.apiStyle === 'string' ? pv.apiStyle : (pv.form?.defaultApiStyle || 'chat'),
      extraHeaders: '',
      removeExtraHeaders: false,
      supportsImages: pv.supportsImages === true,
      sendTools: pv.sendTools !== false,
    };
  }

  function hydrateCredentialDraftFromLlmState() {
    settingsCredentialDraft = {};
    for (const p of appStore.llmState.providers || []) {
      settingsCredentialDraft[p.id] = credentialDraftFor(p);
    }
  }

  function stashPopupCredentialInputs() {
    // Der Entwurf des **angezeigten** Anbieters, nicht der des ausgewaehlten:
    // Beim Anbieterwechsel steht im Auswahlfeld schon der neue, in den Feldern
    // aber noch der alte — ohne diese Unterscheidung wanderte die Server-URL
    // des vorigen Anbieters in den neuen Entwurf.
    const id = popupProviderId || selectProvider?.value;
    if (!id) return;
    const draft = activeDraft(id);
    if (!draft) return;
    const form = findProviderView(id)?.form || {};
    draft.apiKey = (inputApiKey.value || '').trim();
    if (draft.apiKey) draft.removeApiKey = false;
    draft.baseUrl = (inputBaseUrl.value || '').trim();
    draft.insecureTls = !!inputInsecureTls.checked;
    if (form.showDisplayName) draft.displayName = (inputDisplayName.value || '').trim();
    if (form.showApiStyle && selectApiStyle.value) draft.apiStyle = selectApiStyle.value;
    if (form.showExtraHeaders) {
      draft.extraHeaders = inputExtraHeaders.value || '';
      if (draft.extraHeaders.trim()) draft.removeExtraHeaders = false;
    }
    if (form.showSupportsImages) draft.supportsImages = !!inputSupportsImages.checked;
    if (form.showSendTools) draft.sendTools = !!inputSendTools.checked;
    stashPopupPresetFieldValues(id);
  }

  function stashPopupPresetFieldValues(providerId) {
    const pv = findProviderView(providerId);
    if (!pv) return;
    if (!popupPresetFieldValues[providerId]) popupPresetFieldValues[providerId] = {};
    for (const field of pv.presetFields || []) {
      const el = document.getElementById(`preset-field-${field.key}`);
      if (el) popupPresetFieldValues[providerId][field.key] = el.value;
    }
  }

  function renderPresetFieldsPopup(providerView) {
    if (!presetFieldsPopup) return;
    presetFieldsPopup.innerHTML = '';
    const fields = providerView?.presetFields || [];
    if (fields.length === 0) {
      presetFieldsPopup.classList.add('hidden');
      return;
    }
    presetFieldsPopup.classList.remove('hidden');
    const providerId = providerView.id;
    if (!popupPresetFieldValues[providerId]) popupPresetFieldValues[providerId] = {};

    for (const field of fields) {
      const section = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'popup-flow-subhead';
      head.textContent = field.label;
      section.appendChild(head);

      const label = document.createElement('label');
      label.className = 'visually-hidden';
      label.setAttribute('for', `preset-field-${field.key}`);
      label.textContent = field.label;
      section.appendChild(label);

      const select = document.createElement('select');
      select.id = `preset-field-${field.key}`;
      select.className = 'modal-input';
      select.dataset.presetFieldKey = field.key;
      for (const opt of field.options || []) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label || opt.value;
        select.appendChild(option);
      }
      const current = popupPresetFieldValues[providerId][field.key] || field.defaultValue;
      select.value = current;
      popupPresetFieldValues[providerId][field.key] = select.value;
      section.appendChild(select);

      if (field.hint) {
        const hint = document.createElement('p');
        hint.className = 'modal-hint';
        hint.textContent = field.hint;
        section.appendChild(hint);
      }

      select.addEventListener('change', () => {
        popupPresetFieldValues[providerId][field.key] = select.value;
      });

      presetFieldsPopup.appendChild(section);
    }
  }

  function renderProviderSelect() {
    selectProvider.innerHTML = '';
    for (const p of appStore.llmState.providers || []) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.setAttribute('lang', 'en');
      const tags = [];
      if (p.isActiveChatProvider) tags.push('aktiv');
      if (p.configured) tags.push('konfiguriert');
      if (p.keyUnreadable) tags.push('Key neu eingeben');
      opt.textContent = tags.length ? `${p.name} – ${tags.join(', ')}` : p.name;
      selectProvider.appendChild(opt);
    }
    const presetFromActive = settingsDraftPresets.find((x) => x.id === settingsDraftActivePresetId);
    selectProvider.value =
      presetFromActive?.providerId ||
      appStore.llmState.chatTarget?.providerId ||
      appStore.llmState.activeProvider;
  }

  /**
   * Ob der Modellname frei eingetippt werden darf (Issue #193). Bei Anbietern,
   * deren Modellliste nicht garantiert erreichbar ist, waere ein reines
   * Auswahlfeld eine Sackgasse: Ohne Liste gaebe es nichts auszuwaehlen.
   */
  function allowsManualModel(providerView) {
    return providerView?.form?.allowManualModel === true;
  }

  /** Der gerade sichtbare Modellname — je nach Anbieter aus Liste oder Feld. */
  function currentModelValue(providerView) {
    return allowsManualModel(providerView)
      ? (inputModel.value || '').trim()
      : (selectModel.value || '').trim();
  }

  function renderModelSelect(currentValue, options, providerView) {
    const manual = allowsManualModel(providerView);
    selectModel.classList.toggle('hidden', manual);
    inputModel.classList.toggle('hidden', !manual);

    const seen = new Set();
    const known = [];
    if (Array.isArray(options)) {
      for (const m of options) {
        const id = m?.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        known.push({ id, label: m.label || id });
      }
    }

    if (manual) {
      // Der eingetippte Name hat Vorrang vor allem, was spaeter noch laedt —
      // sonst verschwaende er, sobald die Liste doch ankommt.
      const typed = (inputModel.value || '').trim();
      inputModel.value = typed || currentValue || '';
      inputModel.placeholder = known.length
        ? known[0].id
        : 'Modellname, z. B. qwen2.5-coder-7b';
      modelNameOptions.innerHTML = '';
      for (const m of known) {
        const opt = document.createElement('option');
        opt.value = m.id;
        if (m.label !== m.id) opt.label = m.label;
        modelNameOptions.appendChild(opt);
      }
      return;
    }

    selectModel.innerHTML = '';
    const added = new Set();
    const add = (id, label) => {
      if (!id || added.has(id)) return;
      added.add(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.setAttribute('lang', 'en');
      opt.textContent = label || id;
      selectModel.appendChild(opt);
    };
    for (const m of known) add(m.id, m.label);
    if (currentValue) add(currentValue, currentValue);
    if (selectModel.children.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— noch keine Modelle geladen —';
      opt.disabled = true;
      selectModel.appendChild(opt);
    } else if (currentValue) {
      selectModel.value = currentValue;
    }
  }

  /** Vorlagen-Auswahl (Issue #193): belegt Felder vor, speichert sich nie. */
  function renderProviderTemplates(providerView) {
    const templates = providerView?.form?.templates || [];
    if (templates.length === 0) {
      providerTemplateRow.classList.add('hidden');
      selectProviderTemplate.innerHTML = '';
      providerTemplateHint.textContent = '';
      return;
    }
    providerTemplateRow.classList.remove('hidden');
    selectProviderTemplate.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Vorlage wählen —';
    selectProviderTemplate.appendChild(placeholder);
    for (const template of templates) {
      const opt = document.createElement('option');
      opt.value = template.id;
      opt.textContent = template.label;
      selectProviderTemplate.appendChild(opt);
    }
    selectProviderTemplate.value = '';
    providerTemplateHint.textContent =
      'Belegt Server-URL und API-Stil vor; danach ist jedes Feld frei änderbar. Die Vorlage selbst wird nicht gespeichert.';
  }

  function applyProviderTemplate(providerId, templateId) {
    const pv = findProviderView(providerId);
    const template = (pv?.form?.templates || []).find((t) => t.id === templateId);
    const draft = activeDraft(providerId);
    if (!template || !draft) return;
    draft.baseUrl = template.baseUrl || '';
    draft.apiStyle = template.apiStyle || 'chat';
    syncPopupProviderUI(providerId, true);
    // Die Auswahl selbst bleibt sichtbar, damit klar ist, woher die Werte
    // kommen — gespeichert wird sie nicht.
    selectProviderTemplate.value = templateId;
    providerTemplateHint.textContent = template.hint
      || 'Werte übernommen; jedes Feld lässt sich jetzt überschreiben.';
    renderDraftPresetList();
  }

  function syncPopupProviderUI(providerId, skipStash, { resetModel = !skipStash } = {}) {
    const pv = findProviderView(providerId);
    if (!pv) return;
    if (!skipStash) stashPopupCredentialInputs();

    popupProviderId = providerId;
    selectProvider.value = providerId;

    const form = pv.form || {};
    if (usesPresetConnection(pv)) {
      // Beim Wechsel auf diesen Anbieter beginnt eine neue Zeile, sofern nicht
      // gerade eine bestehende bearbeitet wird (Issue #202).
      if (!popupConnectionDraft) {
        const row = settingsDraftPresets.find((r) => r.id === popupEditPresetId);
        popupConnectionDraft = row ? connectionDraftFromRow(pv, row) : emptyConnectionDraft(pv);
      }
    } else if (!settingsCredentialDraft[providerId]) {
      settingsCredentialDraft[providerId] = credentialDraftFor(pv);
    }
    const draft = activeDraft(providerId) || credentialDraftFor(pv);
    const stored = activeStored(providerId);

    renderProviderTemplates(pv);

    if (form.showDisplayName) {
      providerDisplayNameRow.classList.remove('hidden');
      inputDisplayName.value = draft.displayName || '';
      inputDisplayName.placeholder = form.displayNamePlaceholder || pv.builtInName || pv.name;
    } else {
      providerDisplayNameRow.classList.add('hidden');
      inputDisplayName.value = '';
    }

    if (form.showApiKey) {
      providerKeyRow.classList.remove('hidden');
      inputApiKey.value = draft.apiKey || '';
      if (draft.removeApiKey && stored.hasKey) {
        inputApiKey.placeholder = 'Key wird beim Speichern entfernt';
      } else if (stored.hasKey) {
        inputApiKey.placeholder = 'Gespeicherter Key bleibt erhalten';
      } else {
        inputApiKey.placeholder = form.apiKeyPlaceholder || '••••••';
      }
      const showTrash =
        stored.hasKey || !!(draft.apiKey || '').trim() || draft.removeApiKey;
      btnRemoveApiKey?.classList.toggle('hidden', !showTrash);
      // Ein optionaler Key braucht die Ansage, dass leer in Ordnung ist —
      // sonst liest sich das leere Feld wie eine fehlende Angabe (Issue #193).
      providerKeyHint?.classList.toggle('hidden', form.apiKeyOptional !== true);
    } else {
      providerKeyRow.classList.add('hidden');
      inputApiKey.value = '';
      btnRemoveApiKey?.classList.add('hidden');
      providerKeyHint?.classList.add('hidden');
    }

    if (form.showExtraHeaders) {
      providerExtraHeadersRow.classList.remove('hidden');
      inputExtraHeaders.value = draft.extraHeaders || '';
      if (draft.removeExtraHeaders && stored.hasExtraHeaders) {
        inputExtraHeaders.placeholder = 'Header werden beim Speichern entfernt';
      } else if (stored.hasExtraHeaders) {
        inputExtraHeaders.placeholder = 'Gespeicherte Header bleiben erhalten';
      } else {
        inputExtraHeaders.placeholder = 'X-Gateway-Token: …';
      }
      const showHeaderTrash =
        stored.hasExtraHeaders || !!(draft.extraHeaders || '').trim() || draft.removeExtraHeaders;
      btnRemoveExtraHeaders?.classList.toggle('hidden', !showHeaderTrash);
    } else {
      providerExtraHeadersRow.classList.add('hidden');
      inputExtraHeaders.value = '';
      btnRemoveExtraHeaders?.classList.add('hidden');
    }

    if (form.showApiStyle) {
      providerApiStyleRow.classList.remove('hidden');
      selectApiStyle.innerHTML = '';
      for (const option of form.apiStyleOptions || []) {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = option.label;
        selectApiStyle.appendChild(opt);
      }
      selectApiStyle.value = draft.apiStyle || form.defaultApiStyle || 'chat';
    } else {
      providerApiStyleRow.classList.add('hidden');
      selectApiStyle.innerHTML = '';
    }

    if (form.showBaseUrl) {
      providerBaseUrlRow.classList.remove('hidden');
      inputBaseUrl.value = draft.baseUrl || pv.baseUrl || pv.defaultBaseUrl || '';
      inputBaseUrl.placeholder = form.baseUrlPlaceholder || '';
    } else {
      providerBaseUrlRow.classList.add('hidden');
      inputBaseUrl.value = '';
    }

    if (form.showInsecureTls) {
      providerInsecureRow.classList.remove('hidden');
      inputInsecureTls.checked = !!draft.insecureTls;
    } else {
      providerInsecureRow.classList.add('hidden');
      inputInsecureTls.checked = false;
    }

    if (form.showSendTools) {
      providerSendToolsRow.classList.remove('hidden');
      inputSendTools.checked = draft.sendTools !== false;
    } else {
      providerSendToolsRow.classList.add('hidden');
      inputSendTools.checked = false;
    }

    if (form.showSupportsImages) {
      providerSupportsImagesRow.classList.remove('hidden');
      inputSupportsImages.checked = draft.supportsImages === true;
    } else {
      providerSupportsImagesRow.classList.add('hidden');
      inputSupportsImages.checked = false;
    }

    renderPresetFieldsPopup(pv);

    if (modelLoadProviderLabel) {
      modelLoadProviderLabel.textContent = draftProviderName(providerId) || pv.name;
    }

    // Beim Anbieterwechsel und beim Oeffnen steht der gespeicherte Name im
    // Feld, nicht der stehengebliebene des vorigen Anbieters.
    if (resetModel) inputModel.value = '';
    renderModelSelect(pv.model || pv.defaultModel || '', null, pv);

    const lines = [];
    // Bei einem Anbieter mit Server-URL steht dort, wohin es wirklich geht —
    // die Standard-URL waere bei einem geaenderten Ziel schlicht falsch.
    const shownApiBase = form.showBaseUrl ? (draft.baseUrl || pv.apiBase) : pv.apiBase;
    if (shownApiBase) lines.push(`API: ${shownApiBase}`);
    if (pv.isActiveChatProvider) lines.push('Aktueller Chat-Anbieter');
    if (form.showApiKey) {
      if (draft.removeApiKey && stored.hasKey) {
        lines.push('Key wird beim Speichern entfernt');
      } else if (stored.keyUnreadable && !draft.apiKey) {
        lines.push('Gespeicherter API-Key kann nicht mehr entschlüsselt werden (z. B. nach der Umbenennung der App in Snotra AI). Bitte den Key neu eingeben.');
      } else if (stored.hasKey && !draft.apiKey) {
        lines.push('Key gespeichert');
      } else if (draft.apiKey) {
        lines.push('Neuer Key wird beim Speichern gesetzt');
      } else if (form.apiKeyOptional) {
        // Kein Key ist hier ein gueltiger Zustand und soll auch so dastehen.
        lines.push('Ohne API-Schlüssel');
      }
    } else if (pv.configured) {
      lines.push('Konfiguriert');
    }
    if (form.showExtraHeaders) {
      if (draft.removeExtraHeaders && stored.hasExtraHeaders) {
        lines.push('Header werden beim Speichern entfernt');
      } else if ((draft.extraHeaders || '').trim()) {
        lines.push('Neue Header werden beim Speichern gesetzt');
      } else if (stored.hasExtraHeaders) {
        lines.push('Header gespeichert');
      }
    }
    setProviderStatus(lines.join(' · '), false);
    setModelStatus('');
    setModalError('');
  }

  function renderDraftPresetList() {
    if (!prefModelList) return;
    prefModelList.innerHTML = '';
    const empty = settingsDraftPresets.length === 0;
    prefListEmpty.classList.toggle('hidden', !empty);
    const editSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>';
    const trashSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

    for (const pr of settingsDraftPresets) {
      const pv = findProviderView(pr.providerId);
      if (!pv) continue;
      const li = document.createElement('li');

      const row = document.createElement('div');
      row.className = 'settings-pref-row-inner';
      row.dataset.presetId = pr.id;
      if (pr.menuVisible === false) row.setAttribute('data-pref-menu-off', 'true');
      else row.removeAttribute('data-pref-menu-off');

      const main = document.createElement('div');
      main.className = 'settings-pref-main';
      const title = document.createElement('strong');
      title.lang = 'en';
      // Bei Verbindung je Eintrag traegt die Zeile ihren eigenen Namen.
      const zeilenName = pr.connection
        ? (pr.connection.displayName?.trim() || pv.builtInName || pv.name)
        : (draftProviderName(pr.providerId) || pv.name);
      title.textContent = `${zeilenName} · ${pr.model || pv.defaultModel}`
        + (pr.optionSuffix ? ` · ${pr.optionSuffix}` : '');
      const detail = document.createElement('span');
      detail.className = presetDetailClassForDraft(pr);
      detail.textContent = presetSublabelForDraft(pr);
      main.appendChild(title);
      main.appendChild(detail);

      const actions = document.createElement('div');
      actions.className = 'settings-pref-actions';

      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'settings-pref-switch';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', pr.menuVisible !== false ? 'true' : 'false');
      sw.setAttribute(
        'aria-label',
        `${pr.label || pv.name} — ${pr.menuVisible !== false ? 'im Chat-Modellmenü sichtbar' : 'im Chat ausgeblendet'}`
      );
      sw.dataset.presetId = pr.id;
      const track = document.createElement('span');
      track.className = 'settings-pref-switch-track';
      track.setAttribute('aria-hidden', 'true');
      const knob = document.createElement('span');
      knob.className = 'settings-pref-switch-knob';
      track.appendChild(knob);
      sw.appendChild(track);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'settings-icon-trash';
      rm.setAttribute(
        'aria-label',
        `${pr.label || pv.name} aus der Liste entfernen`
      );
      rm.dataset.presetId = pr.id;
      rm.innerHTML = trashSvg;

      // Bearbeiten (Issue #202): Seit die Verbindung zur Zeile gehoert, muss
      // sich eine bestehende Zeile aendern lassen. Ein eigener Knopf statt
      // einer klickbaren Zeile — die Zeile traegt schon Schalter und
      // Papierkorb, und ineinander verschachtelte Bedienelemente sind fuer
      // Tastatur und Screenreader kaputt.
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'settings-icon-edit';
      edit.setAttribute('aria-label', `${pr.label || pv.name} bearbeiten`);
      edit.dataset.editPresetId = pr.id;
      edit.innerHTML = editSvg;

      actions.appendChild(edit);
      actions.appendChild(sw);
      actions.appendChild(rm);
      row.appendChild(main);
      row.appendChild(actions);
      li.appendChild(row);
      prefModelList.appendChild(li);
    }
  }

  /**
   * Einstellungen › Tools › Verfügbare Tools (Issue #98).
   *
   * Gruppiert nach Risikoklasse; je Zeile Häkchen, Name und Kurztext. Der
   * Volltext aus der Registry klappt auf Wunsch darunter auf — als Button mit
   * `aria-expanded`, damit er auch per Tastatur erreichbar ist. Die Klasse
   * steht einmal im Gruppenkopf statt als Badge in jeder Zeile.
   */
  function renderToolList() {
    if (!settingsToolList) return;
    settingsToolList.innerHTML = '';
    const empty = settingsToolCatalog.length === 0;
    settingsToolListEmpty?.classList.toggle('hidden', !empty);

    for (const group of groupToolCatalog(settingsToolCatalog)) {
      settingsToolList.appendChild(renderToolGroup(group));
    }
    syncToolGroupHeads();
  }

  function renderToolGroup(group) {
    const section = document.createElement('section');
    section.className = 'settings-tool-group';
    section.dataset.riskClass = group.riskClass;

    const head = document.createElement('div');
    head.className = 'settings-tool-group__head';

    const title = document.createElement('h4');
    title.className = 'settings-tool-group__title';
    title.id = `heading-tool-group-${group.riskClass}`;
    title.textContent = group.label;
    head.appendChild(title);

    if (group.note) {
      const note = document.createElement('span');
      note.className = 'settings-tool-group__note';
      note.textContent = group.note;
      head.appendChild(note);
    }

    const count = document.createElement('span');
    count.className = 'settings-tool-group__count';
    head.appendChild(count);

    const toggleAll = document.createElement('button');
    toggleAll.type = 'button';
    toggleAll.className = 'settings-tool-group__all';
    toggleAll.dataset.riskClass = group.riskClass;
    head.appendChild(toggleAll);

    section.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'settings-tool-rows';
    list.setAttribute('aria-labelledby', title.id);
    for (const tool of group.tools) list.appendChild(renderToolRow(tool));
    section.appendChild(list);
    return section;
  }

  function renderToolRow(tool) {
    const li = document.createElement('li');
    li.className = 'settings-tool-row';

    const label = document.createElement('label');
    label.className = 'settings-tool-row__check';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.toolName = tool.name;
    input.checked = !settingsDisabledToolsDraft.has(tool.name);
    label.appendChild(input);

    const name = document.createElement('code');
    name.className = 'settings-tool-row__name';
    name.setAttribute('lang', 'en');
    name.textContent = tool.name;
    label.appendChild(name);
    li.appendChild(label);

    const short = toolShortText(tool);
    const detail = toolDetailText(tool);
    const badge = toolStatusBadge(tool, { pythonReady, shellReady, webSearchHasKey });

    if (detail) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'settings-tool-row__summary';
      toggle.setAttribute('aria-expanded', 'false');
      const descId = `tool-desc-${tool.name}`;
      toggle.setAttribute('aria-controls', descId);

      const shortEl = document.createElement('span');
      shortEl.className = 'settings-tool-row__short';
      shortEl.textContent = short;
      toggle.appendChild(shortEl);
      if (badge) toggle.appendChild(toolBadgeElement(badge));
      toggle.insertAdjacentHTML('beforeend', CHEVRON_ICON_HTML);
      li.appendChild(toggle);

      const desc = document.createElement('p');
      desc.className = 'settings-tool-row__desc';
      desc.id = descId;
      desc.textContent = detail;
      desc.hidden = true;
      li.appendChild(desc);

      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
        desc.hidden = open;
        li.classList.toggle('settings-tool-row--open', !open);
      });
    } else {
      const shortEl = document.createElement('span');
      shortEl.className = 'settings-tool-row__short settings-tool-row__short--plain';
      shortEl.textContent = short;
      li.appendChild(shortEl);
      if (badge) li.appendChild(toolBadgeElement(badge));
    }

    return li;
  }

  function toolBadgeElement({ text, title }) {
    const badge = document.createElement('span');
    badge.className = 'settings-tool-item__badge settings-tool-row__badge';
    badge.textContent = text;
    badge.title = title;
    return badge;
  }

  /** Zähler und Schalterbeschriftung je Gruppe nach jeder Änderung angleichen. */
  function syncToolGroupHeads() {
    if (!settingsToolList) return;
    for (const section of settingsToolList.querySelectorAll('.settings-tool-group')) {
      const boxes = [...section.querySelectorAll('input[type="checkbox"][data-tool-name]')];
      if (boxes.length === 0) continue;
      const active = boxes.filter((box) => box.checked).length;
      const count = section.querySelector('.settings-tool-group__count');
      if (count) count.textContent = groupCountLabel(boxes.length, active);
      const toggleAll = section.querySelector('.settings-tool-group__all');
      if (toggleAll) toggleAll.textContent = groupToggleLabel(boxes.length, active);
    }
  }

  /** „alle an/aus“ im Gruppenkopf: setzt nur den Entwurf, gespeichert wird mit „Übernehmen“. */
  function toggleToolGroup(section) {
    const boxes = [...section.querySelectorAll('input[type="checkbox"][data-tool-name]')];
    if (boxes.length === 0) return;
    const turnOn = boxes.some((box) => !box.checked);
    for (const box of boxes) {
      box.checked = turnOn;
      const name = box.dataset.toolName;
      if (!name) continue;
      if (turnOn) settingsDisabledToolsDraft.delete(name);
      else settingsDisabledToolsDraft.add(name);
    }
    syncToolGroupHeads();
  }

  function renderSkillList() {
    if (!settingsSkillList) return;
    settingsSkillList.innerHTML = '';
    settingsSkillListEmpty?.classList.toggle('hidden', settingsSkillCatalog.length > 0);

    for (const source of SKILL_SOURCE_ORDER) {
      const group = settingsSkillCatalog.filter((skill) => skill.source === source);
      if (group.length === 0) continue;

      const heading = document.createElement('li');
      heading.className = 'settings-skill-group';
      heading.textContent = SKILL_SOURCE_LABELS[source] || source;
      settingsSkillList.appendChild(heading);

      for (const skill of group) {
        settingsSkillList.appendChild(renderSkillItem(skill));
      }
    }
  }

  let skillBodyId = 0;

  function renderSkillItem(skill) {
    const li = document.createElement('li');
    li.className = 'settings-tool-item';
    const usable = skill.status === SKILL_STATUS.ACTIVE || skill.status === SKILL_STATUS.AVAILABLE;

    const label = document.createElement('label');
    label.className = 'modal-checkbox settings-tool-item__checkbox';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.skillName = skill.name;
    input.checked = usable && settingsActiveSkillsDraft.has(skill.name);
    input.disabled = !usable;

    const main = document.createElement('span');
    main.className = 'settings-tool-item__main';
    const name = document.createElement('code');
    name.className = 'settings-tool-item__name';
    name.setAttribute('lang', 'en');
    name.textContent = skill.name;
    main.appendChild(name);

    if (!usable) {
      const badge = document.createElement('span');
      badge.className = 'settings-tool-item__badge';
      badge.textContent = skill.status === SKILL_STATUS.SHADOWED ? 'überdeckt' : 'ungültig';
      if (skill.detail) badge.title = skill.detail;
      main.appendChild(badge);
    }

    label.appendChild(input);
    label.appendChild(main);
    li.appendChild(label);

    const detailText = usable ? skill.description : skill.detail || skill.description;
    if (!detailText && !skill.path) return li;

    // Wie im Tool-Katalog (Issue #98/#104): in der Zeile steht eine Zeile
    // Kurztext, Beschreibung und Pfad kommen erst beim Aufklappen.
    const bodyId = `skill-desc-${skillBodyId += 1}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'settings-tool-row__summary settings-skill-item__summary';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', bodyId);

    const shortEl = document.createElement('span');
    shortEl.className = 'settings-tool-row__short';
    shortEl.textContent = detailText || skill.path;
    toggle.appendChild(shortEl);
    toggle.insertAdjacentHTML('beforeend', CHEVRON_ICON_HTML);
    li.appendChild(toggle);

    const body = document.createElement('div');
    body.className = 'settings-skill-item__body';
    body.id = bodyId;
    body.hidden = true;
    if (detailText) {
      const desc = document.createElement('p');
      desc.className = 'settings-tool-item__desc';
      desc.textContent = detailText;
      body.appendChild(desc);
    }
    if (skill.path) {
      const pathEl = document.createElement('p');
      pathEl.className = 'settings-tool-item__desc settings-skill-item__path';
      pathEl.textContent = skill.path;
      body.appendChild(pathEl);
    }
    li.appendChild(body);

    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      body.hidden = open;
      li.classList.toggle('settings-tool-row--open', !open);
    });

    return li;
  }

  function adoptSkillCatalog(result) {
    settingsSkillCatalog = Array.isArray(result?.skills) ? result.skills : [];
    // Der Katalog kennt bereits die Voreinstellung (System-Skills an), wenn in
    // den Prefs noch nichts gespeichert ist — daher den Entwurf daraus ableiten.
    settingsActiveSkillsDraft = new Set(
      settingsSkillCatalog
        .filter((skill) => skill.status === SKILL_STATUS.ACTIVE)
        .map((skill) => skill.name)
    );
    renderSkillList();
  }

  async function loadSkillCatalog({ reload = false } = {}) {
    try {
      // Der Workspace-Root kommt aus dem Main-Prozess (Issue #68).
      const call = reload ? api.reloadSkills : api.getSkillCatalog;
      const result = typeof call === 'function' ? await call() : null;
      adoptSkillCatalog(result);
    } catch {
      adoptSkillCatalog(null);
    }
  }

  /**
   * Katalog neu holen, ohne die noch nicht gespeicherten Haekchen zu
   * verlieren — sowohl fuer „Skills neu laden“ als auch fuer die Meldung des
   * Datei-Watchers (Issue #126).
   *
   * `reload` leert zusaetzlich den Scan-Cache im Main. Beim Watcher ist das
   * schon passiert, beim Knopfdruck ist es der ganze Zweck.
   */
  async function refreshSkillCatalogKeepingSelection({ reload = false } = {}) {
    const previous = new Set(settingsActiveSkillsDraft);
    await loadSkillCatalog({ reload });
    for (const name of previous) {
      if (settingsSkillCatalog.some((skill) => skill.name === name)) {
        settingsActiveSkillsDraft.add(name);
      }
    }
    renderSkillList();
  }

  async function loadToolCatalog() {
    try {
      const result = typeof api.getToolCatalog === 'function' ? await api.getToolCatalog() : null;
      settingsToolCatalog = Array.isArray(result?.tools) ? result.tools : [];
    } catch {
      settingsToolCatalog = [];
    }
    renderToolList();
  }

  function setWebSearchStatus(text, isError = false) {
    if (!webSearchStatusEl) return;
    webSearchStatusEl.textContent = text || '';
    webSearchStatusEl.classList.toggle('error', !!isError);
  }

  function syncWebSearchUI({ encryptionAvailable = true } = {}) {
    if (!inputWebSearchKey) return;
    inputWebSearchKey.value = '';
    inputWebSearchKey.placeholder = webSearchHasKey ? '••••••••  (gespeichert)' : 'tvly-…';
    if (btnWebSearchClear) btnWebSearchClear.disabled = !webSearchHasKey;
    if (!encryptionAvailable) {
      if (btnWebSearchSave) btnWebSearchSave.disabled = true;
      setWebSearchStatus(
        'Verschlüsselter Speicher ist auf diesem System nicht verfügbar — ein Schlüssel kann nicht sicher abgelegt werden.',
        true,
      );
      return;
    }
    if (btnWebSearchSave) btnWebSearchSave.disabled = false;
    setWebSearchStatus(
      webSearchHasKey
        ? 'Ein Schlüssel ist hinterlegt; web_search wird dem Modell angeboten.'
        : 'Kein Schlüssel hinterlegt — web_search wird dem Modell nicht angeboten.',
    );
  }

  function describePythonState(state) {
    if (!state || state.available === false) {
      return { text: 'Python-Ausführung ist in dieser Installation nicht verfügbar.', isError: true };
    }
    if (!state.found) {
      const grund = state.error ? ` (${state.error})` : '';
      return state.source === 'override'
        ? { text: `Der angegebene Interpreter lässt sich nicht starten${grund}.`, isError: true }
        : { text: `Kein Python 3 gefunden${grund}. run_python wird nicht angeboten.`, isError: true };
    }
    const wo = state.source === 'override' ? 'Eigener Interpreter' : 'Gefunden';
    const version = state.version ? ` — ${state.version}` : '';
    // Woher der PATH kam, gehoert sichtbar dazu (Issue #111): aus dem Finder
    // gestartet faende die App sonst still einen anderen Python als im
    // Terminal, und niemand koennte sich erklaeren, warum.
    const woher = state.pathSource === 'login-shell'
      ? ' (gesucht im PATH aus deinem Shell-Profil)'
      : '';
    if (!state.enabled) {
      return { text: `${wo}: ${state.command}${version}${woher}. Noch nicht erlaubt, run_python wird nicht angeboten.` };
    }
    return { text: `${wo}: ${state.command}${version}${woher}. run_python wird dem Modell angeboten.` };
  }

  function setPythonStatus({ text, isError = false }) {
    if (!pythonStatusEl) return;
    pythonStatusEl.textContent = text || '';
    pythonStatusEl.classList.toggle('error', !!isError);
  }

  async function loadPythonState() {
    let state = null;
    try {
      state = typeof api.getPythonState === 'function' ? await api.getPythonState() : null;
    } catch {
      state = null;
    }
    pythonReady = state?.found === true && state?.enabled === true;
    setPythonStatus(describePythonState(state));
  }

  function describeShellState(state) {
    if (!state || state.available === false) {
      return { text: 'Shell-Ausführung ist in dieser Installation nicht verfügbar.', isError: true };
    }
    if (!state.found) {
      const grund = state.error ? ` (${state.error})` : '';
      return { text: `Keine Shell gefunden${grund}. shell_execute wird nicht angeboten.`, isError: true };
    }
    // Login-Shell heisst: dein Profil wird gelesen, Homebrew & Co. sind da.
    // Interaktiv erkannt heisst zusaetzlich: auch `.zshrc` war dabei (#111).
    const wie = state.login ? ' als Login-Shell' : '';
    const path = state.path
      ? state.interactive
        ? ' — dein PATH aus dem Profil inkl. .zshrc, einmal beim Start gelesen'
        : ' — dein PATH aus dem Profil, einmal beim Start gelesen'
      : '';
    const wo = `Gefunden: ${state.label || state.command}${wie}${path}`;
    if (!state.enabled) {
      return { text: `${wo}. Noch nicht erlaubt, shell_execute wird nicht angeboten.` };
    }
    return { text: `${wo}. shell_execute wird dem Modell angeboten.` };
  }

  function setShellStatus({ text, isError = false }) {
    if (!shellStatusEl) return;
    shellStatusEl.textContent = text || '';
    shellStatusEl.classList.toggle('error', !!isError);
  }

  async function loadShellState() {
    let state = null;
    try {
      state = typeof api.getShellState === 'function' ? await api.getShellState() : null;
    } catch {
      state = null;
    }
    shellReady = state?.found === true && state?.enabled === true;
    setShellStatus(describeShellState(state));
  }

  async function loadWebSearchState() {
    let state = null;
    try {
      state = typeof api.getWebSearchState === 'function' ? await api.getWebSearchState() : null;
    } catch {
      state = null;
    }
    webSearchHasKey = state?.hasApiKey === true;
    syncWebSearchUI({ encryptionAvailable: state?.encryptionAvailable !== false });
  }

  async function saveWebSearchApiKey(value) {
    if (typeof api.setWebSearchApiKey !== 'function') return;
    let result = null;
    try {
      result = await api.setWebSearchApiKey(value);
    } catch (e) {
      setWebSearchStatus(e?.message || 'Der Schlüssel konnte nicht gespeichert werden.', true);
      return;
    }
    if (!result?.ok) {
      setWebSearchStatus(result?.error || 'Der Schlüssel konnte nicht gespeichert werden.', true);
      return;
    }
    webSearchHasKey = result.hasApiKey === true;
    syncWebSearchUI();
    // Das Haekchen-Abzeichen „Schluessel fehlt" haengt am selben Zustand.
    renderToolList();
  }

  btnWebSearchSave?.addEventListener('click', () => {
    const value = String(inputWebSearchKey?.value ?? '').trim();
    if (!value) {
      setWebSearchStatus('Bitte zuerst einen Schlüssel eingeben.', true);
      return;
    }
    saveWebSearchApiKey(value);
  });

  btnWebSearchClear?.addEventListener('click', () => {
    saveWebSearchApiKey('');
  });

  function activateSettingsPanel(panelKey) {
    document.querySelectorAll('.settings-panel').forEach((p) => {
      const on = p.id === `panel-settings-${panelKey}`;
      p.classList.toggle('settings-panel--active', on);
      p.hidden = !on;
      p.toggleAttribute('hidden', !on);
    });
    settingsNavTabs.forEach((tab) => {
      const on = tab.dataset.settingsPanel === panelKey;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });
    settingsPanelHeadingEl.textContent =
      SETTINGS_NAV_LABELS[panelKey] || SETTINGS_NAV_LABELS.models;
    const applyHint = document.getElementById('settings-apply-hint');
    if (applyHint) {
      applyHint.innerHTML = IMMEDIATE_PANELS.has(panelKey) ? APPLY_HINT_IMMEDIATE : APPLY_HINT_DEFERRED;
    }
  }

  function setupDraftFromServerState() {
    const raw = appStore.llmState.presets || [];
    try {
      settingsDraftPresets = structuredClone(raw);
    } catch {
      settingsDraftPresets = JSON.parse(JSON.stringify(raw));
    }
    settingsDraftActivePresetId =
      appStore.llmState.activePresetId || settingsDraftPresets[0]?.id || null;
    hydrateCredentialDraftFromLlmState();
    popupPresetFieldValues = {};
  }

  function applyShellLocale(lc) {
    document.documentElement.lang = lc === 'en' ? 'en' : 'de';
  }

  /**
   * Der gerade offene Unterdialog — es gibt inzwischen zwei („Modell
   * hinzufuegen" und MCP, Issue #109). Frueher stand hier fest das
   * Modell-Overlay; ein offener MCP-Dialog haette den Tab-Fokus dann in den
   * Dialog dahinter entkommen lassen.
   */
  function openNestedOverlay() {
    return [...document.querySelectorAll('.add-model-overlay')].find(
      (node) => !node.classList.contains('hidden')
    ) || null;
  }

  function getFocusableInSettingsModal() {
    const overlay = openNestedOverlay();
    if (overlay) {
      const nested = overlay.querySelector('.add-model-dialog');
      if (!nested) return [];
      return [...nested.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter((el) => el.offsetParent !== null);
    }
    const dlg = modalSettings.querySelector('.modal-dialog.settings-dialog');
    if (!dlg) return [];
    return [...dlg.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => {
      const inOverlay = !!el.closest('.add-model-overlay');
      return !inOverlay && el.offsetParent !== null;
    });
  }

  function handleModalKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Ein offener Unterdialog schliesst zuerst sich selbst. Fremde
      // Unterdialoge (MCP) behandeln Escape in ihrer eigenen Komponente und
      // stoppen das Ereignis vorher — hier kommt dann gar nichts mehr an.
      if (addModelOverlay && !addModelOverlay.classList.contains('hidden')) {
        closeAddModelOverlay();
        return;
      }
      if (openNestedOverlay()) return;
      closeSettingsModal();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = getFocusableInSettingsModal();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /**
   * Oeffnet das Popup. Mit `presetId` bearbeitet es eine bestehende Zeile
   * (Issue #202) — bei Verbindung je Eintrag der einzige Weg, Server-URL oder
   * Schluessel einer schon angelegten Zeile zu aendern.
   */
  function openAddModelOverlay({ presetId = null } = {}) {
    stashPopupCredentialInputs();
    popupEditPresetId = presetId;
    popupConnectionDraft = null;
    addModelOverlay.classList.remove('hidden');
    addModelOverlay.setAttribute('aria-hidden', 'false');
    renderProviderSelect();

    const row = presetId ? settingsDraftPresets.find((r) => r.id === presetId) : null;
    if (row) {
      selectProvider.value = row.providerId;
      const pv = findProviderView(row.providerId);
      if (usesPresetConnection(pv)) popupConnectionDraft = connectionDraftFromRow(pv, row);
    }
    const pid = selectProvider.value;
    syncPopupProviderUI(pid, true, { resetModel: true });
    if (row) {
      const pv = findProviderView(row.providerId);
      if (allowsManualModel(pv)) inputModel.value = row.model || '';
      else renderModelSelect(row.model || '', null, pv);
    }
    setDialogMode(!!row);
    // Beim Bearbeiten steht der Anbieter fest: Ein Wechsel waere ein anderer
    // Eintrag, kein bearbeiteter.
    selectProvider.disabled = !!row;
  }

  /** Beschriftungen des Popups: anlegen oder bearbeiten. */
  function setDialogMode(editing) {
    if (addModelTitle) {
      addModelTitle.textContent = editing ? 'Modell bearbeiten' : 'Modell hinzufügen';
    }
    if (btnAddPresetRow) {
      btnAddPresetRow.textContent = editing ? 'Änderungen übernehmen' : 'Übernehmen';
    }
    // Die Einleitung spricht sonst weiter vom Hinzufuegen, waehrend man
    // gerade eine bestehende Zeile aendert.
    if (addModelIntroLead) {
      addModelIntroLead.innerHTML = editing
        ? 'Zugang und Modell dieses Eintrags ändern; <strong>Änderungen übernehmen</strong> ersetzt die Zeile.'
        : 'Zugang und Modell gemeinsam einstellen und mit <strong>Übernehmen</strong> in die Präferenzliste legen.';
    }
  }

  let modelRequestGeneration = 0;
  function cancelModelListing() {
    modelRequestGeneration += 1;
    void api.cancelModelListing?.().catch(() => {});
    btnLoadModels.disabled = false;
    setModelStatus('');
  }

  function closeAddModelOverlay() {
    cancelModelListing();
    stashPopupCredentialInputs();
    popupEditPresetId = null;
    popupConnectionDraft = null;
    selectProvider.disabled = false;
    setDialogMode(false);
    addModelOverlay.classList.add('hidden');
    addModelOverlay.setAttribute('aria-hidden', 'true');
    btnOpenAddModel?.focus?.();
  }

  /**
   * @param {{ panel?: string, skillName?: string }} [request]
   *   Optionaler Sprung an eine bestimmte Stelle — heute aus der
   *   Token-Aufschlüsselung im Composer zum Schalter eines Skills (Issue #174).
   *   Der Knopf im Chat haengt direkt als Click-Handler dran und liefert ein
   *   Event; deshalb wird nur ein echtes Options-Objekt beachtet.
   */
  async function openSettingsModal(request) {
    const jump =
      request && typeof request === 'object' && typeof request.panel === 'string' ? request : null;
    stopChatVoiceListening();
    setModalError('');
    setProviderStatus('');
    setModelStatus('');
    btnSettingsSave.disabled = true;
    closeChatModelMenu(false);
    appStore.lastFocusBeforeModal = document.activeElement;
    modalSettings.classList.remove('hidden');
    modalSettings.setAttribute('aria-hidden', 'false');
    modalSettings.addEventListener('keydown', handleModalKeydown);
    try {
      await refreshLLMState();
      setupDraftFromServerState();
    } catch (err) {
      setModalError(`Einstellungen konnten nicht geladen werden: ${err.message || 'Unbekannter Fehler'}`);
      modalEncryptionWarning.classList.add('hidden');
      return;
    } finally {
      btnSettingsSave.disabled = false;
    }
    modalEncryptionWarning.classList.toggle('hidden', appStore.llmState.encryptionAvailable);
    activateSettingsPanel(jump && SETTINGS_NAV_LABELS[jump.panel] ? jump.panel : 'models');
    try {
      const up = await api.getUIPrefs();
      inputGlobalSystemPrompt.value = typeof up.baseSystemPrompt === 'string' ? up.baseSystemPrompt : '';
      selectAppLocale.value = up.appLocale === 'en' ? 'en' : 'de';
      if (selectSkillSuggestionMode) {
        selectSkillSuggestionMode.value = isSkillSuggestionMode(up.skillSuggestionMode)
          ? up.skillSuggestionMode
          : DEFAULT_SKILL_SUGGESTION_MODE;
      }
      const mtr =
        typeof up.maxToolRounds === 'number' && Number.isFinite(up.maxToolRounds)
          ? up.maxToolRounds
          : DEFAULT_MAX_TOOL_ROUNDS;
      if (inputMaxToolRounds) inputMaxToolRounds.value = String(mtr);
      settingsDisabledToolsDraft = new Set(
        Array.isArray(up.disabledTools) ? up.disabledTools.filter((n) => typeof n === 'string') : []
      );
      if (inputPythonEnabled) inputPythonEnabled.checked = up.pythonExecutionEnabled === true;
      if (inputPythonInterpreter) {
        inputPythonInterpreter.value =
          typeof up.pythonInterpreterPath === 'string' ? up.pythonInterpreterPath : '';
      }
      if (inputShellEnabled) inputShellEnabled.checked = up.shellExecutionEnabled === true;
      if (inputEnvironmentInfo) inputEnvironmentInfo.checked = up.environmentInfoEnabled !== false;
    } catch {
      inputGlobalSystemPrompt.value = '';
      selectAppLocale.value = 'de';
      if (inputMaxToolRounds) inputMaxToolRounds.value = String(DEFAULT_MAX_TOOL_ROUNDS);
      settingsDisabledToolsDraft = new Set();
      if (inputPythonEnabled) inputPythonEnabled.checked = false;
      if (inputPythonInterpreter) inputPythonInterpreter.value = '';
      if (inputShellEnabled) inputShellEnabled.checked = false;
      // Beim Lesefehler die Voreinstellung zeigen, nicht „aus" — sonst
      // schaltet ein blosses Oeffnen-und-Speichern den Block unbemerkt ab.
      if (inputEnvironmentInfo) inputEnvironmentInfo.checked = true;
    }
    await loadPythonState();
    await loadShellState();
    await loadWebSearchState();
    await loadToolCatalog();
    // Berechtigungen (Issue #67) lesen ihren Stand direkt vom Main und wirken
    // sofort – sie hängen nicht am Entwurf, der mit „Übernehmen“ gespeichert wird.
    await toolPermissionsPanel?.open?.(settingsToolCatalog);
    // MCP (Issue #109) liest wie die Berechtigungen direkt vom Main und
    // wirkt sofort — die Serverliste haengt nicht am Entwurf.
    await mcpPanel?.open?.();
    await loadSkillCatalog();
    renderDraftPresetList();
    renderProviderSelect();
    syncPopupProviderUI(selectProvider.value, true);

    queueMicrotask(() => {
      // Mit Sprungziel steht der Fokus auf dem gemeinten Schalter, sonst wie
      // bisher auf dem ersten Reiter.
      if (jump?.skillName && focusSkillSwitch(jump.skillName)) return;
      try {
        settingsNavTabs[0]?.focus();
      } catch {
        const fb = getFocusableInSettingsModal();
        fb[0]?.focus();
      }
    });
  }

  /**
   * Schalter eines Skills in die Sicht holen und fokussieren. Liefert false,
   * wenn es ihn nicht (mehr) gibt — dann bleibt es beim Standardfokus.
   */
  function focusSkillSwitch(skillName) {
    if (!settingsSkillList) return false;
    const input = settingsSkillList.querySelector(
      `input[type="checkbox"][data-skill-name="${CSS.escape(skillName)}"]`
    );
    if (!input) return false;
    input.scrollIntoView({ block: 'center' });
    input.focus();
    return true;
  }

  function closeSettingsModal() {
    toolPermissionsPanel?.close?.();
    mcpPanel?.close?.();
    closeChatModelMenu(false);
    stashPopupCredentialInputs();
    closeAddModelOverlay();
    modalSettings.classList.add('hidden');
    modalSettings.setAttribute('aria-hidden', 'true');
    modalSettings.removeEventListener('keydown', handleModalKeydown);
    if (appStore.lastFocusBeforeModal && typeof appStore.lastFocusBeforeModal.focus === 'function') {
      try { appStore.lastFocusBeforeModal.focus(); } catch { /* ignore */ }
    }
    appStore.lastFocusBeforeModal = null;
  }

  async function loadModelsForPopup() {
    const generation = ++modelRequestGeneration;
    const providerId = selectProvider.value;
    const pv = findProviderView(providerId);
    if (!pv) return;
    stashPopupCredentialInputs();

    const d = settingsCredentialDraft[providerId] || {};
    const form = pv.form || {};
    const apiKey = d.apiKey;
    const baseUrl = (d.baseUrl || '').trim();
    const insecureTls = form.showInsecureTls ? !!d.insecureTls : undefined;

    // Ein optionaler Key darf fehlen (Issue #193) — dort ist die Server-URL die
    // einzige Voraussetzung.
    if (form.showApiKey && !form.apiKeyOptional && !apiKey && (!pv.hasKey || d.removeApiKey)) {
      setModelStatus('Bitte zuerst einen API-Key eingeben.', true);
      return;
    }
    if (form.showBaseUrl && !baseUrl && !pv.baseUrl) {
      setModelStatus('Bitte eine Server-URL angeben.', true);
      return;
    }

    btnLoadModels.disabled = true;
    setModelStatus('Lade Modelle …');
    try {
      const result = await api.listModels({
        providerId,
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
        insecureTls,
      });
      if (generation !== modelRequestGeneration) return;
      // Eine fehlgeschlagene oder leere Liste ist bei einem frei gewaehlten
      // Endpunkt kein Fehler, sondern ein Zustand (Issue #193): Der Anbieter
      // bleibt per Hand eingetragenem Modellnamen nutzbar. Die Meldung sagt
      // trotzdem, warum die Liste leer blieb — sonst raet man.
      const manual = allowsManualModel(pv);
      if (result?.error) {
        setModelStatus(
          manual
            ? `Keine Modellliste: ${result.error} — Modellnamen von Hand eintragen.`
            : `Fehler: ${result.error}`,
          !manual
        );
        return;
      }
      const models = Array.isArray(result?.models) ? result.models : [];
      if (models.length === 0) {
        setModelStatus(
          manual
            ? 'Der Server hat eine leere Modellliste geliefert — Modellnamen von Hand eintragen.'
            : 'Keine Modelle gefunden.',
          !manual
        );
        renderModelSelect(currentModelValue(pv) || pv.model || pv.defaultModel || '', null, pv);
        return;
      }
      const current = currentModelValue(pv) || pv.model || pv.defaultModel || models[0].id;
      renderModelSelect(current, models, pv);
      if (!manual) {
        if ([...selectModel.options].some((o) => o.value === current)) {
          selectModel.value = current;
        } else {
          selectModel.value = models[0].id;
        }
      }
      setModelStatus(`${models.length} Modelle gefunden.`, false);
    } catch (err) {
      if (generation !== modelRequestGeneration) return;
      setModelStatus(`Fehler: ${err.message || 'Modelle konnten nicht geladen werden.'}`, true);
    } finally {
      if (generation === modelRequestGeneration) btnLoadModels.disabled = false;
    }
  }

  function buildDraftPresetCandidate(providerId) {
    const pv = findProviderView(providerId);
    if (!pv) return null;
    const model = currentModelValue(pv) || pv.defaultModel || '';
    const row = {
      id: 'draft',
      providerId,
      model,
      menuVisible: true,
      label: `${draftProviderName(providerId) || pv.name} · ${model}`,
    };
    for (const field of pv.presetFields || []) {
      const value = popupPresetFieldValues[providerId]?.[field.key] || field.defaultValue;
      if (value) row[field.key] = value;
    }
    return row;
  }

  function addPresetDraftFromPopup() {
    stashPopupCredentialInputs();
    const pv = selectProvider.value;
    const providerView = findProviderView(pv);
    if (!providerView) return false;
    const candidate = buildDraftPresetCandidate(pv);
    if (!candidate) return false;
    // Bei frei eintragbarem Modellnamen (Issue #193) gibt es keine Liste, die
    // einen Wert erzwingt — ein leerer Eintrag waere im Chat-Menue eine Zeile
    // ohne Modell und beim Senden ein Fehler.
    if (allowsManualModel(providerView) && !candidate.model) {
      setModelStatus('Bitte einen Modellnamen eintragen.', true);
      inputModel.focus();
      return false;
    }

    // Die bearbeitete Zeile ist keine Dublette ihrer selbst.
    const dup = settingsDraftPresets.some((row) => {
      if (row.id === popupEditPresetId) return false;
      const rowProvider = findProviderView(row.providerId);
      if (!rowProvider) return false;
      return presetIdentityKey(presetToWireRow(row), rowProvider) === presetIdentityKey(candidate, providerView);
    });
    if (dup) {
      setModelStatus('Diese Kombination gibt es bereits in der Liste.', true);
      return false;
    }
    setModalError('');

    const editing = settingsDraftPresets.find((row) => row.id === popupEditPresetId);
    const id = editing
      ? editing.id
      : (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `p-${Date.now()}`);
    const model = candidate.model;
    const connection = usesPresetConnection(providerView)
      ? connectionViewFromDraft(providerView, activeDraft(pv), editing)
      : null;
    const formatted = formatPresetSublabelFromView(
      candidate,
      providerView,
      connection || draftConnectionFor(pv)
    );
    const row = {
      id,
      providerId: pv,
      model,
      menuVisible: editing ? editing.menuVisible !== false : true,
      label: `${connection?.displayName?.trim() || draftProviderName(pv) || providerView.name} · ${model}`,
      sublabel: formatted.text,
      sublabelStyle: formatted.style,
      ...(connection ? { connection } : {}),
    };
    for (const field of providerView.presetFields || []) {
      if (candidate[field.key]) {
        row[field.key] = candidate[field.key];
      }
    }

    if (editing) settingsDraftPresets[settingsDraftPresets.indexOf(editing)] = row;
    else settingsDraftPresets.push(row);
    if (!settingsDraftActivePresetId) settingsDraftActivePresetId = id;
    renderDraftPresetList();
    return true;
  }

  /**
   * Entwurf -> Verbindung der Zeile. Die Ja/Nein-Angaben zu Geheimnissen
   * kommen aus dem bisherigen Zustand und werden vom Entwurf nur fortgeschrieben
   * — der Renderer kennt die Werte selbst nie (Issue #202).
   */
  function connectionViewFromDraft(providerView, draft, previous) {
    const alt = previous?.connection || {};
    const typedKey = !!(draft?.apiKey || '').trim();
    const typedHeaders = !!(draft?.extraHeaders || '').trim();
    return {
      displayName: (draft?.displayName || '').trim(),
      baseUrl: (draft?.baseUrl || providerView.defaultBaseUrl || '').trim(),
      apiStyle: draft?.apiStyle || providerView.form?.defaultApiStyle || 'chat',
      insecureTls: draft?.insecureTls === true,
      supportsImages: draft?.supportsImages === true,
      sendTools: draft?.sendTools !== false,
      hasKey: typedKey || (alt.hasKey === true && !draft?.removeApiKey),
      keyUnreadable: alt.keyUnreadable === true && !typedKey && !draft?.removeApiKey,
      hasExtraHeaders: typedHeaders || (alt.hasExtraHeaders === true && !draft?.removeExtraHeaders),
      // Nur fuer den Weg zum Main-Prozess; nicht Teil der Ansicht.
      draft: {
        ...(typedKey ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft?.removeApiKey ? { removeApiKey: true } : {}),
        ...(typedHeaders ? { extraHeaders: draft.extraHeaders } : {}),
        ...(draft?.removeExtraHeaders ? { removeExtraHeaders: true } : {}),
      },
    };
  }

  async function commitSettingsFromModal() {
    stashPopupCredentialInputs();
    setModalError('');
    // Eine leere Liste lehnt der Main-Prozess ab — und speichert dabei System-
    // Prompt, Sprache und Tool-Auswahl trotzdem. Ein frueher return hier wuerde
    // genau das wieder verhindern (Issue #97).
    let activePresetId = settingsDraftActivePresetId || settingsDraftPresets[0]?.id || null;
    if (!settingsDraftPresets.some((p) => p.id === activePresetId)) {
      activePresetId = settingsDraftPresets[0]?.id || null;
    }

    const providerPatches = {};
    const ids = new Set(settingsDraftPresets.map((p) => p.providerId));
    for (const pid of ids) {
      const pv = findProviderView(pid);
      // Bei Verbindung je Eintrag gibt es keinen Anbieter-Zugang mehr, der
      // gespeichert werden koennte (Issue #202) — die Werte reisen an der
      // Zeile mit.
      if (!pv || usesPresetConnection(pv)) continue;
      const d = settingsCredentialDraft[pid];
      if (!d) continue;
      const patch = {};
      if (d.removeApiKey) patch.removeApiKey = true;
      if (typeof d.apiKey === 'string' && d.apiKey.trim()) patch.apiKey = d.apiKey.trim();
      const bu = typeof d.baseUrl === 'string' ? d.baseUrl.trim() : '';
      if (bu && pv.form?.showBaseUrl) patch.baseUrl = bu;
      if (pv.form?.showInsecureTls) patch.insecureTls = !!d.insecureTls;
      // Felder des Providers „OpenAI-kompatibel" (Issue #193). Der Anzeigename
      // geht auch leer mit — sonst liesse er sich nie wieder loeschen.
      if (pv.form?.showDisplayName) patch.displayName = (d.displayName || '').trim();
      if (pv.form?.showApiStyle && d.apiStyle) patch.apiStyle = d.apiStyle;
      if (pv.form?.showExtraHeaders) {
        if (d.removeExtraHeaders) patch.removeExtraHeaders = true;
        if (typeof d.extraHeaders === 'string' && d.extraHeaders.trim()) {
          patch.extraHeaders = d.extraHeaders;
        }
      }
      if (pv.form?.showSupportsImages) patch.supportsImages = d.supportsImages === true;
      if (pv.form?.showSendTools) patch.sendTools = d.sendTools !== false;
      providerPatches[pid] = patch;
    }

    btnSettingsSave.disabled = true;
    try {
      const res = await api.commitSettings({
        presets: settingsDraftPresets.map(presetToWireRow),
        activePresetId,
        providerPatches,
        uiPrefs: {
          baseSystemPrompt: inputGlobalSystemPrompt.value || '',
          appLocale: selectAppLocale.value === 'en' ? 'en' : 'de',
          skillSuggestionMode: selectSkillSuggestionMode?.value || DEFAULT_SKILL_SUGGESTION_MODE,
          maxToolRounds: (() => {
            const n = parseInt(inputMaxToolRounds?.value || '', 10);
            return Number.isFinite(n) ? n : DEFAULT_MAX_TOOL_ROUNDS;
          })(),
          disabledTools: [...settingsDisabledToolsDraft],
          activeSkills: [...settingsActiveSkillsDraft],
          pythonExecutionEnabled: inputPythonEnabled?.checked === true,
          pythonInterpreterPath: inputPythonInterpreter?.value || '',
          shellExecutionEnabled: inputShellEnabled?.checked === true,
          environmentInfoEnabled: inputEnvironmentInfo?.checked !== false,
        },
      });
      if (res?.ok || res?.uiPrefsSaved) {
        // Sofort wirksam, ohne Neustart — wie die Sprache (Issue #97).
        onSkillSuggestionModeChanged?.(
          selectSkillSuggestionMode?.value || DEFAULT_SKILL_SUGGESTION_MODE
        );
      }
      if (!res?.ok) {
        // Der Modellteil kann scheitern, waehrend die uebrigen Einstellungen
        // geschrieben wurden. Die Sprache muss dann auch sofort umschalten,
        // obwohl der Dialog mit der Meldung offen bleibt (Issue #97).
        if (res?.uiPrefsSaved) applyShellLocale(selectAppLocale.value === 'en' ? 'en' : 'de');
        setModalError(res?.error || 'Speichern fehlgeschlagen.');
        return;
      }
      applyShellLocale(selectAppLocale.value === 'en' ? 'en' : 'de');
      await refreshLLMState();
      closeSettingsModal();
    } finally {
      btnSettingsSave.disabled = false;
    }
  }

  modalSettingsBackdrop.addEventListener('click', closeSettingsModal);
  btnSettingsClose.addEventListener('click', closeSettingsModal);
  btnSettingsFooterClose?.addEventListener('click', closeSettingsModal);

  if (settingsVersionLabel && api.getAppVersion) {
    api.getAppVersion()
      .then((info) => {
        if (info && typeof info.version === 'string') {
          settingsVersionLabel.textContent = `Version ${info.version}`;
        }
      })
      .catch(() => { /* Label bleibt auf "Version —" */ });
  }

  btnCheckUpdates?.addEventListener('click', () => {
    closeSettingsModal();
    if (typeof onCheckUpdates === 'function') onCheckUpdates();
  });

  settingsNavTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.settingsPanel;
      if (key) activateSettingsPanel(key);
    });
  });

  btnOpenAddModel?.addEventListener('click', () => {
    openAddModelOverlay();
    queueMicrotask(() => {
      try {
        selectProvider.focus();
      } catch { /* ignore */ }
    });
  });

  btnAddModelCloseX?.addEventListener('click', closeAddModelOverlay);
  btnAddModelClose?.addEventListener('click', closeAddModelOverlay);

  addModelOverlay?.addEventListener('click', (e) => {
    if (e.target === addModelOverlay) closeAddModelOverlay();
  });

  selectProvider.addEventListener('change', () => {
    cancelModelListing();
    syncPopupProviderUI(selectProvider.value);
  });

  inputApiKey.addEventListener('input', () => {
    const id = selectProvider.value;
    const draft = activeDraft(id);
    if (!draft) return;
    draft.apiKey = inputApiKey.value;
    if (inputApiKey.value.trim()) draft.removeApiKey = false;
    syncPopupProviderUI(id, true);
  });

  btnRemoveApiKey?.addEventListener('click', () => {
    const id = selectProvider.value;
    const draft = activeDraft(id);
    if (!draft) return;
    draft.apiKey = '';
    draft.removeApiKey = true;
    syncPopupProviderUI(id, true);
  });

  inputBaseUrl.addEventListener('input', () => {
    const draft = activeDraft(selectProvider.value);
    if (!draft) return;
    draft.baseUrl = inputBaseUrl.value;
    renderDraftPresetList();
  });

  inputInsecureTls.addEventListener('change', () => {
    const draft = activeDraft(selectProvider.value);
    if (!draft) return;
    draft.insecureTls = !!inputInsecureTls.checked;
    renderDraftPresetList();
  });

  // --- Felder des Providers „OpenAI-kompatibel" (Issue #193) ---------------

  selectProviderTemplate?.addEventListener('change', () => {
    const id = selectProvider.value;
    const templateId = selectProviderTemplate.value;
    if (!id || !templateId) return;
    applyProviderTemplate(id, templateId);
  });

  inputDisplayName?.addEventListener('input', () => {
    const draft = activeDraft(selectProvider.value);
    if (!draft) return;
    draft.displayName = inputDisplayName.value;
    renderDraftPresetList();
  });

  selectApiStyle?.addEventListener('change', () => {
    const draft = activeDraft(selectProvider.value);
    if (!draft) return;
    draft.apiStyle = selectApiStyle.value;
  });

  inputExtraHeaders?.addEventListener('input', () => {
    const id = selectProvider.value;
    const draft = activeDraft(id);
    if (!draft) return;
    draft.extraHeaders = inputExtraHeaders.value;
    if (inputExtraHeaders.value.trim()) draft.removeExtraHeaders = false;
    syncPopupProviderUI(id, true);
  });

  btnRemoveExtraHeaders?.addEventListener('click', () => {
    const id = selectProvider.value;
    const draft = activeDraft(id);
    if (!draft) return;
    draft.extraHeaders = '';
    draft.removeExtraHeaders = true;
    syncPopupProviderUI(id, true);
    inputExtraHeaders.focus();
  });

  inputSendTools?.addEventListener('change', () => {
    const draft = activeDraft(selectProvider.value);
    if (!draft) return;
    draft.sendTools = !!inputSendTools.checked;
  });

  inputSupportsImages?.addEventListener('change', () => {
    const draft = activeDraft(selectProvider.value);
    if (!draft) return;
    draft.supportsImages = !!inputSupportsImages.checked;
  });

  btnLoadModels.addEventListener('click', () => {
    loadModelsForPopup();
  });

  btnAddPresetRow?.addEventListener('click', () => {
    if (addPresetDraftFromPopup()) {
      closeAddModelOverlay();
    }
  });

  btnSettingsSave.addEventListener('click', () => {
    commitSettingsFromModal();
  });

  prefModelList?.addEventListener('click', (e) => {
    const edit = e.target.closest('.settings-icon-edit');
    if (edit && prefModelList.contains(edit)) {
      openAddModelOverlay({ presetId: edit.dataset.editPresetId });
      return;
    }
    const sw = e.target.closest('.settings-pref-switch');
    if (sw && prefModelList.contains(sw)) {
      const id = sw.dataset.presetId;
      const row = settingsDraftPresets.find((p) => p.id === id);
      if (!row) return;
      row.menuVisible = !(row.menuVisible !== false);
      renderDraftPresetList();
      return;
    }
    const rm = e.target.closest('.settings-icon-trash');
    if (rm && prefModelList.contains(rm)) {
      const id = rm.dataset.presetId;
      settingsDraftPresets = settingsDraftPresets.filter((p) => p.id !== id);
      if (settingsDraftActivePresetId === id) {
        settingsDraftActivePresetId = settingsDraftPresets[0]?.id || null;
      }
      renderDraftPresetList();
    }
  });

  settingsToolList?.addEventListener('change', (e) => {
    const input = e.target.closest('input[type="checkbox"][data-tool-name]');
    if (!input) return;
    const name = input.dataset.toolName;
    if (!name) return;
    if (input.checked) settingsDisabledToolsDraft.delete(name);
    else settingsDisabledToolsDraft.add(name);
    syncToolGroupHeads();
  });

  settingsToolList?.addEventListener('click', (e) => {
    const button = e.target.closest('.settings-tool-group__all');
    if (!button) return;
    const section = button.closest('.settings-tool-group');
    if (section) toggleToolGroup(section);
  });

  settingsSkillList?.addEventListener('change', (e) => {
    const input = e.target.closest('input[type="checkbox"][data-skill-name]');
    if (!input) return;
    const name = input.dataset.skillName;
    if (!name) return;
    if (!input.checked) {
      settingsActiveSkillsDraft.delete(name);
      return;
    }
    settingsActiveSkillsDraft.add(name);
  });

  btnReloadSkills?.addEventListener('click', async () => {
    btnReloadSkills.disabled = true;
    try {
      // Neu gefundene Skills sollen die bisherige Auswahl nicht verlieren.
      await refreshSkillCatalogKeepingSelection({ reload: true });
    } finally {
      btnReloadSkills.disabled = false;
    }
  });

  // Der Datei-Watcher im Main hat eine Aenderung gemeldet (Issue #126). Der
  // Scan-Cache dort ist schon verworfen; hier muss nur die angezeigte Liste
  // nachziehen — und auch nur, solange der Dialog ueberhaupt offen ist, sonst
  // holt ihn das naechste Oeffnen ohnehin frisch.
  api.onSkillsChanged?.(() => {
    if (modalSettings.classList.contains('hidden')) return;
    void refreshSkillCatalogKeepingSelection();
  });

  btnChatSettings.addEventListener('click', openSettingsModal);

  return { openSettingsModal, closeSettingsModal, applyShellLocale };
}
