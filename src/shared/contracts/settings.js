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
  DEFAULT_SKILL_SUGGESTION_MODE,
  isSkillSuggestionMode,
} = require('./enums');
const { normalizeActiveSkills } = require('./skills');

/**
 * Schema-Version von `llm-config.json`.
 *
 * 3: Presets mit Provider-ID und Modell, Verbindung unter `providers[id]`.
 * 4: Bei Anbietern mit `connectionPerPreset` liegt die Verbindung im Eintrag
 *    (Issue #202). Wer die Zahl erhoeht, schreibt die Migration dazu.
 */
const LLM_CONFIG_VERSION = 4;

const MAX_TOOL_ROUNDS_MIN = 1;
const MAX_TOOL_ROUNDS_MAX = 500;
const SIDEBAR_WIDTH_MIN = 150;
const SIDEBAR_WIDTH_MAX = 600;
const CHAT_PANEL_WIDTH_MIN = 260;
const CHAT_PANEL_WIDTH_MAX = 2000;
// Verlaufsspalte (Epic #223, Phase B). Schmaler als 180 px bricht die Zeile
// „Titel + Zeitpunkt" auseinander, breiter als 800 px hat sie nichts zu zeigen.
const CHAT_HISTORY_WIDTH_MIN = 180;
const CHAT_HISTORY_WIDTH_MAX = 800;
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

function clampChatHistoryWidth(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(CHAT_HISTORY_WIDTH_MAX, Math.max(CHAT_HISTORY_WIDTH_MIN, Math.round(raw)));
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
const PRESET_CONNECTION_PLAIN_FIELDS = Object.freeze([
  'displayName',
  'baseUrl',
  'apiStyle',
  'insecureTls',
  'supportsImages',
  'sendTools',
]);
const PRESET_CONNECTION_SECRET_FIELDS = Object.freeze(['apiKeyEnc', 'extraHeadersEnc']);

/** Hängt die Verbindung bei diesem Anbieter am Eintrag statt am Anbieter? */
function hasPresetConnection(provider) {
  return provider?.connectionPerPreset === true;
}

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
  return undefined;
}

/**
 * Gespeicherte Verbindung eines Eintrags. Unbekannte Felder fallen weg; die
 * verschlüsselten Geheimnisse werden unverändert durchgereicht, weil nur der
 * Main-Prozess sie überhaupt lesen kann.
 */
function normalizeStoredPresetConnection(raw, provider) {
  if (!raw || typeof raw !== 'object') return undefined;
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
 */
function normalizePresetConnectionPatch(raw, provider) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const key of PRESET_CONNECTION_PLAIN_FIELDS) {
    const value = connectionPlainValue(key, raw[key], provider);
    if (value !== undefined) out[key] = value;
  }
  // Der leere Anzeigename ist eine gültige Angabe: er löscht ihn.
  if (typeof raw.displayName === 'string' && !raw.displayName.trim()) out.displayName = '';
  if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) out.apiKey = raw.apiKey.trim();
  if (raw.removeApiKey === true) out.removeApiKey = true;
  if (typeof raw.extraHeaders === 'string' && raw.extraHeaders.trim()) {
    out.extraHeaders = raw.extraHeaders.slice(0, MAX_EXTRA_HEADERS_CHARS);
  }
  if (raw.removeExtraHeaders === true) out.removeExtraHeaders = true;
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
  if (hasPresetConnection(provider)) {
    const connection = normalizeStoredPresetConnection(raw.connection, provider);
    if (connection) preset.connection = connection;
  }
  return preset;
}

function presetIdentityKey(preset, providerOrView) {
  if (!preset) return '';
  const parts = [preset.providerId, preset.model || ''];
  // Zwei Zeilen mit demselben Modell, aber verschiedenen Servern sind zwei
  // verschiedene Eintraege (Issue #202) — sonst lehnt die Liste den zweiten
  // als Dublette ab.
  if (hasPresetConnection(providerOrView) || providerOrView?.connectionPerPreset) {
    parts.push(preset.connection?.baseUrl || '');
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

function isApiStyle(value) {
  return typeof value === 'string' && API_STYLES.includes(value);
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

function normalizeInterpreterPath(raw) {
  if (typeof raw !== 'string') return '';
  // Zeilenumbrueche und Steuerzeichen haetten in einem Programmpfad nichts zu
  // suchen und waeren beim Start ein Einfallstor.
  const value = raw.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return value.slice(0, MAX_INTERPRETER_PATH_CHARS);
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
  const chatHistoryWidth = clampChatHistoryWidth(data.chatHistoryWidth);
  const historyCharLimit = clampHistoryCharLimit(data.historyCharLimit);
  const activeSkills = normalizeActiveSkills(data.activeSkills);
  const ignoredUpdateVersion = typeof data.ignoredUpdateVersion === 'string'
    ? data.ignoredUpdateVersion
    : undefined;
  // Python-Ausfuehrung (Issue #86) ist bewusst standardmaessig aus: das Tool
  // fuehrt fremden Code aus und umgeht damit die Workspace-Grenze.
  const pythonExecutionEnabled = data.pythonExecutionEnabled === true;
  const pythonInterpreterPath = normalizeInterpreterPath(data.pythonInterpreterPath);
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
    baseSystemPrompt,
    appLocale,
    // `allowWorkspaceWrite` (bis v1.3.1) wird bewusst nicht mehr übernommen: das
    // Berechtigungsmodell aus Issue #66 ersetzt den Schalter durch den Modus in
    // der Policy-Datei; beide Altwerte laufen auf `smart` hinaus.
    disabledTools: normalizeDisabledTools(data.disabledTools) || [],
    ...(activeSkills ? { activeSkills } : {}),
    ...(typeof maxToolRounds === 'number' ? { maxToolRounds } : {}),
    ...(typeof sidebarWidth === 'number' ? { sidebarWidth } : {}),
    ...(typeof chatPanelWidth === 'number' ? { chatPanelWidth } : {}),
    ...(typeof chatHistoryWidth === 'number' ? { chatHistoryWidth } : {}),
    ...(typeof historyCharLimit === 'number' ? { historyCharLimit } : {}),
    ...(typeof ignoredUpdateVersion === 'string' ? { ignoredUpdateVersion } : {}),
    pythonExecutionEnabled,
    ...(pythonInterpreterPath ? { pythonInterpreterPath } : {}),
    shellExecutionEnabled,
    environmentInfoEnabled,
    projectInstructionsEnabled,
  };
}

function normalizeUiPrefsPatch(raw) {
  const patch = raw && typeof raw === 'object' ? raw : {};
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
  if (typeof patch.environmentInfoEnabled === 'boolean') {
    out.environmentInfoEnabled = patch.environmentInfoEnabled;
  }
  if (typeof patch.projectInstructionsEnabled === 'boolean') {
    out.projectInstructionsEnabled = patch.projectInstructionsEnabled;
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

/**
 * Erstes gesetztes Preset-Feld als Detailtext. `detailPrefix` ist optional:
 * Ohne Praefix steht der nackte Wert da (z. B. „high“) — so laesst er sich
 * hinter das Modell haengen, ohne den API-Parameternamen mitzuschleppen.
 * `showAsSuffix: true` markiert Felder, die im Chat-Menue und in der Pille
 * hinter dem Modellnamen erscheinen sollen.
 */
function formatPresetOptionDetailFromView(preset, providerView) {
  const fields = providerView?.presetFields;
  if (!Array.isArray(fields)) return { text: '', style: PRESET_DETAIL_STYLES.DEFAULT };
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
 * Nackter Wert des ersten als `showAsSuffix` markierten Preset-Felds — der
 * Zusatz, der im Chat hinter dem Modellnamen steht (z. B. „high“). Leerer
 * String, wenn der Provider kein solches Feld hat.
 */
function formatPresetOptionSuffixFromView(preset, providerView) {
  const fields = providerView?.presetFields;
  if (!Array.isArray(fields)) return '';
  for (const field of fields) {
    const key = field?.key;
    if (!key || field.showAsSuffix !== true) continue;
    const value = preset?.[key] ?? preset?.options?.[key];
    if (!value) continue;
    return String(value);
  }
  return '';
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
      showAsSuffix: field.showAsSuffix === true,
      detailStyle: field.detailStyle === PRESET_DETAIL_STYLES.MONO
        ? PRESET_DETAIL_STYLES.MONO
        : PRESET_DETAIL_STYLES.DEFAULT,
    });
  }
  return out;
}

/** Vorlagen des Providers als reine Daten fuer die Oberflaeche (Issue #193). */
function buildProviderTemplateViews(provider) {
  const templates = provider?.presentation?.templates;
  if (!Array.isArray(templates)) return [];
  const out = [];
  for (const template of templates) {
    if (!template || typeof template.id !== 'string' || !template.id.trim()) continue;
    out.push({
      id: template.id.trim(),
      label: typeof template.label === 'string' ? template.label : template.id.trim(),
      baseUrl: typeof template.baseUrl === 'string' ? template.baseUrl : '',
      apiStyle: isApiStyle(template.apiStyle) ? template.apiStyle : 'chat',
      hint: typeof template.hint === 'string' ? template.hint : '',
    });
  }
  return out;
}

function buildProviderFormView(provider) {
  const presentation = provider?.presentation || {};
  const showApiKey = !!provider?.fields?.apiKey;
  const showBaseUrl = !!provider?.fields?.baseUrl;
  const showInsecureTls = !!provider?.fields?.insecureTls;
  const apiStyleOptions = Array.isArray(presentation.apiStyleOptions)
    ? presentation.apiStyleOptions
        .filter((o) => o && isApiStyle(o.value))
        .map((o) => ({ value: o.value, label: typeof o.label === 'string' ? o.label : o.value }))
    : [];
  return {
    showApiKey,
    // Ein optionaler Key braucht eine andere Beschriftung als ein fehlender:
    // „leer lassen" ist hier kein Mangel, sondern der Normalfall (Issue #193).
    apiKeyOptional: provider?.optionalApiKey === true,
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
    // Felder des Providers „OpenAI-kompatibel" (Issue #193).
    showDisplayName: !!provider?.fields?.displayName,
    displayNamePlaceholder: provider?.name || '',
    showApiStyle: !!provider?.fields?.apiStyle && apiStyleOptions.length > 0,
    apiStyleOptions,
    defaultApiStyle: isApiStyle(provider?.defaultApiStyle) ? provider.defaultApiStyle : 'chat',
    showExtraHeaders: !!provider?.fields?.extraHeaders,
    showSupportsImages: !!provider?.fields?.supportsImages,
    showSendTools: !!provider?.fields?.sendTools,
    // Ohne erreichbare Modellliste bleibt der Anbieter per Hand nutzbar.
    allowManualModel: presentation.manualModel === true,
    // Verbindung je Eintrag (Issue #202): Das Formular bearbeitet dann die
    // Zeile, nicht den Anbieter.
    connectionPerPreset: provider?.connectionPerPreset === true,
    templates: buildProviderTemplateViews(provider),
  };
}

module.exports = {
  LLM_CONFIG_VERSION,
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
  clampMaxToolRounds,
  clampSidebarWidth,
  clampChatPanelWidth,
  clampChatHistoryWidth,
  clampHistoryCharLimit,
  isAppLocale,
  normalizeDisabledTools,
  createSettingsOk,
  createSettingsError,
  createListModelsResult,
  normalizePresetWire,
  presetIdentityKey,
  hasPresetConnection,
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
  formatPresetOptionSuffixFromView,
  formatPresetSublabelFromView,
  buildPresetFieldViews,
  buildProviderFormView,
  buildProviderTemplateViews,
  extractPresetOptions,
  allowedPresetOptionKeys,
  filterDeclaredPresetOptions,
};
