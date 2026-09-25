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
const { createMessage, isMessage } = require('./message');

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
    errors.push(createMessage('mcp.error.argsNotList'));
    return [];
  }
  const out = [];
  for (const value of raw) {
    if (out.length >= MCP_LIMITS.MAX_ARGS) {
      errors.push(createMessage('mcp.error.tooManyArgs', { max: MCP_LIMITS.MAX_ARGS }));
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
    errors.push(createMessage('mcp.error.envNotObject'));
    return {};
  }
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MCP_LIMITS.MAX_ENV_ENTRIES) {
      errors.push(createMessage('mcp.error.tooManyEnv', { max: MCP_LIMITS.MAX_ENV_ENTRIES }));
      break;
    }
    if (key.length > MCP_LIMITS.ENV_KEY_MAX_CHARS || !ENV_KEY_PATTERN.test(key)) {
      errors.push(createMessage('mcp.error.envNameInvalid', { name: key.slice(0, 40) }));
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(createMessage('mcp.error.envValueNotString', { name: key }));
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
 * Zuletzt vom Server gemeldete Tool-Namen. Sie werden mitgespeichert, damit
 * die Oberflaeche die Auswahl auch dann anzeigen kann, wenn der Server
 * gerade nicht laeuft — bei einem Docker-MCP ist das der Normalfall. Die
 * Reihenfolge bleibt die des Servers.
 */
function normalizeKnownTools(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const name = value.trim().slice(0, MCP_LIMITS.TOOL_NAME_MAX_CHARS);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MCP_LIMITS.MAX_TOOLS) break;
  }
  return out;
}

/**
 * Prüft eine Serverkonfiguration und liefert sie in Normalform.
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value: McpServerConfig|null, errors: Array<{key: string, params?: object}> }}
 */
function validateMcpServerConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, value: null, errors: [createMessage('mcp.error.configNotObject')] };
  }

  // Die Kennung wird nicht gekappt, sondern geprueft: auf sie zeigen spaeter
  // Konfiguration (#108) und Tool-Namensraum (#107), und ein stillschweigend
  // gekuerzter Bezeichner zeigt auf etwas anderes als der eingegebene.
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!id) {
    errors.push(createMessage('mcp.error.idMissing'));
  } else if (id.length > MCP_LIMITS.ID_MAX_CHARS) {
    errors.push(createMessage('mcp.error.idTooLong', { max: MCP_LIMITS.ID_MAX_CHARS }));
  } else if (SERVER_ID_FORBIDDEN.test(id)) {
    errors.push(createMessage('mcp.error.idDoubleUnderscore'));
  } else if (!isValidMcpServerId(id)) {
    errors.push(createMessage('mcp.error.idCharset'));
  }

  const transport = raw.transport === undefined || raw.transport === null
    ? MCP_TRANSPORTS.STDIO
    : raw.transport;
  if (!isMcpTransport(transport)) {
    errors.push(createMessage('mcp.error.transportUnsupported'));
  }

  const command = text(raw.command, MCP_LIMITS.COMMAND_MAX_CHARS);
  if (!command) errors.push(createMessage('mcp.error.commandMissing'));

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
    knownTools: normalizeKnownTools(raw.knownTools),
  };

  return { ok: errors.length === 0, value: errors.length === 0 ? value : null, errors };
}

/** Wie validateMcpServerConfig, aber nur der Wert — null, wenn ungültig. */
function normalizeMcpServerConfig(raw) {
  return validateMcpServerConfig(raw).value;
}

/**
 * Stellen in einem JSON Schema, an denen wieder ein Schema steht. Nur dort
 * wird weitergelaufen — alles andere (`enum`, `default`, `examples`, `const`)
 * sind Daten, in denen nichts zu suchen ist.
 *
 * Aufgeteilt nach Form des Werts: ein einzelnes Schema, eine Liste von
 * Schemas, oder eine Sammlung Name → Schema. Der Unterschied ist der Kern
 * dieser Funktion: Bei einer Sammlung ist der Schlüssel ein *Name*, kein
 * Schlüsselwort — `properties.title` ist ein Parameter namens „title" und
 * muss bleiben.
 */
const SCHEMA_KEYWORDS_VALUE = Object.freeze([
  'items', 'additionalItems', 'unevaluatedItems',
  'additionalProperties', 'unevaluatedProperties', 'propertyNames',
  'contains', 'not', 'if', 'then', 'else',
]);
const SCHEMA_KEYWORDS_LIST = Object.freeze(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_KEYWORDS_MAP = Object.freeze([
  'properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions',
]);

/**
 * Notbremse gegen ein absurd verschachteltes Schema. JSON vom Server kann
 * keine Zyklen enthalten, aber tief genug für einen Stacküberlauf schon —
 * ab hier bleibt der Rest, wie er ist.
 */
const SCHEMA_MAX_DEPTH = 32;

/**
 * Entfernt die `title`-Annotationen aus einem JSON Schema (Issue #185).
 *
 * Pydantic — und damit die Mehrzahl der MCP-Server — hängt an jede Eigenschaft
 * ein `title`, das nur den Feldnamen in Titelschreibweise wiederholt
 * (`session_id` → `"title": "Session Id"`). Für das Modell steht darin nichts,
 * was nicht schon im Namen steht; bezahlt wird es in jeder Runde. `title` ist
 * laut JSON Schema eine Beschriftung für Menschen; was das Modell wissen muss,
 * gehört in `description` — und die bleibt unangetastet.
 *
 * Entscheidend ist, **schemabewusst** zu laufen statt rekursiv über alle
 * Objekte: Es gibt Tools mit einem Parameter, der tatsächlich `title` heißt
 * (bei Atlassian vier, darunter `confluence_get_page`). Ein naiver Walk löscht
 * diesen Parameter und bricht das Tool. Entfernt wird deshalb nur ein `title`
 * als Schlüsselwort *innerhalb* eines Schemas, nie ein Eintrag namens `title`
 * in `properties` & Co. Das Schema eines solchen Parameters wird dabei
 * betreten wie jedes andere — nur eben unter seinem Namen.
 *
 * Arbeitet auf einer Kopie: das Eingabeobjekt gehört dem Aufrufer.
 */
function stripSchemaTitles(node, depth = 0) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  if (depth >= SCHEMA_MAX_DEPTH) return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'title') continue;
    if (SCHEMA_KEYWORDS_VALUE.includes(key)) {
      // `items` darf im älteren Entwurf auch eine Liste sein (Tupel-Form).
      out[key] = Array.isArray(value)
        ? value.map((item) => stripSchemaTitles(item, depth + 1))
        : stripSchemaTitles(value, depth + 1);
    } else if (SCHEMA_KEYWORDS_LIST.includes(key) && Array.isArray(value)) {
      out[key] = value.map((item) => stripSchemaTitles(item, depth + 1));
    } else if (SCHEMA_KEYWORDS_MAP.includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const map = {};
      for (const [name, sub] of Object.entries(value)) map[name] = stripSchemaTitles(sub, depth + 1);
      out[key] = map;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Ein Eintrag aus `tools/list`. Das `inputSchema` wird bewusst nicht geprüft —
 * es ist JSON Schema für das Modell, nicht für uns; ein Server, der hier
 * Unsinn liefert, scheitert beim Aufruf, nicht schon beim Auflisten. Fehlt es
 * ganz, setzen wir das leere Objektschema, damit die Anbindung in #107 sich
 * auf ein Feld verlassen kann.
 *
 * Angefasst wird genau eines: die `title`-Annotationen fallen weg, weil sie
 * bei Pydantic-Servern nur den Feldnamen wiederholen und in jeder Runde
 * mitbezahlt werden (Issue #185, siehe stripSchemaTitles).
 */
function normalizeMcpToolCatalogEntry(raw, serverId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = text(raw.name, MCP_LIMITS.TOOL_NAME_MAX_CHARS);
  if (!name) return null;
  const schema = raw.inputSchema && typeof raw.inputSchema === 'object' && !Array.isArray(raw.inputSchema)
    ? stripSchemaTitles(raw.inputSchema)
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
  // Namen der gemeldeten Tools. Nur bei einer stehenden Verbindung gefuellt —
  // der Settings-Dialog (#109) braucht sie, um einzelne Tools abwaehlbar zu
  // machen, und sie liegen ohnehin schon im Speicher. Ein nie verbundener
  // Server hat hier nichts; dort hilft „Verbindung testen".
  toolNames = [],
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
    toolNames: Array.isArray(toolNames) ? toolNames.filter((name) => typeof name === 'string') : [],
    serverName: text(serverName, MCP_LIMITS.LABEL_MAX_CHARS),
    serverVersion: text(serverVersion, MCP_LIMITS.LABEL_MAX_CHARS),
    protocolVersion: text(protocolVersion, MCP_LIMITS.LABEL_MAX_CHARS),
    // A catalogue message for our own sentences (#338), plain text when a
    // server's own error is quoted.
    error: isMessage(error) ? createMessage(error.key, error.params) : text(error, MCP_LIMITS.DESCRIPTION_MAX_CHARS),
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

/**
 * Drei Formen der Umgebungsvariablen — bewusst auseinandergehalten, weil sie
 * verschiedene Leser haben (Issue #108):
 *
 *  1. **Laufzeit** (`McpServerConfig.env`): flaches `{ KEY: "wert" }`. Nur der
 *     Transport sieht das, und nur, um es dem Kindprozess mitzugeben.
 *  2. **Gespeichert**: je Schluessel `{ enc }` (ueber safeStorage) oder
 *     `{ value }` (Klartext). Selbstbeschreibend, damit man einer Datei
 *     ansieht, was in ihr verschluesselt ist und was nicht.
 *  3. **Angezeigt**: je Schluessel `{ key, secret, hasValue }` — bei einem
 *     Secret **nie** der Wert. Nur die abgewaehlten Klartextwerte gehen
 *     zurueck an die Oberflaeche.
 *
 * Vorgabe ist verschluesselt; Klartext ist die bewusste Ausnahme je Schluessel
 * (Entscheidung zu #108). Wer das Haekchen nicht anfasst, hat sein Token
 * geschuetzt — Vergessen darf nicht der teure Fall sein.
 */

/** Eingabeform beim Speichern: was die Oberflaeche (#109) schickt. */
function normalizeMcpEnvInput(raw) {
  const errors = [];
  if (raw === undefined || raw === null) return { entries: [], errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries: [], errors: [createMessage('mcp.error.envNotObject')] };
  }
  const entries = [];
  for (const [key, spec] of Object.entries(raw)) {
    if (entries.length >= MCP_LIMITS.MAX_ENV_ENTRIES) {
      errors.push(createMessage('mcp.error.tooManyEnv', { max: MCP_LIMITS.MAX_ENV_ENTRIES }));
      break;
    }
    if (key.length > MCP_LIMITS.ENV_KEY_MAX_CHARS || !ENV_KEY_PATTERN.test(key)) {
      errors.push(createMessage('mcp.error.envNameInvalid', { name: key.slice(0, 40) }));
      continue;
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push(createMessage('mcp.error.envNeedsSecretFlag', { name: key }));
      continue;
    }
    // Vorgabe geheim: nur ein ausdrueckliches `secret: false` macht Klartext.
    const secret = spec.secret !== false;
    const keep = spec.keep === true;
    if (keep) {
      entries.push({ key, secret, value: null, keep: true });
      continue;
    }
    if (typeof spec.value !== 'string') {
      errors.push(createMessage('mcp.error.envValueNotString', { name: key }));
      continue;
    }
    entries.push({ key, secret, value: spec.value.slice(0, MCP_LIMITS.ENV_VALUE_MAX_CHARS), keep: false });
  }
  return { entries, errors };
}

/** Gespeicherte Form pruefen — kaputte Eintraege fallen weg statt zu werfen. */
function normalizeStoredMcpEnv(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, entry] of Object.entries(raw)) {
    if (!ENV_KEY_PATTERN.test(key) || !entry || typeof entry !== 'object') continue;
    if (typeof entry.enc === 'string' && entry.enc) out[key] = { enc: entry.enc };
    else if (typeof entry.value === 'string') out[key] = { value: entry.value };
  }
  return out;
}

/**
 * Anzeigeform. Der verschluesselte Wert wird nicht etwa entschluesselt und
 * dann maskiert — er wird hier gar nicht erst angefasst.
 */
function maskStoredMcpEnv(stored) {
  const normalized = normalizeStoredMcpEnv(stored);
  return Object.keys(normalized)
    .sort()
    .map((key) => {
      const entry = normalized[key];
      const secret = typeof entry.enc === 'string';
      return secret
        ? { key, secret: true, hasValue: true }
        : { key, secret: false, hasValue: entry.value.length > 0, value: entry.value };
    });
}

/**
 * Eingabe eines ganzen Servers beim Speichern. Die Felder ausser `env` sind
 * dieselben wie zur Laufzeit, deshalb prueft sie derselbe Validator.
 */
function validateMcpServerInput(raw) {
  const base = validateMcpServerConfig({ ...(raw && typeof raw === 'object' ? raw : {}), env: {} });
  const { entries, errors: envErrors } = normalizeMcpEnvInput(raw?.env);
  const errors = [...base.errors, ...envErrors];
  if (errors.length > 0) return { ok: false, value: null, env: [], errors };
  return { ok: true, value: base.value, env: entries, errors: [] };
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
  stripSchemaTitles,
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
  normalizeKnownTools,
  normalizeMcpEnvInput,
  normalizeStoredMcpEnv,
  maskStoredMcpEnv,
  validateMcpServerInput,
};
