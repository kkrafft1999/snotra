import contracts from '../generated/contracts.js';
import {
  groupToolCatalog,
  groupCountLabel,
  groupToggleLabel,
  toolShortText,
  toolDetailText,
  toolStatusBadge,
} from '../utils/tool-catalog-view.js';

const SETTINGS_NAV_LABELS = { models: 'Modelle', tools: 'Tools', skills: 'Skills', general: 'Allgemein' };

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
  MAX_ACTIVE_SKILLS,
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
  const presetFieldsPopup = document.getElementById('preset-fields-popup');
  const selectModel = document.getElementById('select-model');
  const btnLoadModels = document.getElementById('btn-load-models');
  const modelLoadProviderLabel = document.getElementById('model-load-provider-label');
  const modelStatus = document.getElementById('model-status');
  const btnAddPresetRow = document.getElementById('btn-add-preset-row');
  const btnAddModelCloseX = document.getElementById('btn-add-model-close-x');
  const btnAddModelClose = document.getElementById('btn-add-model-close');
  const btnSettingsSave = document.getElementById('btn-settings-save');
  const btnSettingsClose = document.getElementById('btn-settings-close');
  const btnSettingsFooterClose = document.getElementById('btn-settings-footer-close');
  const inputGlobalSystemPrompt = document.getElementById('input-global-system-prompt');
  const selectAppLocale = document.getElementById('select-app-locale');
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
  const settingsSkillList = document.getElementById('settings-skill-list');
  const settingsSkillListEmpty = document.getElementById('settings-skill-list-empty');
  const btnReloadSkills = document.getElementById('btn-reload-skills');
  const settingsSkillLimitHint = document.getElementById('settings-skill-limit-hint');
  const modalEncryptionWarning = document.getElementById('modal-encryption-warning');
  const modalSaveError = document.getElementById('modal-save-error');
  const btnChatSettings = document.getElementById('btn-chat-settings');
  const settingsVersionLabel = document.getElementById('settings-version-label');
  const btnCheckUpdates = document.getElementById('btn-check-updates');

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

  function presetSublabelForDraft(pr) {
    const pv = findProviderView(pr.providerId);
    if (!pv) return pr.sublabel || '';
    const connection = settingsCredentialDraft[pr.providerId] ? draftConnectionFor(pr.providerId) : undefined;
    const formatted = formatPresetSublabelFromView(pr, pv, connection);
    return formatted.text || pr.sublabel || '';
  }

  function presetDetailClassForDraft(pr) {
    const pv = findProviderView(pr.providerId);
    if (!pv) {
      return pr.sublabelStyle === PRESET_DETAIL_STYLES.MONO
        ? 'settings-pref-detail settings-pref-detail--mono'
        : 'settings-pref-detail';
    }
    const connection = settingsCredentialDraft[pr.providerId] ? draftConnectionFor(pr.providerId) : undefined;
    const formatted = formatPresetSublabelFromView(pr, pv, connection);
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

  function hydrateCredentialDraftFromLlmState() {
    settingsCredentialDraft = {};
    for (const p of appStore.llmState.providers || []) {
      settingsCredentialDraft[p.id] = {
        apiKey: '',
        removeApiKey: false,
        baseUrl: (p.baseUrl || p.defaultBaseUrl || '').trim(),
        insecureTls: !!p.insecureTls,
      };
    }
  }

  function stashPopupCredentialInputs() {
    const id = selectProvider?.value;
    if (!id || !settingsCredentialDraft[id]) return;
    settingsCredentialDraft[id].apiKey = (inputApiKey.value || '').trim();
    if (settingsCredentialDraft[id].apiKey) {
      settingsCredentialDraft[id].removeApiKey = false;
    }
    settingsCredentialDraft[id].baseUrl = (inputBaseUrl.value || '').trim();
    settingsCredentialDraft[id].insecureTls = !!inputInsecureTls.checked;
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

  function renderModelSelect(currentValue, options) {
    selectModel.innerHTML = '';
    const seen = new Set();
    const add = (id, label) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.setAttribute('lang', 'en');
      opt.textContent = label || id;
      selectModel.appendChild(opt);
    };
    if (Array.isArray(options)) {
      for (const m of options) add(m.id, m.label || m.id);
    }
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

  function syncPopupProviderUI(providerId, skipStash) {
    const pv = findProviderView(providerId);
    if (!pv) return;
    if (!skipStash) stashPopupCredentialInputs();

    selectProvider.value = providerId;

    if (!settingsCredentialDraft[providerId]) {
      settingsCredentialDraft[providerId] = {
        apiKey: '',
        removeApiKey: false,
        baseUrl: (pv.baseUrl || pv.defaultBaseUrl || '').trim(),
        insecureTls: !!pv.insecureTls,
      };
    }
    const draft = settingsCredentialDraft[providerId];
    const form = pv.form || {};

    if (form.showApiKey) {
      providerKeyRow.classList.remove('hidden');
      inputApiKey.value = draft.apiKey || '';
      if (draft.removeApiKey && pv.hasKey) {
        inputApiKey.placeholder = 'Key wird beim Speichern entfernt';
      } else if (pv.hasKey) {
        inputApiKey.placeholder = 'Gespeicherter Key bleibt erhalten';
      } else {
        inputApiKey.placeholder = form.apiKeyPlaceholder || '••••••';
      }
      const showTrash =
        pv.hasKey || !!(draft.apiKey || '').trim() || draft.removeApiKey;
      btnRemoveApiKey?.classList.toggle('hidden', !showTrash);
    } else {
      providerKeyRow.classList.add('hidden');
      inputApiKey.value = '';
      btnRemoveApiKey?.classList.add('hidden');
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

    renderPresetFieldsPopup(pv);

    if (modelLoadProviderLabel) {
      modelLoadProviderLabel.textContent = pv.name;
    }

    renderModelSelect(pv.model || pv.defaultModel || '', null);

    const lines = [];
    if (pv.apiBase) lines.push(`API: ${pv.apiBase}`);
    if (pv.isActiveChatProvider) lines.push('Aktueller Chat-Anbieter');
    if (form.showApiKey) {
      if (draft.removeApiKey && pv.hasKey) {
        lines.push('Key wird beim Speichern entfernt');
      } else if (pv.keyUnreadable && !draft.apiKey) {
        lines.push('Gespeicherter API-Key kann nicht mehr entschlüsselt werden (z. B. nach der Umbenennung der App in Snotra AI). Bitte den Key neu eingeben.');
      } else if (pv.hasKey && !draft.apiKey) {
        lines.push('Key gespeichert');
      } else if (draft.apiKey) {
        lines.push('Neuer Key wird beim Speichern gesetzt');
      }
    } else if (pv.configured) {
      lines.push('Konfiguriert');
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
      title.textContent = pr.label || `${pv.name} · ${pr.model || pv.defaultModel}`;
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
    const badge = toolStatusBadge(tool, { pythonReady, webSearchHasKey });

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
    if (detailText) {
      const desc = document.createElement('p');
      desc.className = 'settings-tool-item__desc';
      desc.textContent = detailText;
      li.appendChild(desc);
    }
    if (skill.path) {
      const pathEl = document.createElement('p');
      pathEl.className = 'settings-tool-item__desc settings-skill-item__path';
      pathEl.textContent = skill.path;
      li.appendChild(pathEl);
    }
    return li;
  }

  function setSkillLimitHint(text) {
    if (!settingsSkillLimitHint) return;
    settingsSkillLimitHint.textContent = text;
    settingsSkillLimitHint.classList.toggle('hidden', !text);
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
    setSkillLimitHint('');
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
    if (!state.enabled) {
      return { text: `${wo}: ${state.command}${version}. Noch nicht erlaubt, run_python wird nicht angeboten.` };
    }
    return { text: `${wo}: ${state.command}${version}. run_python wird dem Modell angeboten.` };
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

  function getFocusableInSettingsModal() {
    if (addModelOverlay && !addModelOverlay.classList.contains('hidden')) {
      const nested = addModelOverlay.querySelector('.add-model-dialog');
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
      if (addModelOverlay && !addModelOverlay.classList.contains('hidden')) {
        closeAddModelOverlay();
        return;
      }
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

  function openAddModelOverlay() {
    stashPopupCredentialInputs();
    addModelOverlay.classList.remove('hidden');
    addModelOverlay.setAttribute('aria-hidden', 'false');
    renderProviderSelect();
    const pid = selectProvider.value;
    syncPopupProviderUI(pid, true);
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
    addModelOverlay.classList.add('hidden');
    addModelOverlay.setAttribute('aria-hidden', 'true');
    btnOpenAddModel?.focus?.();
  }

  async function openSettingsModal() {
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
    activateSettingsPanel('models');
    try {
      const up = await api.getUIPrefs();
      inputGlobalSystemPrompt.value = typeof up.baseSystemPrompt === 'string' ? up.baseSystemPrompt : '';
      selectAppLocale.value = up.appLocale === 'en' ? 'en' : 'de';
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
    } catch {
      inputGlobalSystemPrompt.value = '';
      selectAppLocale.value = 'de';
      if (inputMaxToolRounds) inputMaxToolRounds.value = String(DEFAULT_MAX_TOOL_ROUNDS);
      settingsDisabledToolsDraft = new Set();
      if (inputPythonEnabled) inputPythonEnabled.checked = false;
      if (inputPythonInterpreter) inputPythonInterpreter.value = '';
    }
    await loadPythonState();
    await loadWebSearchState();
    await loadToolCatalog();
    // Berechtigungen (Issue #67) lesen ihren Stand direkt vom Main und wirken
    // sofort – sie hängen nicht am Entwurf, der mit „Übernehmen“ gespeichert wird.
    await toolPermissionsPanel?.open?.(settingsToolCatalog);
    await loadSkillCatalog();
    renderDraftPresetList();
    renderProviderSelect();
    syncPopupProviderUI(selectProvider.value, true);

    queueMicrotask(() => {
      try {
        settingsNavTabs[0]?.focus();
      } catch {
        const fb = getFocusableInSettingsModal();
        fb[0]?.focus();
      }
    });
  }

  function closeSettingsModal() {
    toolPermissionsPanel?.close?.();
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

    if (form.showApiKey && !apiKey && (!pv.hasKey || d.removeApiKey)) {
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
      if (result?.error) {
        setModelStatus(`Fehler: ${result.error}`, true);
        return;
      }
      const models = Array.isArray(result?.models) ? result.models : [];
      if (models.length === 0) {
        setModelStatus('Keine Modelle gefunden.', true);
        renderModelSelect(pv.model || pv.defaultModel || '', null);
        return;
      }
      const current = selectModel.value || pv.model || pv.defaultModel || models[0].id;
      renderModelSelect(current, models);
      if ([...selectModel.options].some((o) => o.value === current)) {
        selectModel.value = current;
      } else {
        selectModel.value = models[0].id;
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
    const model = (selectModel.value || '').trim() || pv.defaultModel || '';
    const row = {
      id: 'draft',
      providerId,
      model,
      menuVisible: true,
      label: `${pv.name} · ${model}`,
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

    const dup = settingsDraftPresets.some((row) => {
      const rowProvider = findProviderView(row.providerId);
      if (!rowProvider) return false;
      return presetIdentityKey(presetToWireRow(row), rowProvider) === presetIdentityKey(candidate, providerView);
    });
    if (dup) {
      setModelStatus('Diese Kombination gibt es bereits in der Liste.', true);
      return false;
    }
    setModalError('');
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `p-${Date.now()}`;
    const model = candidate.model;
    const formatted = formatPresetSublabelFromView(candidate, providerView, draftConnectionFor(pv));
    const newPreset = {
      id,
      providerId: pv,
      model,
      menuVisible: true,
      label: `${providerView.name} · ${model}`,
      sublabel: formatted.text,
      sublabelStyle: formatted.style,
    };
    for (const field of providerView.presetFields || []) {
      if (candidate[field.key]) {
        newPreset[field.key] = candidate[field.key];
      }
    }

    settingsDraftPresets.push(newPreset);
    if (!settingsDraftActivePresetId) settingsDraftActivePresetId = id;
    renderDraftPresetList();
    return true;
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
      const d = settingsCredentialDraft[pid];
      const pv = findProviderView(pid);
      if (!pv || !d) continue;
      const patch = {};
      if (d.removeApiKey) patch.removeApiKey = true;
      if (typeof d.apiKey === 'string' && d.apiKey.trim()) patch.apiKey = d.apiKey.trim();
      const bu = typeof d.baseUrl === 'string' ? d.baseUrl.trim() : '';
      if (bu && pv.form?.showBaseUrl) patch.baseUrl = bu;
      if (pv.form?.showInsecureTls) patch.insecureTls = !!d.insecureTls;
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
          maxToolRounds: (() => {
            const n = parseInt(inputMaxToolRounds?.value || '', 10);
            return Number.isFinite(n) ? n : DEFAULT_MAX_TOOL_ROUNDS;
          })(),
          disabledTools: [...settingsDisabledToolsDraft],
          activeSkills: [...settingsActiveSkillsDraft],
          pythonExecutionEnabled: inputPythonEnabled?.checked === true,
          pythonInterpreterPath: inputPythonInterpreter?.value || '',
        },
      });
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
    if (id && settingsCredentialDraft[id]) {
      settingsCredentialDraft[id].apiKey = inputApiKey.value;
      if (inputApiKey.value.trim()) {
        settingsCredentialDraft[id].removeApiKey = false;
      }
      syncPopupProviderUI(id, true);
    }
  });

  btnRemoveApiKey?.addEventListener('click', () => {
    const id = selectProvider.value;
    if (!id || !settingsCredentialDraft[id]) return;
    settingsCredentialDraft[id].apiKey = '';
    settingsCredentialDraft[id].removeApiKey = true;
    syncPopupProviderUI(id, true);
  });

  inputBaseUrl.addEventListener('input', () => {
    const id = selectProvider.value;
    if (id && settingsCredentialDraft[id]) {
      settingsCredentialDraft[id].baseUrl = inputBaseUrl.value;
      renderDraftPresetList();
    }
  });

  inputInsecureTls.addEventListener('change', () => {
    const id = selectProvider.value;
    if (id && settingsCredentialDraft[id]) {
      settingsCredentialDraft[id].insecureTls = !!inputInsecureTls.checked;
      renderDraftPresetList();
    }
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
      setSkillLimitHint('');
      return;
    }
    // Beim Speichern greift dieselbe Obergrenze — lieber hier bremsen, als
    // stillschweigend Skills zu verlieren.
    if (settingsActiveSkillsDraft.size >= MAX_ACTIVE_SKILLS) {
      input.checked = false;
      setSkillLimitHint(
        `Höchstens ${MAX_ACTIVE_SKILLS} Skills gleichzeitig — erst einen abwählen.`
      );
      return;
    }
    settingsActiveSkillsDraft.add(name);
    setSkillLimitHint('');
  });

  btnReloadSkills?.addEventListener('click', async () => {
    btnReloadSkills.disabled = true;
    try {
      // Neu gefundene Skills sollen die bisherige Auswahl nicht verlieren.
      const previous = new Set(settingsActiveSkillsDraft);
      await loadSkillCatalog({ reload: true });
      for (const name of previous) {
        if (settingsSkillCatalog.some((skill) => skill.name === name)) {
          settingsActiveSkillsDraft.add(name);
        }
      }
      renderSkillList();
    } finally {
      btnReloadSkills.disabled = false;
    }
  });

  btnChatSettings.addEventListener('click', openSettingsModal);

  return { openSettingsModal, closeSettingsModal, applyShellLocale };
}
