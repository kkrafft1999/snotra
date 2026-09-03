/**
 * Settings-/Provider-/Preset-/UI-Prefs-Contracts (Roadmap-Etappe 1, Ergänzung).
 *
 * DTOs, Validatoren und reine Format-Helfer für die IPC-Grenze und die
 * persistierte LLM-/UI-Konfiguration. Additive Erweiterung des bestehenden
 * Wire-Formats — bestehende Felder bleiben erhalten.
 */
'use strict';

const { APP_LOCALES, PRESET_DETAIL_STYLES, PRESET_FIELD_TYPES } = require('./enums');
const { normalizeActiveSkills } = require('./skills');

const MAX_TOOL_ROUNDS_MIN = 1;
const MAX_TOOL_ROUNDS_MAX = 500;
const SIDEBAR_WIDTH_MIN = 150;
const SIDEBAR_WIDTH_MAX = 600;
const CHAT_PANEL_WIDTH_MIN = 260;
const CHAT_PANEL_WIDTH_MAX = 2000;
const HISTORY_CHAR_LIMIT_MIN = 4000;
const HISTORY_CHAR_LIMIT_MAX = 2_000_000;

function clampMaxToolRounds(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(MAX_TOOL_ROUNDS_MAX, Math.max(MAX_TOOL_ROUNDS_MIN, Math.round(raw)));
}

function clampSidebarWidth(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(raw)));
}

function clampChatPanelWidth(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(CHAT_PANEL_WIDTH_MAX, Math.max(CHAT_PANEL_WIDTH_MIN, Math.round(raw)));
}

function clampHistoryCharLimit(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(HISTORY_CHAR_LIMIT_MAX, Math.max(HISTORY_CHAR_LIMIT_MIN, Math.round(raw)));
}

function isAppLocale(value) {
  return value === APP_LOCALES.DE || value === APP_LOCALES.EN;
}

/**
 * Normalisiert die Liste abgewählter Tool-Namen (Einstellungen › Tools).
 * Gibt undefined zurück, wenn kein Array übergeben wurde; sonst eine
 * bereinigte, deduplizierte Liste (leeres Array = alle Tools aktiv).
 */
function normalizeDisabledTools(raw) {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function createSettingsOk() {
  return { ok: true };
}

function createSettingsError(error, code) {
  const out = { ok: false, error: String(error ?? '') };
  if (code) out.code = code;
  return out;
}

function createListModelsResult({ models, error } = {}) {
  if (error) return { error: String(error) };
  if (!Array.isArray(models)) return { models: [] };
  const out = [];
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) continue;
    out.push({
      id: m.id.trim(),
      ...(typeof m.label === 'string' && m.label.trim() ? { label: m.label.trim() } : {}),
    });
  }
  return { models: out };
}

/** Erlaubte Preset-Options-Keys laut Provider-Präsentation. */
function allowedPresetOptionKeys(provider) {
  const fields = provider?.presentation?.presetFields;
  if (!Array.isArray(fields)) return new Set();
  const out = new Set();
  for (const field of fields) {
    if (typeof field?.key === 'string' && field.key.trim()) out.add(field.key.trim());
  }
  return out;
}

/** Filtert ein Options-Objekt auf deklarierte presetFields-Keys. */
function filterDeclaredPresetOptions(options, provider) {
  if (!options || typeof options !== 'object') return undefined;
  const allowed = allowedPresetOptionKeys(provider);
  if (allowed.size === 0) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    else if (value != null && value !== '') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Extrahiert provider-spezifische Preset-Optionen aus Wire- oder Legacy-Feldern. */
function extractPresetOptions(raw, provider) {
  const fields = provider?.presentation?.presetFields;
  if (!Array.isArray(fields) || fields.length === 0) return {};

  const out = {};
  const legacy = raw && typeof raw === 'object' ? raw : {};
  for (const field of fields) {
    const key = field?.key;
    if (typeof key !== 'string' || !key.trim()) continue;
    let value = null;
    if (typeof legacy[key] === 'string' && legacy[key].trim()) {
      value = legacy[key].trim();
    } else if (legacy.options && typeof legacy.options === 'object' && typeof legacy.options[key] === 'string') {
      const v = legacy.options[key].trim();
      if (v) value = v;
    }
    if (!value) continue;
    const allowed = Array.isArray(field.options)
      ? field.options.some((o) => o && o.value === value)
      : true;
    if (allowed) out[key] = value;
  }
  return out;
}

/**
 * Normalisiert einen Preset-Eintrag für Persistenz und IPC.
 * @param {object} raw
 * @param {(id: string) => object|null} getProvider
 */
function normalizePresetWire(raw, getProvider) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const providerId = typeof raw.providerId === 'string' && raw.providerId.trim()
    ? raw.providerId.trim()
    : null;
  if (!id || !providerId) return null;
  const provider = getProvider(providerId);
  if (!provider) return null;

  let model =
    typeof raw.model === 'string' && raw.model.trim()
      ? raw.model.trim()
      : provider.defaultModel;
  const menuVisible = raw.menuVisible !== false;
  const options = extractPresetOptions(raw, provider);

  const preset = { id, providerId, model, menuVisible };
  if (Object.keys(options).length > 0) {
    for (const [k, v] of Object.entries(options)) {
      preset[k] = v;
    }
  }
  return preset;
}

function presetIdentityKey(preset, providerOrView) {
  if (!preset) return '';
  const parts = [preset.providerId, preset.model || ''];
  const fields = providerOrView?.presentation?.presetFields
    || providerOrView?.presetFields;
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (field?.affectsPresetIdentity && field.key) {
        parts.push(preset[field.key] ?? preset.options?.[field.key] ?? '');
      }
    }
  }
  return parts.join('\0');
}

function normalizeProviderPatch(raw, provider) {
  if (!raw || typeof raw !== 'object' || !provider) return {};
  const patch = {};
  if (raw.removeApiKey === true) patch.removeApiKey = true;
  if (typeof raw.apiKey === 'string' && raw.apiKey.trim() && provider.fields?.apiKey) {
    patch.apiKey = raw.apiKey.trim();
  }
  if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim() && provider.fields?.baseUrl) {
    patch.baseUrl = raw.baseUrl.trim();
  }
  if (typeof raw.insecureTls === 'boolean' && provider.fields?.insecureTls) {
    patch.insecureTls = raw.insecureTls;
  }
  return patch;
}

function normalizeUiPrefs(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  let baseSystemPrompt = '';
  if (typeof data.baseSystemPrompt === 'string') {
    baseSystemPrompt = data.baseSystemPrompt;
  }
  const appLocale = data.appLocale === APP_LOCALES.EN ? APP_LOCALES.EN : APP_LOCALES.DE;
  let maxToolRounds;
  if (typeof data.maxToolRounds === 'number' && Number.isFinite(data.maxToolRounds)) {
    maxToolRounds = Math.round(data.maxToolRounds);
  }
  const sidebarWidth = clampSidebarWidth(data.sidebarWidth);
  const chatPanelWidth = clampChatPanelWidth(data.chatPanelWidth);
  const historyCharLimit = clampHistoryCharLimit(data.historyCharLimit);
  const activeSkills = normalizeActiveSkills(data.activeSkills);
  const ignoredUpdateVersion = typeof data.ignoredUpdateVersion === 'string'
    ? data.ignoredUpdateVersion
    : undefined;
  return {
    contentPaneVisible: data.contentPaneVisible !== false,
    baseSystemPrompt,
    appLocale,
    allowWorkspaceWrite: data.allowWorkspaceWrite === true,
    disabledTools: normalizeDisabledTools(data.disabledTools) || [],
    ...(activeSkills ? { activeSkills } : {}),
    ...(typeof maxToolRounds === 'number' ? { maxToolRounds } : {}),
    ...(typeof sidebarWidth === 'number' ? { sidebarWidth } : {}),
    ...(typeof chatPanelWidth === 'number' ? { chatPanelWidth } : {}),
    ...(typeof historyCharLimit === 'number' ? { historyCharLimit } : {}),
    ...(typeof ignoredUpdateVersion === 'string' ? { ignoredUpdateVersion } : {}),
  };
}

function normalizeUiPrefsPatch(raw) {
  const patch = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  if (typeof patch.contentPaneVisible === 'boolean') {
    out.contentPaneVisible = patch.contentPaneVisible;
  }
  if (typeof patch.baseSystemPrompt === 'string') {
    out.baseSystemPrompt = patch.baseSystemPrompt;
  }
  if (isAppLocale(patch.appLocale)) {
    out.appLocale = patch.appLocale;
  }
  const maxToolRounds = clampMaxToolRounds(patch.maxToolRounds);
  if (typeof maxToolRounds === 'number') {
    out.maxToolRounds = maxToolRounds;
  }
  const sidebarWidth = clampSidebarWidth(patch.sidebarWidth);
  if (typeof sidebarWidth === 'number') {
    out.sidebarWidth = sidebarWidth;
  }
  const chatPanelWidth = clampChatPanelWidth(patch.chatPanelWidth);
  if (typeof chatPanelWidth === 'number') {
    out.chatPanelWidth = chatPanelWidth;
  }
  const historyCharLimit = clampHistoryCharLimit(patch.historyCharLimit);
  if (typeof historyCharLimit === 'number') {
    out.historyCharLimit = historyCharLimit;
  }
  if (typeof patch.allowWorkspaceWrite === 'boolean') {
    out.allowWorkspaceWrite = patch.allowWorkspaceWrite;
  }
  const disabledTools = normalizeDisabledTools(patch.disabledTools);
  if (disabledTools) {
    out.disabledTools = disabledTools;
  }
  const activeSkills = normalizeActiveSkills(patch.activeSkills);
  if (activeSkills) {
    out.activeSkills = activeSkills;
  }
  if (typeof patch.ignoredUpdateVersion === 'string') {
    out.ignoredUpdateVersion = patch.ignoredUpdateVersion;
  }
  return out;
}

function normalizeListModelsRequest(raw) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const providerId = typeof payload.providerId === 'string' ? payload.providerId.trim() : '';
  const out = { providerId };
  if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
    out.apiKey = payload.apiKey.trim();
  }
  if (typeof payload.baseUrl === 'string' && payload.baseUrl.trim()) {
    out.baseUrl = payload.baseUrl.trim();
  }
  if (typeof payload.insecureTls === 'boolean') {
    out.insecureTls = payload.insecureTls;
  }
  return out;
}

function hasConnectionDetail(source) {
  return source?.connectionDetail === true || source?.presentation?.connectionDetail === true;
}

function formatConnectionDetail(source, { baseUrl, insecureTls } = {}) {
  if (!hasConnectionDetail(source)) return '';
  const url = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  const host = url ? url.replace(/^https?:\/\//, '') : 'Server';
  const tls = insecureTls === true;
  return `Server: ${host} · TLS ${tls ? 'insecure' : 'geprüft'}`;
}

function formatPresetOptionDetailFromView(preset, providerView) {
  const fields = providerView?.presetFields;
  if (!Array.isArray(fields)) return { text: '', style: PRESET_DETAIL_STYLES.DEFAULT };
  for (const field of fields) {
    const key = field?.key;
    if (!key) continue;
    const value = preset?.[key] ?? preset?.options?.[key];
    if (!value) continue;
    if (typeof field.detailPrefix === 'string' && field.detailPrefix) {
      return {
        text: `${field.detailPrefix}${value}`,
        style: field.detailStyle === PRESET_DETAIL_STYLES.MONO
          ? PRESET_DETAIL_STYLES.MONO
          : PRESET_DETAIL_STYLES.DEFAULT,
      };
    }
  }
  return { text: '', style: PRESET_DETAIL_STYLES.DEFAULT };
}

/**
 * Formatiert Preset-Sublabels aus normalisierten Provider-View-DTOs (Renderer + Main).
 * Optional connectionOverride für Credential-Drafts (baseUrl/insecureTls).
 */
function formatPresetSublabelFromView(preset, providerView, connectionOverride) {
  const optionDetail = formatPresetOptionDetailFromView(preset, providerView);
  if (optionDetail.text) return optionDetail;

  if (providerView?.connectionDetail) {
    const connection = connectionOverride || {
      baseUrl: providerView.baseUrl ?? providerView.defaultBaseUrl ?? '',
      insecureTls: providerView.insecureTls ?? providerView.defaultInsecureTls === true,
    };
    const text = formatConnectionDetail(providerView, connection);
    if (text) return { text, style: PRESET_DETAIL_STYLES.DEFAULT };
  }

  const apiBase = providerView?.apiBase || '';
  return { text: apiBase, style: PRESET_DETAIL_STYLES.DEFAULT };
}

function formatPresetOptionDetail(preset, provider) {
  const fields = provider?.presentation?.presetFields;
  if (!Array.isArray(fields)) return { text: '', style: PRESET_DETAIL_STYLES.DEFAULT };
  for (const field of fields) {
    const key = field?.key;
    if (!key || typeof field.formatDetail !== 'function') continue;
    const value = preset?.[key] ?? preset?.options?.[key];
    if (!value) continue;
    const text = field.formatDetail(value);
    if (!text) continue;
    return {
      text,
      style: field.detailStyle === PRESET_DETAIL_STYLES.MONO
        ? PRESET_DETAIL_STYLES.MONO
        : PRESET_DETAIL_STYLES.DEFAULT,
    };
  }
  return { text: '', style: PRESET_DETAIL_STYLES.DEFAULT };
}

function formatPresetSublabel(preset, provider, connection) {
  const optionDetail = formatPresetOptionDetail(preset, provider);
  if (optionDetail.text) return optionDetail;

  if (provider?.fields?.baseUrl) {
    const text = formatConnectionDetail(provider, connection);
    if (text) return { text, style: PRESET_DETAIL_STYLES.DEFAULT };
  }

  const apiBase = provider?.apiBase || '';
  return { text: apiBase, style: PRESET_DETAIL_STYLES.DEFAULT };
}

function buildPresetFieldViews(provider) {
  const fields = provider?.presentation?.presetFields;
  if (!Array.isArray(fields)) return [];
  const out = [];
  for (const field of fields) {
    if (!field || field.type !== PRESET_FIELD_TYPES.SELECT || !field.key) continue;
    const options = Array.isArray(field.options)
      ? field.options
          .filter((o) => o && typeof o.value === 'string')
          .map((o) => ({
            value: o.value,
            label: typeof o.label === 'string' ? o.label : o.value,
          }))
      : [];
    if (options.length === 0) continue;
    out.push({
      key: field.key,
      type: PRESET_FIELD_TYPES.SELECT,
      label: typeof field.label === 'string' ? field.label : field.key,
      hint: typeof field.hint === 'string' ? field.hint : '',
      options,
      defaultValue: typeof field.defaultValue === 'string'
        ? field.defaultValue
        : options[0].value,
      affectsPresetIdentity: field.affectsPresetIdentity === true,
      detailPrefix: typeof field.detailPrefix === 'string' ? field.detailPrefix : '',
      detailStyle: field.detailStyle === PRESET_DETAIL_STYLES.MONO
        ? PRESET_DETAIL_STYLES.MONO
        : PRESET_DETAIL_STYLES.DEFAULT,
    });
  }
  return out;
}

function buildProviderFormView(provider) {
  const presentation = provider?.presentation || {};
  const showApiKey = !!provider?.fields?.apiKey;
  const showBaseUrl = !!provider?.fields?.baseUrl;
  const showInsecureTls = !!provider?.fields?.insecureTls;
  return {
    showApiKey,
    apiKeyPlaceholder: typeof presentation.apiKeyPlaceholder === 'string'
      ? presentation.apiKeyPlaceholder
      : '••••••',
    showBaseUrl,
    baseUrlPlaceholder: typeof presentation.baseUrlPlaceholder === 'string'
      ? presentation.baseUrlPlaceholder
      : (provider?.defaultBaseUrl || 'http://localhost:11434'),
    showInsecureTls,
    insecureTlsHint: typeof presentation.insecureTlsHint === 'string'
      ? presentation.insecureTlsHint
      : 'Nur bei selbstsigniertem oder intern signiertem Zertifikat, dem du vertraust.',
  };
}

module.exports = {
  MAX_TOOL_ROUNDS_MIN,
  MAX_TOOL_ROUNDS_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  CHAT_PANEL_WIDTH_MIN,
  CHAT_PANEL_WIDTH_MAX,
  HISTORY_CHAR_LIMIT_MIN,
  HISTORY_CHAR_LIMIT_MAX,
  clampMaxToolRounds,
  clampSidebarWidth,
  clampChatPanelWidth,
  clampHistoryCharLimit,
  isAppLocale,
  normalizeDisabledTools,
  createSettingsOk,
  createSettingsError,
  createListModelsResult,
  normalizePresetWire,
  presetIdentityKey,
  normalizeProviderPatch,
  normalizeUiPrefs,
  normalizeUiPrefsPatch,
  normalizeListModelsRequest,
  formatConnectionDetail,
  formatPresetSublabel,
  formatPresetSublabelFromView,
  buildPresetFieldViews,
  buildProviderFormView,
  extractPresetOptions,
  allowedPresetOptionKeys,
  filterDeclaredPresetOptions,
};
