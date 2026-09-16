'use strict';

/**
 * Import eines `mcpServers`-Blocks (Issue #110, fünfte Scheibe von #62).
 *
 * Wer MCP schon nutzt, hat seine Server längst in Claude Desktop, Claude Code
 * oder Cursor stehen. Das Format ist überall im Kern dasselbe, und diese
 * Blöcke abzutippen ist stumpfe, fehleranfällige Arbeit. Hier wird ein
 * eingefügter Block gelesen und auf unser eigenes Format abgebildet — mehr
 * nicht: Gelesen wird ausschließlich, was der Nutzer selbst einfügt, nie eine
 * fremde Konfigurationsdatei vom Dateisystem.
 *
 * Drei Haltungen prägen das Modul:
 *
 * - **Nachsichtig beim Lesen, streng beim Übernehmen.** Kommentare, angehängte
 *   Kommas und Markdown-Zäune werden geschluckt, weil genau daher kopiert
 *   wird. Was am Ende gespeichert wird, geht trotzdem durch
 *   `validateMcpServerInput` wie jede von Hand eingetragene Konfiguration.
 * - **Nichts wird stillschweigend verschluckt.** Jeder übersprungene Eintrag
 *   nennt seinen Grund, jede Anpassung an einer Kennung steht als Hinweis am
 *   Kandidaten. Ein stiller Teilerfolg wäre schlimmer als ein Fehlschlag.
 * - **Im Zweifel geheim.** Ein Wert, der nach Token aussieht, wird als Secret
 *   vorgemerkt. Die Fehlerrichtung ist bewusst schief: Ein harmloser Wert, der
 *   verschlüsselt landet, ist bloß später nicht mehr ablesbar — ein Token im
 *   Klartext ist ein Leck.
 */

const { MCP_LIMITS, MCP_TRANSPORTS, isValidMcpServerId } = require('./mcp');

/** Wie viele Einträge ein einzelner Block liefern darf. */
const MCP_IMPORT_MAX_SERVERS = 50;

/**
 * Schlüsselnamen, deren Wert als geheim gilt. Bewusst großzügig: `AUTH` fängt
 * auch `AUTHOR` ein, und das ist die richtige Richtung — ein zu viel
 * verschlüsselter Wert ist ärgerlich, ein zu wenig verschlüsselter ist ein
 * Leck.
 */
const SECRET_KEY_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|SESSION|COOKIE|AUTH|_PAT\b|\bPAT\b)/i;

/**
 * Präfixe bekannter Tokenformate — greifen auch dann, wenn der Schlüssel
 * unverdächtig heißt (`GH="ghp_…"`).
 */
const SECRET_VALUE_PREFIXES = Object.freeze([
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_',
  'sk-', 'sk_live_', 'sk_test_', 'rk_live_',
  'xoxb-', 'xoxp-', 'xoxa-', 'xoxs-',
  'glpat-', 'gldt-',
  'AIza', 'ya29.',
  'Bearer ',
  'hf_', 'pk_live_', 'AKIA',
]);

/** Platzhalter aus Dokumentationen, die niemand ausgefüllt hat. */
const PLACEHOLDER_PATTERN = /^(<.*>|\{\{.*\}\}|your[_-].*|dein[_-].*|xxx+|\.\.\.|todo)$/i;

/** Transport-Angaben, die es gibt, die wir aber (noch) nicht sprechen. */
const REMOTE_TRANSPORT_HINTS = Object.freeze(['http', 'https', 'sse', 'streamable-http', 'streamablehttp', 'ws', 'websocket']);

/**
 * Entfernt Kommentare aus einem JSON-Text — zeichenweise und mit Rücksicht
 * auf Zeichenketten. Ein naives `replace(/\/\/.*$/gm, '')` würde jede URL in
 * einem Wert zerstören (`"https://…"`), und genau solche Werte stehen in
 * MCP-Konfigurationen.
 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Entfernt Kommas vor `}` und `]`. Ebenfalls zeichenkettenbewusst — ein Komma
 * in einem Argument (`"--flag=a,b"`) darf nicht angefasst werden.
 */
function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') continue; // das Komma fällt weg
    }
    out += ch;
  }
  return out;
}

/** Markdown-Zäune abstreifen — es wird aus Dokumentationen kopiert. */
function stripCodeFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * Leitet aus dem Namen im Block eine gültige Kennung ab. Der Name darf alles
 * sein („Atlassian Jira"), die Kennung nicht: Sie taucht im Tool-Namensraum
 * auf (`mcp__<id>__<tool>`) und in der Konfiguration.
 */
function toServerId(name) {
  const lower = String(name || '').trim().toLowerCase();
  const mapped = lower
    .replace(/[^a-z0-9._-]+/g, '-')   // alles Fremde wird zum Bindestrich
    .replace(/_{2,}/g, '_')           // „__" trennt im Tool-Namen, darf nicht vorkommen
    .replace(/^[^a-z0-9]+/, '')       // muss alphanumerisch beginnen
    .slice(0, MCP_LIMITS.ID_MAX_CHARS)
    .replace(/[-._]+$/, '');
  return isValidMcpServerId(mapped) ? mapped : '';
}

/** Macht eine Kennung eindeutig, ohne die Länge zu sprengen. */
function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MCP_LIMITS.ID_MAX_CHARS - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return '';
}

/** Sieht dieser Wert nach einem Geheimnis aus? */
function looksSecret(key, value) {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  return SECRET_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * `env` eines Eintrags auf unsere Form bringen. Zahlen und Wahrheitswerte
 * werden zu Text statt verworfen — sie kommen in echten Konfigurationen vor
 * (`"PORT": 8080`) und sind für einen Kindprozess ohnehin nur Zeichen.
 */
function readEnv(raw, notes) {
  const entries = [];
  if (raw === undefined || raw === null) return entries;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    notes.push('„env" war kein Objekt und wurde übergangen.');
    return entries;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (entries.length >= MCP_LIMITS.MAX_ENV_ENTRIES) {
      notes.push(`Nur die ersten ${MCP_LIMITS.MAX_ENV_ENTRIES} Umgebungsvariablen wurden übernommen.`);
      break;
    }
    let text;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
    else {
      notes.push(`Der Wert von „${key}" war keine Zeichenkette und wurde übergangen.`);
      continue;
    }
    text = text.slice(0, MCP_LIMITS.ENV_VALUE_MAX_CHARS);
    const secret = looksSecret(key, text);
    if (!text) notes.push(`„${key}" hat keinen Wert — vor dem Einschalten nachtragen.`);
    else if (PLACEHOLDER_PATTERN.test(text)) notes.push(`„${key}" enthält noch einen Platzhalter.`);
    entries.push({ key, value: text, secret });
  }
  return entries;
}

/** Args einlesen; Nicht-Strings fallen weg, statt den Eintrag zu verwerfen. */
function readArgs(raw, notes) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    notes.push('„args" war keine Liste und wurde übergangen.');
    return [];
  }
  const out = [];
  for (const value of raw) {
    if (out.length >= MCP_LIMITS.MAX_ARGS) {
      notes.push(`Nur die ersten ${MCP_LIMITS.MAX_ARGS} Argumente wurden übernommen.`);
      break;
    }
    if (typeof value === 'string') out.push(value.slice(0, MCP_LIMITS.ARG_MAX_CHARS));
    else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
    else notes.push('Ein Argument war keine Zeichenkette und wurde übergangen.');
  }
  return out;
}

/** Erkennt Einträge, die einen Transport verlangen, den wir nicht sprechen. */
function remoteTransportReason(entry) {
  const declared = String(entry.type || entry.transport || '').trim().toLowerCase();
  if (declared && REMOTE_TRANSPORT_HINTS.includes(declared)) {
    return `Transport „${declared}" wird noch nicht unterstützt — nur über ein lokales Kommando gestartete Server (stdio).`;
  }
  if (typeof entry.url === 'string' && entry.url.trim()) {
    return 'Der Eintrag zeigt auf eine URL. Bisher werden nur lokal gestartete Server (stdio) unterstützt.';
  }
  return null;
}

/**
 * Liest einen eingefügten Block.
 *
 * Angenommen werden sowohl das vollständige Objekt (`{ "mcpServers": { … } }`)
 * als auch nur dessen Inhalt — beides wird kopiert, je nachdem, wo der Cursor
 * gerade stand.
 *
 * @param {string} raw Der eingefügte Text.
 * @param {{ existingIds?: string[] }} [options] Bereits vergebene Kennungen;
 *   sie erzeugen keinen Fehler, sondern den Hinweis, dass überschrieben würde.
 * @returns {{ ok: boolean, candidates: object[], skipped: Array<{name: string, reason: string}>, errors: string[] }}
 */
function parseMcpServersBlock(raw, { existingIds = [] } = {}) {
  const errors = [];
  const skipped = [];
  const candidates = [];

  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, candidates, skipped, errors: ['Es wurde nichts eingefügt.'] };
  }

  let parsed;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(stripCodeFence(raw))));
  } catch (error) {
    // Die Meldung von JSON.parse nennt die Position und ist damit brauchbarer
    // als ein eigener Text — sie wird nur eingeordnet, nicht ersetzt.
    return {
      ok: false,
      candidates,
      skipped,
      errors: [`Das ist kein gültiges JSON: ${error.message}`],
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, candidates, skipped, errors: ['Erwartet wird ein JSON-Objekt mit den Servern.'] };
  }

  // Beide Schreibweisen: mit umschließendem `mcpServers` und ohne.
  const block = parsed.mcpServers !== undefined ? parsed.mcpServers : parsed;
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return { ok: false, candidates, skipped, errors: ['„mcpServers" muss ein Objekt aus Server-Einträgen sein.'] };
  }

  const names = Object.keys(block);
  if (names.length === 0) {
    return { ok: false, candidates, skipped, errors: ['Der Block enthält keine Server.'] };
  }

  const existing = new Set(existingIds.filter((id) => typeof id === 'string'));
  const taken = new Set(existing);

  for (const name of names) {
    if (candidates.length + skipped.length >= MCP_IMPORT_MAX_SERVERS) {
      errors.push(`Es werden höchstens ${MCP_IMPORT_MAX_SERVERS} Server auf einmal gelesen.`);
      break;
    }
    const entry = block[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped.push({ name, reason: 'Der Eintrag ist kein Objekt.' });
      continue;
    }

    const remote = remoteTransportReason(entry);
    if (remote) {
      skipped.push({ name, reason: remote });
      continue;
    }

    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (!command) {
      skipped.push({ name, reason: 'Es fehlt das zu startende Kommando („command").' });
      continue;
    }

    const notes = [];
    const baseId = toServerId(name);
    if (!baseId) {
      skipped.push({ name, reason: 'Aus dem Namen lässt sich keine gültige Kennung bilden.' });
      continue;
    }

    // Eine schon vergebene Kennung ist kein Fehler: `saveMcpServer` ersetzt
    // den Eintrag, und manchmal ist genau das gewollt. Gesagt werden muss es
    // trotzdem — stilles Überschreiben wäre die schlechteste Variante.
    const conflict = existing.has(baseId);
    const id = conflict ? baseId : uniqueId(baseId, taken);
    if (!id) {
      skipped.push({ name, reason: 'Die Kennung ist bereits vergeben und ließ sich nicht eindeutig machen.' });
      continue;
    }
    if (id !== baseId) notes.push(`Die Kennung „${baseId}" war schon vergeben, daher „${id}".`);
    if (id !== name.trim().toLowerCase()) notes.push(`Kennung aus dem Namen abgeleitet: „${id}".`);
    taken.add(id);

    const args = readArgs(entry.args, notes);
    const env = readEnv(entry.env, notes);
    const cwd = typeof entry.cwd === 'string' && entry.cwd.trim()
      ? entry.cwd.trim().slice(0, MCP_LIMITS.COMMAND_MAX_CHARS)
      : null;

    candidates.push({
      sourceName: name,
      id,
      label: String(name).trim().slice(0, MCP_LIMITS.LABEL_MAX_CHARS) || id,
      command: command.slice(0, MCP_LIMITS.COMMAND_MAX_CHARS),
      args,
      env,
      cwd,
      conflict,
      notes,
    });
  }

  if (candidates.length === 0 && errors.length === 0 && skipped.length > 0) {
    errors.push('Kein Eintrag aus dem Block lässt sich übernehmen.');
  }

  return { ok: errors.length === 0 && candidates.length > 0, candidates, skipped, errors };
}

/**
 * Bildet einen Kandidaten auf die Eingabeform von `saveMcpServer` ab.
 *
 * Importierte Server sind **aus**: Der Import ist ein Abtipp-Ersatz, keine
 * Freigabe. Wer einen Server einschaltet, soll das bewusst tun — er startet
 * einen Prozess und bringt Tools ins Modell.
 */
function toMcpServerInput(candidate) {
  const env = {};
  for (const entry of candidate?.env || []) {
    env[entry.key] = { value: entry.value, secret: entry.secret !== false };
  }
  return {
    id: candidate?.id || '',
    label: candidate?.label || '',
    transport: MCP_TRANSPORTS.STDIO,
    command: candidate?.command || '',
    args: Array.isArray(candidate?.args) ? candidate.args : [],
    cwd: candidate?.cwd || '',
    enabled: false,
    disabledTools: [],
    env,
  };
}

module.exports = {
  MCP_IMPORT_MAX_SERVERS,
  parseMcpServersBlock,
  toMcpServerInput,
  // Für Tests und die Vorschau; kein Teil der öffentlichen Oberfläche.
  stripJsonComments,
  stripTrailingCommas,
  toServerId,
  looksSecret,
};
