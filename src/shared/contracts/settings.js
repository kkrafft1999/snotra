/**
 * Settings-/Provider-/Preset-/UI-Prefs-Contracts (Roadmap-Etappe 1, Ergänzung).
 *
 * DTOs, Validatoren und reine Format-Helfer für die IPC-Grenze und die
 * persistierte LLM-/UI-Konfiguration. Additive Erweiterung des bestehenden
 * Wire-Formats — bestehende Felder bleiben erhalten.
 */
'use strict';

const {
  APP_LOCALES,
  PRESET_DETAIL_STYLES,
  PRESET_FIELD_TYPES,
  PRESET_FIELD_CONTROLS,
  DEFAULT_SKILL_SUGGESTION_MODE,
  isSkillSuggestionMode,
} = require('./enums');
const { normalizeActiveSkills, normalizeActiveWorkspaceSkills } = require('./skills');
const { createMessage, isMessage } = require('./message');
const { isRecord } = require('../runtime/is-record');

/**
 * What this file reads of a provider definition. `ProviderAdapter`
 * (`main/ports/provider-runtime-port.js`) is assignable to it; the shape is
 * written from this side because `shared/` must not import from `main/`.
 *
 * @typedef {import('./message').Message} Message
 * @typedef {string | Message} ProviderText
 * @typedef {'chat' | 'full'} ApiStyle
 * @typedef {(value: string | Message) => string} Say  puts a text or a message into words
 *
 * @typedef {Object} PresetFieldDefinition
 * @property {string} key
 * @property {string} [type]
 * @property {string} [control]
 * @property {ProviderText} [label]
 * @property {ProviderText} [toggleLabel]
 * @property {ProviderText} [hint]
 * @property {string} [defaultValue]
 * @property {boolean} [affectsPresetIdentity]
 * @property {string} [detailPrefix]
 * @property {string} [detailStyle]
 * @property {ReadonlyArray<{ value: string, label?: ProviderText }>} [options]
 * @property {(value: string) => string} [formatDetail]
 *
 * @typedef {Object} ProviderLike
 * @property {string|Message} [name]
 * @property {{ apiKey?: boolean, baseUrl?: boolean, insecureTls?: boolean, displayName?: boolean,
 *   apiStyle?: boolean, extraHeaders?: boolean, supportsImages?: boolean, sendTools?: boolean,
 *   maxOutputTokens?: boolean }} [fields]
 * @property {boolean} [optionalApiKey]
 * @property {boolean} [connectionPerPreset]
 * @property {string} [defaultModel]
 * @property {string} [defaultBaseUrl]
 * @property {ApiStyle} [defaultApiStyle]
 * @property {boolean} [defaultSendTools]
 * @property {boolean} [defaultSupportsImages]
 * @property {boolean} [defaultInsecureTls]
 * @property {string} [apiBase]
 * @property {{ apiKeyPlaceholder?: ProviderText, baseUrlPlaceholder?: string,
 *   insecureTlsHint?: ProviderText, connectionDetail?: boolean, manualModel?: boolean,
 *   offeredModels?: string, offeredModelsHint?: ProviderText,
 *   apiStyleOptions?: ReadonlyArray<{ value: string, label?: ProviderText }>,
 *   templates?: ReadonlyArray<{ id: string, label?: ProviderText, baseUrl?: string, apiStyle?: string, hint?: ProviderText }>,
 *   presetFields?: ReadonlyArray<PresetFieldDefinition> }} [presentation]
 *
 * The renderer's view of a provider (`settings-presentation-service`), the
 * part the format helpers below read.
 * @typedef {Object} ProviderViewLike
 * @property {boolean} [connectionDetail]
 * @property {PresetFieldView[]} [presetFields]
 * @property {{ connectionPerPreset?: boolean, offeredModels?: string }} [form]
 * @property {string} [baseUrl]
 * @property {boolean} [insecureTls]
 *
 * Either of the two: `isModelOffered` and the identity key accept both.
 * @typedef {ProviderLike & ProviderViewLike} ProviderOrView
 *
 * @typedef {Object} PresetFieldView
 * @property {string} key
 * @property {'select'} type
 * @property {'dropdown'|'segmented'|'switch'} control
 * @property {string} label
 * @property {string} hint
 * @property {string} [toggleLabel]
 * @property {Array<{ value: string, label: string }>} options
 * @property {string} defaultValue
 * @property {boolean} affectsPresetIdentity
 * @property {string} detailPrefix
 * @property {'default'|'mono'} detailStyle
 *
 * @typedef {Object} ProviderTemplateView
 * @property {string} id
 * @property {string} label
 * @property {string} baseUrl
 * @property {ApiStyle} apiStyle
 * @property {string} hint
 */

/**
 * Fallback for the `say` parameter below: plain text as it stands, a message
 * as its bare key. Main and renderer always hand in a real translator — this
 * only keeps a forgotten one visible instead of printing "[object Object]".
 *
 * @type {Say}
 */
function plainText(value) {
  if (typeof value === 'string') return value;
  return isMessage(value) ? value.key : '';
}

/**
 * Text or message from a provider definition, or `fallback` if it has none.
 *
 * @param {Say} say
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function sayText(say, value, fallback) {
  return typeof value === 'string' || isMessage(value) ? say(value) : fallback;
}

/**
 * Schema-Version von `llm-config.json`.
 *
 * 3: Presets mit Provider-ID und Modell, Verbindung unter `providers[id]`.
 * 4: Bei Anbietern mit `connectionPerPreset` liegt die Verbindung im Eintrag
 *    (Issue #202). Wer die Zahl erhoeht, schreibt die Migration dazu.
 * 5: The dedicated `mlx-lm` provider is gone; its entries became entries of
 *    `openai-compatible` (issue #194).
 * 6: Entries carry no reasoning level (#726). Entries that differed only in it
 *    became one; `presetAliases` says which entry and which level each old
 *    entry stands for, so a chat from before keeps the level it ran with.
 */
const LLM_CONFIG_VERSION = 6;

/**
 * Output limit of an OpenAI-compatible entry (#931). Absent means nothing is
 * sent and the server's default applies. The upper bound only catches typos —
 * no model writes a million tokens in one answer.
 */
const MAX_OUTPUT_TOKENS_MIN = 1;
const MAX_OUTPUT_TOKENS_MAX = 1000000;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isMaxOutputTokens(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= MAX_OUTPUT_TOKENS_MIN && value <= MAX_OUTPUT_TOKENS_MAX;
}

/**
 * What the user typed into the field: `{ value: null }` for empty, `{ value: n }`
 * for a valid limit, `{ error: true }` for anything else. Thousands separators
 * are accepted in groups of three (`8,192`, `8.192`, `8 192`), so `8.5` is an
 * error rather than 85; signs and decimals are errors too.
 *
 * @param {unknown} raw
 * @returns {{ value?: number|null, error?: true }}
 */
function parseMaxOutputTokensInput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { value: null };
  if (!/^(?:\d+|\d{1,3}(?:[ ,.'\u00a0\u202f]\d{3})+)$/.test(text)) return { error: true };
  const value = Number(text.replace(/\D/g, ''));
  return isMaxOutputTokens(value) ? { value } : { error: true };
}

const MAX_TOOL_ROUNDS_MIN = 1;
const MAX_TOOL_ROUNDS_MAX = 500;
// The same minimum as `#sidebar { min-width }` in styles.css and SIDEBAR_MIN
// in SidebarResizer.js — 180 px is what the CSS has always rendered (#637).
// test/sidebar-resizer-dom.test.js fails if the three drift apart.
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 600;
const CHAT_PANEL_WIDTH_MIN = 260;
const CHAT_PANEL_WIDTH_MAX = 2000;
// Verlaufsspalte (Epic #223, Phase B). Schmaler als 180 px bricht die Zeile
// „Titel + Zeitpunkt" auseinander, breiter als 800 px hat sie nichts zu zeigen.
const CHAT_HISTORY_WIDTH_MIN = 180;
const CHAT_HISTORY_WIDTH_MAX = 800;
// How far the Markdown preview zooms (#829): the steps of the PDF and image
// zoom between these two (file-views/zoom-tools.js). Below half the text is
// unreadable, beyond three times a line holds a handful of words.
const MARKDOWN_ZOOM_MIN = 0.5;
const MARKDOWN_ZOOM_MAX = 3;
const HISTORY_CHAR_LIMIT_MIN = 4000;
const HISTORY_CHAR_LIMIT_MAX = 2_000_000;

/** @param {unknown} raw @returns {number|undefined} */
function clampMaxToolRounds(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(MAX_TOOL_ROUNDS_MAX, Math.max(MAX_TOOL_ROUNDS_MIN, Math.round(raw)));
}

/** @param {unknown} raw @returns {number|undefined} */
function clampSidebarWidth(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(raw)));
}

/** @param {unknown} raw @returns {number|undefined} */
function clampChatPanelWidth(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(CHAT_PANEL_WIDTH_MAX, Math.max(CHAT_PANEL_WIDTH_MIN, Math.round(raw)));
}

/** @param {unknown} raw @returns {number|undefined} */
function clampChatHistoryWidth(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(CHAT_HISTORY_WIDTH_MAX, Math.max(CHAT_HISTORY_WIDTH_MIN, Math.round(raw)));
}

/** @param {unknown} raw @returns {number|undefined} */
function clampMarkdownZoom(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.round(Math.min(MARKDOWN_ZOOM_MAX, Math.max(MARKDOWN_ZOOM_MIN, raw)) * 100) / 100;
}

/** @param {unknown} raw @returns {number|undefined} */
function clampHistoryCharLimit(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(HISTORY_CHAR_LIMIT_MAX, Math.max(HISTORY_CHAR_LIMIT_MIN, Math.round(raw)));
}

/**
 * @param {unknown} value
 * @returns {value is 'de'|'en'}
 */
function isAppLocale(value) {
  return Object.values(APP_LOCALES).some((locale) => locale === value);
}

/**
 * Normalisiert die Liste abgewählter Tool-Namen (Einstellungen › Tools).
 * Gibt undefined zurück, wenn kein Array übergeben wurde; sonst eine
 * bereinigte, deduplizierte Liste (leeres Array = alle Tools aktiv).
 *
 * @param {unknown} raw
 * @returns {string[]|undefined}
 */
function normalizeDisabledTools(raw) {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set();
  /** @type {string[]} */
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

/** @returns {{ ok: true }} */
function createSettingsOk() {
  return { ok: true };
}

/**
 * A failed settings call. `error` is a message descriptor (`createMessage`)
 * wherever Snotra says it itself, and passes through as one — the settings
 * dialog puts it into words with `tMessage()` (#308). Plain text is what a
 * third party said and stays as it is.
 *
 * @param {unknown} error
 * @param {string} [code]
 * @returns {{ ok: false, error: Message|string, code?: string }}
 */
function createSettingsError(error, code) {
  /** @type {{ ok: false, error: Message|string, code?: string }} */
  const out = { ok: false, error: isMessage(error) ? error : String(error ?? '') };
  if (code) out.code = code;
  return out;
}

/** @param {{ models?: Array<{ id?: string, label?: string }>, error?: import('./message').Message|string|null }} [input] */
function createListModelsResult({ models, error } = {}) {
  if (error) return { error: isMessage(error) ? error : String(error) };
  if (!Array.isArray(models)) return { models: [] };
  /** @type {Array<{ id: string, label?: string }>} */
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

/**
 * Erlaubte Preset-Options-Keys laut Provider-Präsentation.
 *
 * @param {ProviderLike|null|undefined} provider
 * @returns {Set<string>}
 */
function allowedPresetOptionKeys(provider) {
  const fields = provider?.presentation?.presetFields;
  if (!Array.isArray(fields)) return new Set();
  const out = new Set();
  for (const field of fields) {
    if (typeof field?.key === 'string' && field.key.trim()) out.add(field.key.trim());
  }
  return out;
}

/**
 * Filtert ein Options-Objekt auf deklarierte presetFields-Keys.
 *
 * @param {unknown} options
 * @param {ProviderLike|null|undefined} provider
 * @returns {Record<string, unknown>|undefined}
 */
function filterDeclaredPresetOptions(options, provider) {
  if (!options || typeof options !== 'object') return undefined;
  const allowed = allowedPresetOptionKeys(provider);
  if (allowed.size === 0) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    else if (value != null && value !== '') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Extrahiert provider-spezifische Preset-Optionen aus Wire- oder Legacy-Feldern.
 *
 * @param {unknown} raw
 * @param {ProviderLike|null|undefined} provider
 * @returns {Record<string, string>}
 */
function extractPresetOptions(raw, provider) {
  const fields = provider?.presentation?.presetFields;
  if (!Array.isArray(fields) || fields.length === 0) return {};

  /** @type {Record<string, string>} */
  const out = {};
  // The wire row: the option itself, or under `options`, depending on who wrote it.
  const legacy = isRecord(raw) ? raw : {};
  for (const field of fields) {
    const key = field?.key;
    if (typeof key !== 'string' || !key.trim()) continue;
    /** @type {string | null} */
    let value = null;
    const direct = legacy[key];
    const nested = isRecord(legacy.options) ? legacy.options[key] : undefined;
    if (typeof direct === 'string' && direct.trim()) {
      value = direct.trim();
    } else if (typeof nested === 'string') {
      const v = nested.trim();
      if (v) value = v;
    }
    if (!value) continue;
    const allowed = Array.isArray(field.options)
      ? field.options.some((/** @type {{ value: string }|null} */ o) => o && o.value === value)
      : true;
    if (allowed) out[key] = value;
  }
  return out;
}

/**
 * Verbindung je Eintrag (Issue #202).
 *
 * Bei Anbietern mit `connectionPerPreset` gehören Server-URL, Schlüssel,
 * Zusatz-Header und die Schalter zum **Eintrag**, nicht zum Anbieter — nur so
 * lassen sich ein lokaler Server und ein Gateway nebeneinander führen.
 *
 * Drei Formen, die nie vermischt werden dürfen:
 *  - **gespeichert**: Klartextfelder + `apiKeyEnc`/`extraHeadersEnc`. Nur Platte
 *    und Main-Prozess.
 *  - **Entwurf** (Renderer → Main): Klartextfelder + `apiKey`/`extraHeaders` im
 *    Klartext, dazu `removeApiKey`/`removeExtraHeaders`. Lebt nur für die Dauer
 *    eines Speicherns.
 *  - **Ansicht** (Main → Renderer): Klartextfelder + `hasKey`/`hasExtraHeaders`.
 *    Der Renderer erfährt nie einen Geheimniswert.
 */
/**
 * @typedef {Object} PresetConnection  the stored form: plain fields and the encrypted secrets
 * @property {string} [displayName]
 * @property {string} [baseUrl]
 * @property {ApiStyle} [apiStyle]
 * @property {boolean} [insecureTls]
 * @property {boolean} [supportsImages]
 * @property {boolean} [sendTools]
 * @property {number} [maxOutputTokens]
 * @property {string} [apiKeyEnc]
 * @property {string} [extraHeadersEnc]
 *
 * @typedef {Object} PresetConnectionPatch  the draft from the renderer: secrets in plain text
 * @property {string} [displayName]  '' clears it
 * @property {string} [baseUrl]
 * @property {ApiStyle} [apiStyle]
 * @property {boolean} [insecureTls]
 * @property {boolean} [supportsImages]
 * @property {boolean} [sendTools]
 * @property {number|null} [maxOutputTokens]  `null` removes the limit
 * @property {string} [apiKey]
 * @property {boolean} [removeApiKey]
 * @property {string} [extraHeaders]
 * @property {boolean} [removeExtraHeaders]
 */
const PRESET_CONNECTION_PLAIN_FIELDS = Object.freeze([
  'displayName',
  'baseUrl',
  'apiStyle',
  'insecureTls',
  'supportsImages',
  'sendTools',
  'maxOutputTokens',
]);
const PRESET_CONNECTION_SECRET_FIELDS = Object.freeze(['apiKeyEnc', 'extraHeadersEnc']);

/**
 * A base URL as the providers build it: trimmed, without a trailing slash.
 * Two addresses that normalise alike are one endpoint — the unit a stored
 * secret is bound to (#537, #560).
 */
/**
 * @param {unknown} url
 * @returns {string}
 */
function normalizeBaseUrl(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

/**
 * Hängt die Verbindung bei diesem Anbieter am Eintrag statt am Anbieter?
 *
 * @param {ProviderLike|null|undefined} provider
 * @returns {boolean}
 */
function hasPresetConnection(provider) {
  return provider?.connectionPerPreset === true;
}

/**
 * @param {string} key  one of PRESET_CONNECTION_PLAIN_FIELDS
 * @param {unknown} value
 * @param {ProviderLike|null|undefined} provider
 * @returns {string|number|boolean|undefined}
 */
function connectionPlainValue(key, value, provider) {
  if (key === 'displayName') {
    return typeof value === 'string' ? value.trim().slice(0, MAX_DISPLAY_NAME_CHARS) : undefined;
  }
  if (key === 'baseUrl') {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
  if (key === 'apiStyle') {
    return isApiStyle(value) ? value : undefined;
  }
  if (key === 'sendTools') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (key === 'insecureTls' || key === 'supportsImages') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (key === 'maxOutputTokens') {
    return provider?.fields?.maxOutputTokens && isMaxOutputTokens(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Gespeicherte Verbindung eines Eintrags. Unbekannte Felder fallen weg; die
 * verschlüsselten Geheimnisse werden unverändert durchgereicht, weil nur der
 * Main-Prozess sie überhaupt lesen kann.
 *
 * @overload
 * @param {Record<string, unknown>} raw
 * @param {ProviderLike|null|undefined} provider
 * @returns {PresetConnection}
 *
 * @overload
 * @param {unknown} raw
 * @param {ProviderLike|null|undefined} provider
 * @returns {PresetConnection|undefined}
 *
 * @param {unknown} raw
 * @param {ProviderLike|null|undefined} provider
 * @returns {PresetConnection|undefined}
 */
function normalizeStoredPresetConnection(raw, provider) {
  if (!isRecord(raw)) return undefined;
  /** @type {PresetConnection & Record<string, unknown>} */
  const out = {};
  for (const key of PRESET_CONNECTION_PLAIN_FIELDS) {
    const value = connectionPlainValue(key, raw[key], provider);
    if (value !== undefined) out[key] = value;
  }
  for (const key of PRESET_CONNECTION_SECRET_FIELDS) {
    if (typeof raw[key] === 'string' && raw[key]) out[key] = raw[key];
  }
  // Voreinstellungen, damit ein Eintrag nie halb beschrieben in den Provider geht.
  if (out.apiStyle === undefined) out.apiStyle = provider?.defaultApiStyle || 'chat';
  if (out.sendTools === undefined) out.sendTools = provider?.defaultSendTools !== false;
  if (out.supportsImages === undefined) out.supportsImages = provider?.defaultSupportsImages === true;
  if (out.insecureTls === undefined) out.insecureTls = provider?.defaultInsecureTls === true;
  return out;
}

/**
 * Verbindungs-Entwurf aus dem Renderer. Klartext-Geheimnisse bleiben hier
 * stehen — der Aufrufer verschlüsselt sie sofort und wirft sie weg.
 *
 * @param {unknown} raw
 * @param {ProviderLike|null|undefined} provider
 * @returns {PresetConnectionPatch|undefined}
 */
function normalizePresetConnectionPatch(raw, provider) {
  if (!isRecord(raw)) return undefined;
  /** @type {PresetConnectionPatch & Record<string, unknown>} */
  const out = {};
  for (const key of PRESET_CONNECTION_PLAIN_FIELDS) {
    const value = connectionPlainValue(key, raw[key], provider);
    if (value !== undefined) out[key] = value;
  }
  // Der leere Anzeigename ist eine gültige Angabe: er löscht ihn.
  if (typeof raw.displayName === 'string' && !raw.displayName.trim()) out.displayName = '';
  // So is an empty output limit: `null` removes it (#931).
  if (raw.maxOutputTokens === null && provider?.fields?.maxOutputTokens) out.maxOutputTokens = null;
  if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) out.apiKey = raw.apiKey.trim();
  if (raw.removeApiKey === true) out.removeApiKey = true;
  if (typeof raw.extraHeaders === 'string' && raw.extraHeaders.trim()) {
    out.extraHeaders = raw.extraHeaders.slice(0, MAX_EXTRA_HEADERS_CHARS);
  }
  if (raw.removeExtraHeaders === true) out.removeExtraHeaders = true;
  return out;
}

/**
 * A preset entry as it is persisted and sent over IPC. Beyond the named
 * fields it carries the provider's preset options (`reasoningEffort`, …).
 *
 * @typedef {{ id: string, providerId: string, model: string|undefined, menuVisible: boolean,
 *   connection?: PresetConnection, [option: string]: unknown }} PresetWire
 *
 * What `presetIdentityKey` reads of an entry: the wire form, or the settings
 * dialog's row, which may keep the options under `options`.
 * @typedef {{ providerId?: string, model?: string, connection?: { baseUrl?: string },
 *   options?: Record<string, unknown>, [option: string]: unknown }} PresetRow
 *
 * The line under an entry in the settings: its text and how it is drawn.
 * @typedef {{ text: string, style: 'default'|'mono' }} PresetDetail
 */

/**
 * Normalisiert einen Preset-Eintrag für Persistenz und IPC.
 * @param {unknown} raw  anything; only an object can pass
 * @param {(id: string) => ProviderLike|null|undefined} getProvider
 * @returns {PresetWire|null}
 */
function normalizePresetWire(raw, getProvider) {
  if (!isRecord(raw)) return null;
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

  /** @type {PresetWire} */
  const preset = { id, providerId, model, menuVisible };
  if (Object.keys(options).length > 0) {
    for (const [k, v] of Object.entries(options)) {
      preset[k] = v;
    }
  }
  if (hasPresetConnection(provider)) {
    const connection = normalizeStoredPresetConnection(raw.connection, provider);
    if (connection) preset.connection = connection;
  }
  return preset;
}

/**
 * @param {PresetRow|null|undefined} preset
 * @param {ProviderOrView|null|undefined} providerOrView
 * @returns {string}
 */
function presetIdentityKey(preset, providerOrView) {
  if (!preset) return '';
  /** @type {unknown[]} */
  const parts = [preset.providerId, preset.model || ''];
  // Zwei Zeilen mit demselben Modell, aber verschiedenen Servern sind zwei
  // verschiedene Eintraege (Issue #202) — sonst lehnt die Liste den zweiten
  // als Dublette ab.
  // The renderer's provider view carries the flag under `form` (CR-B14-05);
  // an address without its trailing slash is the same server.
  if (hasPresetConnection(providerOrView) || providerOrView?.form?.connectionPerPreset === true) {
    parts.push(normalizeBaseUrl(preset.connection?.baseUrl || providerOrView?.defaultBaseUrl || ''));
  }
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

/** Anzeigename und Zusatz-Header sind Freitext; hier nur eine Obergrenze. */
const MAX_DISPLAY_NAME_CHARS = 60;
const MAX_EXTRA_HEADERS_CHARS = 4000;
const API_STYLES = Object.freeze(['chat', 'full']);

/**
 * @param {unknown} value
 * @returns {value is ApiStyle}
 */
function isApiStyle(value) {
  return typeof value === 'string' && API_STYLES.includes(value);
}

/**
 * @typedef {Object} ProviderPatch
 * @property {boolean} [removeApiKey]
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 * @property {boolean} [insecureTls]
 * @property {string} [displayName]
 * @property {ApiStyle} [apiStyle]
 * @property {boolean} [removeExtraHeaders]
 * @property {string} [extraHeaders]
 * @property {boolean} [supportsImages]
 * @property {boolean} [sendTools]
 */

/**
 * @param {unknown} raw
 * @param {ProviderLike|null|undefined} provider
 * @returns {ProviderPatch}
 */
function normalizeProviderPatch(raw, provider) {
  if (!isRecord(raw) || !provider) return {};
  /** @type {ProviderPatch} */
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
  // Felder des Providers „OpenAI-kompatibel" (Issue #193). Anders als bei
  // `baseUrl` ist der leere String hier eine gueltige Angabe: Er loescht den
  // Anzeigenamen bzw. die Zusatz-Header.
  if (typeof raw.displayName === 'string' && provider.fields?.displayName) {
    patch.displayName = raw.displayName.trim().slice(0, MAX_DISPLAY_NAME_CHARS);
  }
  if (isApiStyle(raw.apiStyle) && provider.fields?.apiStyle) {
    patch.apiStyle = raw.apiStyle;
  }
  if (raw.removeExtraHeaders === true && provider.fields?.extraHeaders) {
    patch.removeExtraHeaders = true;
  }
  if (typeof raw.extraHeaders === 'string' && raw.extraHeaders.trim() && provider.fields?.extraHeaders) {
    patch.extraHeaders = raw.extraHeaders.slice(0, MAX_EXTRA_HEADERS_CHARS);
  }
  if (typeof raw.supportsImages === 'boolean' && provider.fields?.supportsImages) {
    patch.supportsImages = raw.supportsImages;
  }
  if (typeof raw.sendTools === 'boolean' && provider.fields?.sendTools) {
    patch.sendTools = raw.sendTools;
  }
  return patch;
}

/** Pfad zu einem eigenen Interpreter (Issue #86); leerer String = automatisch suchen. */
const MAX_INTERPRETER_PATH_CHARS = 1024;

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeInterpreterPath(raw) {
  if (typeof raw !== 'string') return '';
  // Zeilenumbrueche und Steuerzeichen haetten in einem Programmpfad nichts zu
  // suchen und waeren beim Start ein Einfallstor.
  const value = raw.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return value.slice(0, MAX_INTERPRETER_PATH_CHARS);
}

/**
 * The image model chosen for `generate_image` (#85): an id of OpenAI's image
 * family, or '' for the default. Anything else — a chat model, a typo, a path
 * — is dropped, so the request never carries a model the Images API refuses
 * for a reason the user cannot see.
 */
const IMAGE_MODEL_PATTERN = /^(?:gpt-image|chatgpt-image)-[a-z0-9.-]+$/i;
const MAX_IMAGE_MODEL_CHARS = 80;

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeImageModel(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (value.length > MAX_IMAGE_MODEL_CHARS || !IMAGE_MODEL_PATTERN.test(value)) return '';
  return value;
}

/**
 * The UI preferences as they are persisted and sent to the renderer.
 * @typedef {ReturnType<typeof normalizeUiPrefs>} UiPrefs
 *
 * A change to them: any subset, each field already clamped.
 * @typedef {Partial<UiPrefs>} UiPrefsPatch
 */

/**
 * @param {unknown} raw
 */
function normalizeUiPrefs(raw) {
  /** @type {Record<string, unknown>} */
  const data = isRecord(raw) ? raw : {};
  let baseSystemPrompt = '';
  if (typeof data.baseSystemPrompt === 'string') {
    baseSystemPrompt = data.baseSystemPrompt;
  }
  // English has been the default since epic #277. Existing installations stay
  // on German all the same: the store slips `appLocale: 'de'` in when it reads
  // a preferences file without the field (see storage-service). Anyone who
  // never had one starts out in English here.
  const appLocale = isAppLocale(data.appLocale) ? data.appLocale : APP_LOCALES.EN;
  let maxToolRounds;
  if (typeof data.maxToolRounds === 'number' && Number.isFinite(data.maxToolRounds)) {
    maxToolRounds = Math.round(data.maxToolRounds);
  }
  const sidebarWidth = clampSidebarWidth(data.sidebarWidth);
  const chatPanelWidth = clampChatPanelWidth(data.chatPanelWidth);
  const chatHistoryWidth = clampChatHistoryWidth(data.chatHistoryWidth);
  const historyCharLimit = clampHistoryCharLimit(data.historyCharLimit);
  const markdownZoom = clampMarkdownZoom(data.markdownZoom);
  const activeSkills = normalizeActiveSkills(data.activeSkills);
  const activeWorkspaceSkills = normalizeActiveWorkspaceSkills(data.activeWorkspaceSkills);
  const ignoredUpdateVersion = typeof data.ignoredUpdateVersion === 'string'
    ? data.ignoredUpdateVersion
    : undefined;
  // Python-Ausfuehrung (Issue #86) ist bewusst standardmaessig aus: das Tool
  // fuehrt fremden Code aus und umgeht damit die Workspace-Grenze.
  const pythonExecutionEnabled = data.pythonExecutionEnabled === true;
  const pythonInterpreterPath = normalizeInterpreterPath(data.pythonInterpreterPath);
  const imageModel = normalizeImageModel(data.imageModel);
  // Shell-Ausfuehrung (Issue #102) ebenso: ein Befehl kann alles, was der
  // angemeldete Nutzer kann — das wird bewusst eingeschaltet.
  const shellExecutionEnabled = data.shellExecutionEnabled === true;
  // Umgebungsangaben im Systemprompt (Issue #138) sind standardmaessig an:
  // sie kosten wenig und sparen Tool-Runden. Wer den absoluten Pfad — und
  // damit seinen Benutzernamen — nicht an den Anbieter geben will, schaltet
  // sie ab; deshalb `!== false` statt `=== true`.
  const environmentInfoEnabled = data.environmentInfoEnabled !== false;
  // Projektanweisungen aus AGENTS.md (Issue #212) ebenfalls standardmaessig
  // an: Wer eine solche Datei anlegt, will, dass sie wirkt. Abgeschaltet wird
  // sie von dem, der einen fremden Ordner oeffnet und dessen Anweisungen
  // nicht uebernehmen will — deshalb `!== false` statt `=== true`.
  const projectInstructionsEnabled = data.projectInstructionsEnabled !== false;
  // A system notification when an approval card waits out of sight (#792,
  // step 5): on unless switched off, since a run that waits for the user
  // stands still until they notice it.
  const approvalNotificationsEnabled = data.approvalNotificationsEnabled !== false;
  // The silent update check after the start (#987): on unless switched off —
  // the quality model settled "automatic, but switchable". The check from the
  // menu ignores it.
  const autoUpdateCheckEnabled = data.autoUpdateCheckEnabled !== false;
  // Gedaechtnis (Issue #166), je Ebene ein Schalter. Beide standardmaessig an:
  // Wer nichts gemerkt hat, hat auch keine Datei, und dann kostet der Schalter
  // nichts. Die Ordner-Ebene ist zugleich die Notbremse fuer einen fremden
  // Ordner mit fremder `memory.md` — deshalb `!== false` wie bei #138/#212.
  const memoryWorkspaceEnabled = data.memoryWorkspaceEnabled !== false;
  const memoryUserEnabled = data.memoryUserEnabled !== false;
  // Von selbst merken (Issue #166) ist ebenfalls an: Ein Gedaechtnis, das nur
  // auf Zuruf waechst, bleibt leer, weil niemand im Arbeitsfluss daran denkt.
  // Wer das nicht will, schaltet es ab und behaelt „bitte merke dir …".
  const memorySelfEnabled = data.memorySelfEnabled !== false;
  // Skill-Vorschlaege (Issue #125): voreingestellt das lexikalische Verfahren,
  // weil es nichts kostet und nichts verlaesst den Rechner.
  const skillSuggestionMode = isSkillSuggestionMode(data.skillSuggestionMode)
    ? data.skillSuggestionMode
    : DEFAULT_SKILL_SUGGESTION_MODE;
  return {
    skillSuggestionMode,
    // Mittlere Anzeige (Issue #255): voreingestellt zu — wer nichts gespeichert
    // hat, faengt mit Baum und Chat an. Der Schluessel bleibt deshalb weg,
    // solange nichts gespeichert ist, statt als `false` durchzugehen: Der
    // Start unterscheidet beides (Issue #258). Ohne Ordner zeigt er den
    // Startschirm, aber nur, wenn die Spalte nicht ausdruecklich
    // weggeschaltet wurde — und das steht nur in einem echten `false`.
    ...(typeof data.contentPaneVisible === 'boolean'
      ? { contentPaneVisible: data.contentPaneVisible }
      : {}),
    // Seitenleiste (Issue #167): voreingestellt sichtbar — wer sie wegschaltet,
    // findet sie nach dem Neustart weggeschaltet vor. Deshalb `!== false`.
    sidebarVisible: data.sidebarVisible !== false,
    // Verlaufsspalte (Epic #223, Phase B): voreingestellt zu — der Verlauf war
    // vorher ein Ausklapper und soll niemanden ungefragt eine Spalte kosten.
    // Deshalb `=== true` statt `!== false`.
    chatHistoryVisible: data.chatHistoryVisible === true,
    // Chat-Spalte: voreingestellt sichtbar — sie ist der Grund, warum es die
    // App gibt. Wer sie wegschaltet, findet sie weggeschaltet vor.
    chatPanelVisible: data.chatPanelVisible !== false,
    // Hidden files in the tree (#436): off by default, so nothing changes for
    // anyone who does not look for the switch. Hence `=== true`.
    showHiddenFiles: data.showHiddenFiles === true,
    // Developer mode (#1213): off unless switched on with its shortcut. Not
    // in the patch below — only main's own toggle writes it.
    developerMode: data.developerMode === true,
    baseSystemPrompt,
    appLocale,
    // `allowWorkspaceWrite` (bis v1.3.1) wird bewusst nicht mehr übernommen: das
    // Berechtigungsmodell aus Issue #66 ersetzt den Schalter durch den Modus in
    // der Policy-Datei; beide Altwerte laufen auf `smart` hinaus.
    disabledTools: normalizeDisabledTools(data.disabledTools) || [],
    ...(activeSkills ? { activeSkills } : {}),
    // Per folder, and written by main only: the renderer sends its ticks, and
    // the settings handler binds them to the open folder (#576).
    ...(activeWorkspaceSkills ? { activeWorkspaceSkills } : {}),
    ...(typeof maxToolRounds === 'number' ? { maxToolRounds } : {}),
    ...(typeof sidebarWidth === 'number' ? { sidebarWidth } : {}),
    ...(typeof chatPanelWidth === 'number' ? { chatPanelWidth } : {}),
    ...(typeof chatHistoryWidth === 'number' ? { chatHistoryWidth } : {}),
    ...(typeof historyCharLimit === 'number' ? { historyCharLimit } : {}),
    // One size for every Markdown file (#829); absent until the user zooms.
    ...(typeof markdownZoom === 'number' ? { markdownZoom } : {}),
    ...(typeof ignoredUpdateVersion === 'string' ? { ignoredUpdateVersion } : {}),
    pythonExecutionEnabled,
    ...(pythonInterpreterPath ? { pythonInterpreterPath } : {}),
    ...(imageModel ? { imageModel } : {}),
    shellExecutionEnabled,
    environmentInfoEnabled,
    projectInstructionsEnabled,
    approvalNotificationsEnabled,
    autoUpdateCheckEnabled,
    memoryWorkspaceEnabled,
    memoryUserEnabled,
    memorySelfEnabled,
  };
}

/**
 * @param {unknown} raw
 * @returns {UiPrefsPatch}
 */
function normalizeUiPrefsPatch(raw) {
  /** @type {Record<string, unknown>} */
  const patch = isRecord(raw) ? raw : {};
  /** @type {UiPrefsPatch} */
  const out = {};
  if (typeof patch.contentPaneVisible === 'boolean') {
    out.contentPaneVisible = patch.contentPaneVisible;
  }
  if (typeof patch.sidebarVisible === 'boolean') {
    out.sidebarVisible = patch.sidebarVisible;
  }
  if (typeof patch.chatHistoryVisible === 'boolean') {
    out.chatHistoryVisible = patch.chatHistoryVisible;
  }
  if (typeof patch.chatPanelVisible === 'boolean') {
    out.chatPanelVisible = patch.chatPanelVisible;
  }
  if (typeof patch.showHiddenFiles === 'boolean') {
    out.showHiddenFiles = patch.showHiddenFiles;
  }
  if (typeof patch.baseSystemPrompt === 'string') {
    out.baseSystemPrompt = patch.baseSystemPrompt;
  }
  if (isAppLocale(patch.appLocale)) {
    out.appLocale = patch.appLocale;
  }
  if (isSkillSuggestionMode(patch.skillSuggestionMode)) {
    out.skillSuggestionMode = patch.skillSuggestionMode;
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
  const chatHistoryWidth = clampChatHistoryWidth(patch.chatHistoryWidth);
  if (typeof chatHistoryWidth === 'number') {
    out.chatHistoryWidth = chatHistoryWidth;
  }
  const historyCharLimit = clampHistoryCharLimit(patch.historyCharLimit);
  if (typeof historyCharLimit === 'number') {
    out.historyCharLimit = historyCharLimit;
  }
  const markdownZoom = clampMarkdownZoom(patch.markdownZoom);
  if (typeof markdownZoom === 'number') {
    out.markdownZoom = markdownZoom;
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
  if (typeof patch.pythonExecutionEnabled === 'boolean') {
    out.pythonExecutionEnabled = patch.pythonExecutionEnabled;
  }
  if (typeof patch.pythonInterpreterPath === 'string') {
    out.pythonInterpreterPath = normalizeInterpreterPath(patch.pythonInterpreterPath);
  }
  if (typeof patch.shellExecutionEnabled === 'boolean') {
    out.shellExecutionEnabled = patch.shellExecutionEnabled;
  }
  // '' goes through: it means "back to the default model".
  if (typeof patch.imageModel === 'string') {
    out.imageModel = normalizeImageModel(patch.imageModel);
  }
  if (typeof patch.environmentInfoEnabled === 'boolean') {
    out.environmentInfoEnabled = patch.environmentInfoEnabled;
  }
  if (typeof patch.projectInstructionsEnabled === 'boolean') {
    out.projectInstructionsEnabled = patch.projectInstructionsEnabled;
  }
  if (typeof patch.approvalNotificationsEnabled === 'boolean') {
    out.approvalNotificationsEnabled = patch.approvalNotificationsEnabled;
  }
  if (typeof patch.autoUpdateCheckEnabled === 'boolean') {
    out.autoUpdateCheckEnabled = patch.autoUpdateCheckEnabled;
  }
  if (typeof patch.memoryWorkspaceEnabled === 'boolean') {
    out.memoryWorkspaceEnabled = patch.memoryWorkspaceEnabled;
  }
  if (typeof patch.memoryUserEnabled === 'boolean') {
    out.memoryUserEnabled = patch.memoryUserEnabled;
  }
  if (typeof patch.memorySelfEnabled === 'boolean') {
    out.memorySelfEnabled = patch.memorySelfEnabled;
  }
  return out;
}

/**
 * @typedef {Object} ListModelsRequest
 * @property {string} providerId
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 * @property {boolean} [insecureTls]
 * @property {string} [presetId]  the stored connection to fall back on
 * @property {string} [extraHeaders]
 */

/**
 * @param {unknown} raw
 * @returns {ListModelsRequest}
 */
function normalizeListModelsRequest(raw) {
  /** @type {Record<string, unknown>} */
  const payload = isRecord(raw) ? raw : {};
  const providerId = typeof payload.providerId === 'string' ? payload.providerId.trim() : '';
  /** @type {ListModelsRequest} */
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
  // Verbindung je Eintrag (Issue #202): Der Dialog fragt die Modellliste fuer
  // die Zeile ab, an der gerade gearbeitet wird. `presetId` benennt die
  // gespeicherte Verbindung als Rueckfall, die Klartextfelder den Entwurf, der
  // noch nicht gespeichert ist.
  if (typeof payload.presetId === 'string' && payload.presetId.trim()) {
    out.presetId = payload.presetId.trim();
  }
  if (typeof payload.extraHeaders === 'string' && payload.extraHeaders.trim()) {
    out.extraHeaders = payload.extraHeaders;
  }
  return out;
}

/**
 * @param {ProviderOrView|null|undefined} source
 * @returns {boolean}
 */
function hasConnectionDetail(source) {
  return source?.connectionDetail === true || source?.presentation?.connectionDetail === true;
}

/**
 * "Server: localhost:11434 · TLS verified". `say` puts the catalogue entries
 * into words (#310): the renderer hands in `tMessage`, the main process a
 * translator bound to the stored language.
 *
 * @param {ProviderOrView|null|undefined} source  a provider or its catalogue entry
 * @param {{ baseUrl?: string, insecureTls?: boolean }} [connection]
 * @param {Say} [say]
 * @returns {string}
 */
function formatConnectionDetail(source, { baseUrl, insecureTls } = {}, say = plainText) {
  if (!hasConnectionDetail(source)) return '';
  const url = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  return say(createMessage('settings.models.connection', {
    host: url ? url.replace(/^https?:\/\//, '') : createMessage('settings.models.connection.noHost'),
    tls: createMessage(insecureTls === true
      ? 'settings.models.connection.tlsInsecure'
      : 'settings.models.connection.tlsVerified'),
  }));
}

/**
 * Erstes gesetztes Preset-Feld als Detailtext. `detailPrefix` ist optional:
 * Ohne Praefix steht der nackte Wert da.
 *
 * @param {PresetRow|null|undefined} preset
 * @param {ProviderOrView|null|undefined} providerView
 * @returns {PresetDetail}
 */
function formatPresetOptionDetailFromView(preset, providerView) {
  const fields = providerView?.presetFields;
  if (!Array.isArray(fields) || !isModelOffered(providerView, preset?.model)) {
    return { text: '', style: PRESET_DETAIL_STYLES.DEFAULT };
  }
  for (const field of fields) {
    const key = field?.key;
    if (!key) continue;
    if (typeof field.detailPrefix !== 'string') continue;
    const value = preset?.[key] ?? preset?.options?.[key];
    if (!value) continue;
    return {
      text: `${field.detailPrefix}${value}`,
      style: field.detailStyle === PRESET_DETAIL_STYLES.MONO
        ? PRESET_DETAIL_STYLES.MONO
        : PRESET_DETAIL_STYLES.DEFAULT,
    };
  }
  return { text: '', style: PRESET_DETAIL_STYLES.DEFAULT };
}

/**
 * Formatiert Preset-Sublabels aus normalisierten Provider-View-DTOs (Renderer + Main).
 * Optional connectionOverride für Credential-Drafts (baseUrl/insecureTls).
 *
 * @param {PresetRow|null|undefined} preset
 * @param {ProviderOrView|null|undefined} providerView
 * @param {{ baseUrl?: string, insecureTls?: boolean }|null} [connectionOverride]
 * @param {Say} [say]
 * @returns {PresetDetail}
 */
function formatPresetSublabelFromView(preset, providerView, connectionOverride, say = plainText) {
  if (!isModelOffered(providerView, preset?.model)) return noLongerOfferedDetail(say);
  const optionDetail = formatPresetOptionDetailFromView(preset, providerView);
  if (optionDetail.text) return optionDetail;

  if (providerView?.connectionDetail) {
    const connection = connectionOverride || {
      baseUrl: providerView.baseUrl ?? providerView.defaultBaseUrl ?? '',
      insecureTls: providerView.insecureTls ?? providerView.defaultInsecureTls === true,
    };
    const text = formatConnectionDetail(providerView, connection, say);
    if (text) return { text, style: PRESET_DETAIL_STYLES.DEFAULT };
  }

  const apiBase = providerView?.apiBase || '';
  return { text: apiBase, style: PRESET_DETAIL_STYLES.DEFAULT };
}

/**
 * Whether the provider still offers the entry's model (#724). A provider may
 * declare `presentation.offeredModels`, a pattern matched without case; the
 * renderer finds it under `form.offeredModels`. An entry outside the pattern
 * keeps working, but its preset fields no longer apply: they are not shown,
 * and the provider leaves them out of the request. No pattern, no limit.
 */
const offeredModelPatterns = new Map();

/**
 * @param {ProviderOrView|null|undefined} providerOrView
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
function isModelOffered(providerOrView, model) {
  const source = providerOrView?.presentation?.offeredModels ?? providerOrView?.form?.offeredModels;
  if (typeof source !== 'string' || !source) return true;
  let pattern = offeredModelPatterns.get(source);
  if (!pattern) {
    try {
      pattern = new RegExp(source, 'i');
    } catch {
      return true;
    }
    offeredModelPatterns.set(source, pattern);
  }
  const name = String(model || providerOrView?.defaultModel || '').trim();
  return pattern.test(name);
}

/**
 * @param {Say} say
 * @returns {PresetDetail}
 */
function noLongerOfferedDetail(say) {
  return {
    text: say(createMessage('settings.models.noLongerOffered')),
    style: PRESET_DETAIL_STYLES.DEFAULT,
  };
}

/**
 * @param {PresetRow|null|undefined} preset
 * @param {ProviderLike|null|undefined} provider
 * @returns {PresetDetail}
 */
function formatPresetOptionDetail(preset, provider) {
  const fields = provider?.presentation?.presetFields;
  if (!Array.isArray(fields) || !isModelOffered(provider, preset?.model)) {
    return { text: '', style: PRESET_DETAIL_STYLES.DEFAULT };
  }
  for (const field of fields) {
    const key = field?.key;
    if (!key || typeof field.formatDetail !== 'function') continue;
    const value = preset?.[key] ?? preset?.options?.[key];
    if (typeof value !== 'string' || !value) continue;
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

/**
 * @param {PresetRow|null|undefined} preset
 * @param {ProviderLike|null|undefined} provider
 * @param {{ baseUrl?: string, insecureTls?: boolean }} [connection]
 * @param {Say} [say]
 * @returns {PresetDetail}
 */
function formatPresetSublabel(preset, provider, connection, say = plainText) {
  if (!isModelOffered(provider, preset?.model)) return noLongerOfferedDetail(say);
  const optionDetail = formatPresetOptionDetail(preset, provider);
  if (optionDetail.text) return optionDetail;

  if (provider?.fields?.baseUrl) {
    const text = formatConnectionDetail(provider, connection, say);
    if (text) return { text, style: PRESET_DETAIL_STYLES.DEFAULT };
  }

  const apiBase = provider?.apiBase || '';
  return { text: apiBase, style: PRESET_DETAIL_STYLES.DEFAULT };
}

/**
 * The control a select field asks for, if its options allow it (#414): a
 * switch needs exactly two options, a segmented control at most seven. Anything
 * else falls back to the dropdown, which can hold any number. Seven is what
 * OpenAI's reasoning levels need (#718) and what fills the field column at the
 * narrowest window, 900 px — an eighth segment would no longer fit.
 */
/**
 * @param {PresetFieldDefinition} field
 * @param {unknown[]} options
 * @returns {'dropdown'|'segmented'|'switch'}
 */
function presetFieldControl(field, options) {
  if (field.control === PRESET_FIELD_CONTROLS.SWITCH && options.length === 2) {
    return PRESET_FIELD_CONTROLS.SWITCH;
  }
  if (field.control === PRESET_FIELD_CONTROLS.SEGMENTED && options.length <= 7) {
    return PRESET_FIELD_CONTROLS.SEGMENTED;
  }
  return PRESET_FIELD_CONTROLS.DROPDOWN;
}

/**
 * The view builders below turn a provider definition into plain data for the
 * settings dialog. Labels and hints may be catalogue messages there (#310);
 * `say` puts them into words, so the view holds finished text in one language.
 *
 * @param {ProviderLike|null|undefined} provider
 * @param {Say} [say]
 * @returns {PresetFieldView[]}
 */
function buildPresetFieldViews(provider, say = plainText) {
  const fields = provider?.presentation?.presetFields;
  if (!Array.isArray(fields)) return [];
  /** @type {PresetFieldView[]} */
  const out = [];
  for (const field of fields) {
    if (!field || field.type !== PRESET_FIELD_TYPES.SELECT || !field.key) continue;
    const options = Array.isArray(field.options)
      ? field.options
          .filter((/** @type {{ value: string, label?: ProviderText }|null} */ o) => o && typeof o.value === 'string')
          .map((/** @type {{ value: string, label?: ProviderText }} */ o) => ({
            value: o.value,
            label: sayText(say, o.label, o.value),
          }))
      : [];
    if (options.length === 0) continue;
    const control = presetFieldControl(field, options);
    out.push({
      key: field.key,
      type: PRESET_FIELD_TYPES.SELECT,
      control,
      label: sayText(say, field.label, field.key),
      hint: sayText(say, field.hint, ''),
      ...(control === PRESET_FIELD_CONTROLS.SWITCH
        ? { toggleLabel: sayText(say, field.toggleLabel, '') }
        : {}),
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

/**
 * Vorlagen des Providers als reine Daten fuer die Oberflaeche (Issue #193).
 *
 * @param {ProviderLike|null|undefined} provider
 * @param {Say} [say]
 * @returns {ProviderTemplateView[]}
 */
function buildProviderTemplateViews(provider, say = plainText) {
  const templates = provider?.presentation?.templates;
  if (!Array.isArray(templates)) return [];
  /** @type {ProviderTemplateView[]} */
  const out = [];
  for (const template of templates) {
    if (!template || typeof template.id !== 'string' || !template.id.trim()) continue;
    out.push({
      id: template.id.trim(),
      label: sayText(say, template.label, template.id.trim()),
      baseUrl: typeof template.baseUrl === 'string' ? template.baseUrl : '',
      apiStyle: isApiStyle(template.apiStyle) ? template.apiStyle : 'chat',
      hint: sayText(say, template.hint, ''),
    });
  }
  return out;
}

/**
 * @param {ProviderLike|null|undefined} provider
 * @param {Say} [say]
 */
function buildProviderFormView(provider, say = plainText) {
  const presentation = provider?.presentation || {};
  const showApiKey = !!provider?.fields?.apiKey;
  const showBaseUrl = !!provider?.fields?.baseUrl;
  const showInsecureTls = !!provider?.fields?.insecureTls;
  const apiStyleOptions = Array.isArray(presentation.apiStyleOptions)
    ? presentation.apiStyleOptions
        .filter((o) => o && isApiStyle(o.value))
        .map((o) => ({ value: o.value, label: sayText(say, o.label, o.value) }))
    : [];
  return {
    showApiKey,
    // Ein optionaler Key braucht eine andere Beschriftung als ein fehlender:
    // „leer lassen" ist hier kein Mangel, sondern der Normalfall (Issue #193).
    apiKeyOptional: provider?.optionalApiKey === true,
    apiKeyPlaceholder: sayText(say, presentation.apiKeyPlaceholder, '••••••'),
    showBaseUrl,
    baseUrlPlaceholder: typeof presentation.baseUrlPlaceholder === 'string'
      ? presentation.baseUrlPlaceholder
      : (provider?.defaultBaseUrl || 'http://localhost:11434'),
    showInsecureTls,
    insecureTlsHint: sayText(
      say,
      presentation.insecureTlsHint,
      say(createMessage('addModel.insecure.hint'))
    ),
    // Felder des Providers „OpenAI-kompatibel" (Issue #193).
    showDisplayName: !!provider?.fields?.displayName,
    displayNamePlaceholder: sayText(say, provider?.name, ''),
    showApiStyle: !!provider?.fields?.apiStyle && apiStyleOptions.length > 0,
    apiStyleOptions,
    defaultApiStyle: isApiStyle(provider?.defaultApiStyle) ? provider.defaultApiStyle : 'chat',
    showExtraHeaders: !!provider?.fields?.extraHeaders,
    showSupportsImages: !!provider?.fields?.supportsImages,
    showSendTools: !!provider?.fields?.sendTools,
    showMaxOutputTokens: !!provider?.fields?.maxOutputTokens,
    // Ohne erreichbare Modellliste bleibt der Anbieter per Hand nutzbar.
    allowManualModel: presentation.manualModel === true,
    // The models still offered, and what the dialog says about one that is
    // not (#724) — see isModelOffered.
    offeredModels: typeof presentation.offeredModels === 'string' ? presentation.offeredModels : '',
    offeredModelsHint: sayText(say, presentation.offeredModelsHint, ''),
    // Verbindung je Eintrag (Issue #202): Das Formular bearbeitet dann die
    // Zeile, nicht den Anbieter.
    connectionPerPreset: provider?.connectionPerPreset === true,
    templates: buildProviderTemplateViews(provider, say),
  };
}

module.exports = {
  normalizeImageModel,
  LLM_CONFIG_VERSION,
  MAX_OUTPUT_TOKENS_MIN,
  MAX_OUTPUT_TOKENS_MAX,
  isMaxOutputTokens,
  parseMaxOutputTokensInput,
  API_STYLES,
  isApiStyle,
  MAX_DISPLAY_NAME_CHARS,
  MAX_EXTRA_HEADERS_CHARS,
  MAX_TOOL_ROUNDS_MIN,
  MAX_TOOL_ROUNDS_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  CHAT_PANEL_WIDTH_MIN,
  CHAT_PANEL_WIDTH_MAX,
  CHAT_HISTORY_WIDTH_MIN,
  CHAT_HISTORY_WIDTH_MAX,
  HISTORY_CHAR_LIMIT_MIN,
  HISTORY_CHAR_LIMIT_MAX,
  MARKDOWN_ZOOM_MIN,
  MARKDOWN_ZOOM_MAX,
  clampMaxToolRounds,
  clampSidebarWidth,
  clampChatPanelWidth,
  clampChatHistoryWidth,
  clampHistoryCharLimit,
  clampMarkdownZoom,
  isAppLocale,
  normalizeDisabledTools,
  createSettingsOk,
  createSettingsError,
  createListModelsResult,
  normalizePresetWire,
  presetIdentityKey,
  isModelOffered,
  hasPresetConnection,
  normalizeBaseUrl,
  normalizeStoredPresetConnection,
  normalizePresetConnectionPatch,
  PRESET_CONNECTION_PLAIN_FIELDS,
  PRESET_CONNECTION_SECRET_FIELDS,
  normalizeProviderPatch,
  normalizeUiPrefs,
  normalizeUiPrefsPatch,
  normalizeListModelsRequest,
  formatConnectionDetail,
  formatPresetSublabel,
  formatPresetSublabelFromView,
  buildPresetFieldViews,
  buildProviderFormView,
  buildProviderTemplateViews,
  extractPresetOptions,
  allowedPresetOptionKeys,
  filterDeclaredPresetOptions,
};
