/**
 * MCP-Server: Konfiguration, Verbindungsstatus und Tool-Katalog (Issue #106,
 * Teil von #62).
 *
 * Reine Validierung ohne Seiteneffekte — kein Prozess, kein Dateisystem, kein
 * Electron. Damit lässt sich eine Serverkonfiguration überall prüfen, wo sie
 * auftaucht: beim Import aus einem `mcpServers`-Block (#110), im Formular des
 * Settings-Dialogs (#109) und beim Laden der gespeicherten Konfiguration
 * (#108). Die Fehlertexte sind bewusst schon die, die der Nutzer später zu
 * sehen bekommt, damit nicht jede Schicht ihre eigenen erfindet.
 *
 * Bewusst eng geschnitten: nur stdio, nur `tools`. Resources, Prompts,
 * Sampling und HTTP/SSE bleiben draußen (Abgrenzung in #62).
 *
 * CommonJS, damit Main (require) und der Renderer (generiertes ESM-Bundle)
 * dieselben Werte sehen.
 */
'use strict';

const { TOOL_RISK_CLASSES } = require('./tool-permissions');

const MCP_CONTRACT_VERSION = 1;

/**
 * Protokollversion, die im `initialize`-Handshake angeboten wird. Ein Server
 * darf mit einer anderen antworten; der Dienst übernimmt dann seine Angabe,
 * solange wir sie kennen (siehe mcp-service).
 */
const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Nur stdio im MVP — HTTP/SSE ist bewusst ausgeklammert. */
const MCP_TRANSPORTS = { STDIO: 'stdio' };
const MCP_TRANSPORT_LIST = Object.freeze([MCP_TRANSPORTS.STDIO]);

/**
 * Lebenszyklus einer Verbindung. `failed` und `stopped` sind getrennt: das
 * eine ist ein Problem, das der Nutzer sehen soll, das andere ein normaler
 * Zustand (Server abgeschaltet oder App beendet).
 */
const MCP_CONNECTION_STATES = {
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

const MCP_LIMITS = {
  ID_MAX_CHARS: 64,
  LABEL_MAX_CHARS: 80,
  COMMAND_MAX_CHARS: 512,
  MAX_ARGS: 64,
  ARG_MAX_CHARS: 1024,
  MAX_ENV_ENTRIES: 64,
  ENV_KEY_MAX_CHARS: 128,
  ENV_VALUE_MAX_CHARS: 4096,
  MAX_TOOLS: 200,
  TOOL_NAME_MAX_CHARS: 128,
  DESCRIPTION_MAX_CHARS: 4096,
  /** stderr des Servers, für erklärbare Startfehler — mehr hilft niemandem. */
  STDERR_MAX_BYTES: 64 * 1024,
  /** Eine einzelne JSON-RPC-Zeile. Schützt vor einem Server, der nie „\n" schickt. */
  MAX_MESSAGE_BYTES: 8 * 1024 * 1024,
};

const MCP_TIMEOUTS = {
  /** Start plus `initialize` — ein Server, der npx erst herunterlädt, braucht Luft. */
  HANDSHAKE_MS: 20_000,
  REQUEST_MS: 60_000,
  /** Frist zwischen freundlichem Schließen von stdin und SIGKILL. */
  SHUTDOWN_MS: 3_000,
};

// Kleinbuchstaben, Ziffern und . _ - ; muss mit einem alphanumerischen Zeichen
// beginnen. Der Wert taucht später im Tool-Namensraum auf (#107) und in
// Dateinamen der Konfiguration (#108), deshalb keine Sonderzeichen.
const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
// „__" trennt im Tool-Namensraum (#107) Praefix, Server und Tool. Eine Kennung,
// die es selbst enthaelt, waere nicht mehr eindeutig zurueckzulesen.
const SERVER_ID_FORBIDDEN = /__/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isValidMcpServerId(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MCP_LIMITS.ID_MAX_CHARS
    && SERVER_ID_PATTERN.test(value)
    && !SERVER_ID_FORBIDDEN.test(value)
  );
}

function isMcpTransport(value) {
  return MCP_TRANSPORT_LIST.includes(value);
}

function isMcpConnectionState(value) {
  return Object.values(MCP_CONNECTION_STATES).includes(value);
}

/** Trimmt und kappt; alles, was kein String ist, wird zu ''. */
function text(value, maxChars) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxChars);
}

/**
 * Argumentliste: Nicht-Strings fliegen raus statt den ganzen Eintrag
 * ungültig zu machen — ein `null` in einer importierten Liste soll nicht die
 * Konfiguration eines sonst brauchbaren Servers verhindern.
 */
function normalizeArgs(raw, errors) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push('„args" muss eine Liste von Zeichenketten sein.');
    return [];
  }
  const out = [];
  for (const value of raw) {
    if (out.length >= MCP_LIMITS.MAX_ARGS) {
      errors.push(`Mehr als ${MCP_LIMITS.MAX_ARGS} Argumente werden nicht unterstützt.`);
      break;
    }
    if (typeof value !== 'string') continue;
    // Kein trim: ein Argument darf bewusst mit Leerzeichen enden.
    out.push(value.slice(0, MCP_LIMITS.ARG_MAX_CHARS));
  }
  return out;
}

/**
 * Umgebungsvariablen. Werte werden nicht gekürzt-und-gemeldet, sondern still
 * gekappt; ein API-Schlüssel ist nie so lang, und eine Fehlermeldung mit dem
 * Wert darin wäre ein Leck.
 */
function normalizeEnv(raw, errors) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('„env" muss ein Objekt aus Name/Wert-Paaren sein.');
    return {};
  }
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MCP_LIMITS.MAX_ENV_ENTRIES) {
      errors.push(`Mehr als ${MCP_LIMITS.MAX_ENV_ENTRIES} Umgebungsvariablen werden nicht unterstützt.`);
      break;
    }
    if (key.length > MCP_LIMITS.ENV_KEY_MAX_CHARS || !ENV_KEY_PATTERN.test(key)) {
      errors.push(`„${key.slice(0, 40)}" ist kein gültiger Name für eine Umgebungsvariable.`);
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`Der Wert von „${key}" muss eine Zeichenkette sein.`);
      continue;
    }
    out[key] = value.slice(0, MCP_LIMITS.ENV_VALUE_MAX_CHARS);
    count += 1;
  }
  return out;
}

/** Namen abgewählter Tools — Dopplungen und Leeres fallen weg. */
function normalizeDisabledTools(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const name = value.trim().slice(0, MCP_LIMITS.TOOL_NAME_MAX_CHARS);
    if (name) seen.add(name);
  }
  return [...seen].sort();
}

/**
 * Prüft eine Serverkonfiguration und liefert sie in Normalform.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value: McpServerConfig|null, errors: string[] }}
 */
function validateMcpServerConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, value: null, errors: ['Die Serverkonfiguration muss ein Objekt sein.'] };
  }

  // Die Kennung wird nicht gekappt, sondern geprueft: auf sie zeigen spaeter
  // Konfiguration (#108) und Tool-Namensraum (#107), und ein stillschweigend
  // gekuerzter Bezeichner zeigt auf etwas anderes als der eingegebene.
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!id) {
    errors.push('Es fehlt eine Kennung („id").');
  } else if (id.length > MCP_LIMITS.ID_MAX_CHARS) {
    errors.push(`Die Kennung darf höchstens ${MCP_LIMITS.ID_MAX_CHARS} Zeichen lang sein.`);
  } else if (SERVER_ID_FORBIDDEN.test(id)) {
    errors.push('Die Kennung darf keinen doppelten Unterstrich enthalten — er trennt im Tool-Namen Server und Tool.');
  } else if (!isValidMcpServerId(id)) {
    errors.push('Die Kennung darf nur Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Unterstrich enthalten und muss alphanumerisch beginnen.');
  }

  const transport = raw.transport === undefined || raw.transport === null
    ? MCP_TRANSPORTS.STDIO
    : raw.transport;
  if (!isMcpTransport(transport)) {
    errors.push('Nur der Transport „stdio" wird unterstützt.');
  }

  const command = text(raw.command, MCP_LIMITS.COMMAND_MAX_CHARS);
  if (!command) errors.push('Es fehlt das zu startende Kommando („command").');

  const args = normalizeArgs(raw.args, errors);
  const env = normalizeEnv(raw.env, errors);

  const cwd = text(raw.cwd, MCP_LIMITS.COMMAND_MAX_CHARS);
  const label = text(raw.label, MCP_LIMITS.LABEL_MAX_CHARS) || id;

  const value = {
    id,
    label,
    transport: isMcpTransport(transport) ? transport : MCP_TRANSPORTS.STDIO,
    command,
    args,
    env,
    cwd: cwd || null,
    // Fehlend heißt eingeschaltet: wer einen Server einträgt, will ihn nutzen.
    enabled: raw.enabled === undefined || raw.enabled === null ? true : raw.enabled === true,
    disabledTools: normalizeDisabledTools(raw.disabledTools),
  };

  return { ok: errors.length === 0, value: errors.length === 0 ? value : null, errors };
}

/** Wie validateMcpServerConfig, aber nur der Wert — null, wenn ungültig. */
function normalizeMcpServerConfig(raw) {
  return validateMcpServerConfig(raw).value;
}

/**
 * Ein Eintrag aus `tools/list`. Das `inputSchema` wird bewusst
 * durchgereicht statt geprüft — es ist JSON Schema für das Modell, nicht für
 * uns; ein Server, der hier Unsinn liefert, scheitert beim Aufruf, nicht
 * schon beim Auflisten. Fehlt es ganz, setzen wir das leere Objektschema,
 * damit die Anbindung in #107 sich auf ein Feld verlassen kann.
 */
function normalizeMcpToolCatalogEntry(raw, serverId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = text(raw.name, MCP_LIMITS.TOOL_NAME_MAX_CHARS);
  if (!name) return null;
  const schema = raw.inputSchema && typeof raw.inputSchema === 'object' && !Array.isArray(raw.inputSchema)
    ? raw.inputSchema
    : { type: 'object', properties: {} };
  // Von den Annotations wird nur uebernommen, was verschaerfen kann — die
  // uebrigen Hinweise (readOnlyHint, idempotentHint, openWorldHint) waeren
  // eine Selbsteinschaetzung des Servers, die seine Einstufung mildert.
  // Genau das soll sie nicht koennen (Entscheidung zu #107).
  const hints = raw.annotations && typeof raw.annotations === 'object' && !Array.isArray(raw.annotations)
    ? raw.annotations
    : null;
  return {
    serverId: typeof serverId === 'string' ? serverId : '',
    name,
    title: text(raw.title, MCP_LIMITS.LABEL_MAX_CHARS),
    description: text(raw.description, MCP_LIMITS.DESCRIPTION_MAX_CHARS),
    inputSchema: schema,
    annotations: { destructiveHint: hints?.destructiveHint === true },
  };
}

/** Ganzer Katalog; ungültige Einträge und Dopplungen fallen weg. */
function normalizeMcpToolCatalog(raw, serverId) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= MCP_LIMITS.MAX_TOOLS) break;
    const entry = normalizeMcpToolCatalogEntry(item, serverId);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}

/**
 * Statuszeile einer Verbindung — das, was der Settings-Dialog (#109) anzeigt.
 * `error` und `stderr` gehören zusammen: die Meldung sagt, was schiefging,
 * der stderr-Auszug sagt warum.
 */
function createMcpConnectionStatus({
  serverId = '',
  label = '',
  state = MCP_CONNECTION_STATES.IDLE,
  toolCount = 0,
  serverName = '',
  serverVersion = '',
  protocolVersion = '',
  error = '',
  stderr = '',
} = {}) {
  return {
    serverId: String(serverId || ''),
    label: String(label || ''),
    state: isMcpConnectionState(state) ? state : MCP_CONNECTION_STATES.IDLE,
    toolCount: Number.isFinite(toolCount) ? Math.max(0, Math.floor(toolCount)) : 0,
    serverName: text(serverName, MCP_LIMITS.LABEL_MAX_CHARS),
    serverVersion: text(serverVersion, MCP_LIMITS.LABEL_MAX_CHARS),
    protocolVersion: text(protocolVersion, MCP_LIMITS.LABEL_MAX_CHARS),
    error: text(error, MCP_LIMITS.DESCRIPTION_MAX_CHARS),
    stderr: typeof stderr === 'string' ? stderr : '',
  };
}

/**
 * Namensraum der MCP-Tools gegenueber dem Modell (Issue #107).
 *
 * `mcp__<serverId>__<toolName>` — damit kollidiert kein fremdes Tool mit einem
 * Workspace-Tool und keines zweier Server miteinander. Der doppelte
 * Unterstrich ist als Trenner reserviert: Serverkennungen duerfen ihn nicht
 * enthalten (siehe isValidMcpServerId), Tool-Namen schon — gelesen wird
 * deshalb am *ersten* Trenner hinter dem Praefix.
 */
const MCP_TOOL_NAME_PREFIX = 'mcp';
const MCP_TOOL_NAME_SEPARATOR = '__';

/**
 * Obergrenze fuer den zusammengesetzten Namen. Sie stammt nicht von hier,
 * sondern aus MAX_TOOL_NAME_CHARS in tool-permissions.js: Berechtigungsregeln
 * und Audit-Eintraege kappen den Tool-Namen auf 64 Zeichen. Ein laengerer Name
 * wuerde dort auf einen anderen zeigen als beim Aufruf — eine Deny-Regel
 * griffe dann ins Leere. Solche Tools werden lieber ausgelassen als
 * stillschweigend gekuerzt.
 */
const MCP_QUALIFIED_NAME_MAX_CHARS = 64;

function qualifiedMcpToolName(serverId, toolName) {
  return `${MCP_TOOL_NAME_PREFIX}${MCP_TOOL_NAME_SEPARATOR}${serverId}${MCP_TOOL_NAME_SEPARATOR}${toolName}`;
}

function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith(`${MCP_TOOL_NAME_PREFIX}${MCP_TOOL_NAME_SEPARATOR}`);
}

/** @returns {{ serverId: string, name: string } | null} */
function parseQualifiedMcpToolName(qualified) {
  if (!isMcpToolName(qualified)) return null;
  const rest = qualified.slice(MCP_TOOL_NAME_PREFIX.length + MCP_TOOL_NAME_SEPARATOR.length);
  const cut = rest.indexOf(MCP_TOOL_NAME_SEPARATOR);
  if (cut <= 0) return null;
  const serverId = rest.slice(0, cut);
  const name = rest.slice(cut + MCP_TOOL_NAME_SEPARATOR.length);
  if (!serverId || !name) return null;
  return { serverId, name };
}

/** Passt der zusammengesetzte Name in die Grenze der Berechtigungsregeln? */
function fitsMcpToolNameLimit(qualified) {
  return typeof qualified === 'string' && qualified.length <= MCP_QUALIFIED_NAME_MAX_CHARS;
}

/**
 * Mindest-Risikoklassen eines MCP-Tools (Entscheidung zu #107).
 *
 * Immer `execute` **und** `external`: ein MCP-Tool ist fremder Code mit
 * unbekannter Wirkung, und die Planung kann seine Zielpfade nicht kennen —
 * `targets` bleibt leer, es gibt also nichts, woran sich eine feinere
 * Einstufung festmachen liesse.
 *
 * Die Annotations des Servers duerfen nur **verschaerfen**, nie abschwaechen:
 * `destructiveHint` ergaenzt `delete`, `readOnlyHint` wird bewusst ignoriert.
 * Sonst entschiede der fremde Server darueber, wie streng wir ihn behandeln.
 */
const MCP_BASE_RISK_CLASSES = Object.freeze([TOOL_RISK_CLASSES.EXECUTE, TOOL_RISK_CLASSES.EXTERNAL]);

function mcpRiskClassesFor(annotations) {
  const classes = [...MCP_BASE_RISK_CLASSES];
  if (annotations && typeof annotations === 'object' && annotations.destructiveHint === true) {
    classes.push(TOOL_RISK_CLASSES.DELETE);
  }
  return classes;
}

module.exports = {
  MCP_CONTRACT_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_TRANSPORTS,
  MCP_TRANSPORT_LIST,
  MCP_CONNECTION_STATES,
  MCP_LIMITS,
  MCP_TIMEOUTS,
  isValidMcpServerId,
  isMcpTransport,
  isMcpConnectionState,
  validateMcpServerConfig,
  normalizeMcpServerConfig,
  normalizeMcpToolCatalogEntry,
  normalizeMcpToolCatalog,
  createMcpConnectionStatus,
  MCP_TOOL_NAME_PREFIX,
  MCP_TOOL_NAME_SEPARATOR,
  MCP_QUALIFIED_NAME_MAX_CHARS,
  MCP_BASE_RISK_CLASSES,
  qualifiedMcpToolName,
  parseQualifiedMcpToolName,
  isMcpToolName,
  fitsMcpToolNameLimit,
  mcpRiskClassesFor,
};
