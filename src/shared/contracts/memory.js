/**
 * Contracts für das Gedächtnis (Issue #166).
 *
 * Snotra merkt sich Dinge in einer `memory.md` je Ebene — im geöffneten Ordner
 * und im Benutzerverzeichnis. Beide Dateien stehen im Systemprompt und sind
 * damit dasselbe Muster wie die Projektanweisungen (#212/#253); die Ablage ist
 * bewusst eine **sichtbare Datei** und kein App-interner Speicher:
 *
 * - Sie zieht mit dem Ordner um. Ein Speicher, der den Pfad als Schlüssel
 *   nimmt, verwaist beim Umbenennen — genau das Problem, das der Chat-Verlauf
 *   heute schon hat.
 * - Sie ist im Editor lesbar. Ein Gedächtnis, das von selbst wächst, muss
 *   nachprüfbar sein, sonst ist es eine Blackbox.
 *
 * Der Preis: Die Projektdatei liegt im Ordner des Nutzers und kann in ein
 * Repository geraten. Das ist eine bewusste Entscheidung (2026-09-21) und
 * weicht von der früheren Festlegung in #166 ab.
 *
 * **Der Inhalt ist Anweisung, nicht Daten** — wie bei den Projektanweisungen,
 * und anders als bei Tool-Ergebnissen. Was hier steht, hat der Nutzer selbst
 * gesagt oder zumindest freigegeben.
 *
 * CommonJS, damit Main (require) und der Renderer (generiertes ESM-Bundle)
 * dieselben Werte sehen.
 */
'use strict';

/** Dateiname beider Ebenen — derselbe Name, zwei Orte. */
const MEMORY_FILE = 'memory.md';

/**
 * Die beiden Ebenen. Reihenfolge = Lesereihenfolge im Prompt: erst das
 * Speziellere (der Ordner), dann das Allgemeine. Sie ergänzen einander,
 * keine ersetzt die andere — wie bei den AGENTS.md-Dateien (#253).
 */
const MEMORY_SCOPES = Object.freeze({
  /** `<Ordner>/.agents/memory.md` — gilt für den geöffneten Ordner. */
  WORKSPACE: 'workspace',
  /** `~/.snotra/memory.md` — gilt überall. */
  USER: 'user',
});

const MEMORY_SCOPE_ORDER = Object.freeze([MEMORY_SCOPES.WORKSPACE, MEMORY_SCOPES.USER]);

/**
 * Heading of the section in the context breakdown, as a catalogue key — the
 * text is chosen where it is shown, not where it is produced (issue #293).
 */
const MEMORY_SCOPE_LABEL_KEYS = Object.freeze({
  [MEMORY_SCOPES.WORKSPACE]: 'memory.scope.workspace',
  [MEMORY_SCOPES.USER]: 'memory.scope.user',
});

/**
 * Dieselben Ebenen als Zwischenueberschrift **im System-Prompt** — englisch,
 * weil sie dort beim Modell landen (Issue #276). Bis dahin trug eine Tabelle
 * beide Leser; das war der Grund, warum die Prompt-Sprache nicht zu aendern
 * war, ohne die Einstellungen mitzuziehen.
 */
const MEMORY_SCOPE_PROMPT_LABELS = Object.freeze({
  [MEMORY_SCOPES.WORKSPACE]: 'Memory (project)',
  [MEMORY_SCOPES.USER]: 'Memory (global)',
});

/** Pfad zur Anzeige — nie zum Auflösen; die echten Pfade baut der Adapter. */
const MEMORY_SCOPE_PATHS = Object.freeze({
  [MEMORY_SCOPES.WORKSPACE]: '<Ordner>/.agents/memory.md',
  [MEMORY_SCOPES.USER]: '~/.snotra/memory.md',
});

/**
 * Kurzform für die Oberfläche. Der absolute Pfad wandert in den Tooltip: In
 * der Karte steht er sonst zweimal so breit wie alles andere und sagt weniger
 * als der Ordnername daneben.
 */
const MEMORY_SCOPE_SHORT_PATHS = Object.freeze({
  [MEMORY_SCOPES.WORKSPACE]: '.agents/memory.md',
  [MEMORY_SCOPES.USER]: '~/.snotra/memory.md',
});

/**
 * Obergrenze je Datei. Großzügiger als ein einzelner Skill-Body (20.000), aber
 * eng genug, dass ein vollgelaufenes Gedächtnis den Prompt nicht auffrisst:
 * Beide Ebenen zusammen kosten im schlechtesten Fall rund 4.000 Token, und das
 * bei **jeder** Nachricht. Wer mehr braucht, schreibt einen Skill.
 */
const MAX_MEMORY_CHARS = 8000;

/** Obergrenze für einen einzelnen Eintrag — ein Merksatz, kein Aufsatz. */
const MAX_MEMORY_ENTRY_CHARS = 500;

/** Wer den Eintrag veranlasst hat. Steht in der Datei und in der Anzeige. */
const MEMORY_ORIGINS = Object.freeze({
  /** Der Nutzer hat ausdrücklich darum gebeten („bitte merke dir …“). */
  REQUESTED: 'requested',
  /** Snotra hielt es von sich aus für merkenswert. */
  SELF: 'self',
});

/** Klammerzusatz hinter dem Datum für selbst gemerkte Einträge. */
const SELF_ORIGIN_MARKER = 'selbst gemerkt';

/** Kopfzeile einer frisch angelegten Datei. */
function memoryFileHeading(scope) {
  return scope === MEMORY_SCOPES.USER ? '# Gedächtnis · global' : '# Gedächtnis · Projekt';
}

function isMemoryScope(value) {
  return value === MEMORY_SCOPES.WORKSPACE || value === MEMORY_SCOPES.USER;
}

/**
 * Eine Eintragszeile: `- 2026-09-21 — Text` bzw. mit Herkunft
 * `- 2026-09-21 (selbst gemerkt) — Text`.
 *
 * Der Gedankenstrich trennt, die Klammer ist optional. Absichtlich ein Format,
 * das man von Hand tippen kann, ohne eine Regel nachzuschlagen.
 */
const ENTRY_LINE = /^[-*]\s+(?:(\d{4}-\d{2}-\d{2})\s*(?:\(([^)]*)\)\s*)?[—–-]\s+)?(.+?)\s*$/;

/** Datum als `YYYY-MM-DD` — ohne Zeitzone, weil der Tag genügt. */
function formatMemoryDate(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Ein Eintrag als Markdown-Zeile. */
function formatMemoryEntryLine({ text, date, origin }) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const marker = origin === MEMORY_ORIGINS.SELF ? ` (${SELF_ORIGIN_MARKER})` : '';
  return `- ${date || formatMemoryDate()}${marker} — ${body}`;
}

/**
 * Die Einträge einer Datei, in Dateireihenfolge.
 *
 * Gelesen werden **nur Listenzeilen**. Alles andere — Überschrift, Prosa,
 * eine Tabelle — bleibt unangetastet und wandert trotzdem in den Prompt: Der
 * Prompt bekommt den ganzen Text, die Einträge dienen der Anzeige und dem
 * gezielten Vergessen. Wer von Hand schreibt, kann damit nichts kaputt machen,
 * er verliert höchstens die Einzellöschung für seine Zeile.
 */
function parseMemoryEntries(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = ENTRY_LINE.exec(lines[index]);
    if (!match) continue;
    const [, date, marker, body] = match;
    const value = body.trim();
    if (!value) continue;
    entries.push({
      /** Zeilennummer (0-basiert) — der Schlüssel zum Löschen. */
      line: index,
      date: date || null,
      origin:
        marker && marker.trim().toLowerCase() === SELF_ORIGIN_MARKER
          ? MEMORY_ORIGINS.SELF
          : MEMORY_ORIGINS.REQUESTED,
      text: value,
    });
  }
  return entries;
}

/**
 * Einen Eintrag anhängen und den neuen Dateitext liefern.
 *
 * Neue Einträge kommen **ans Ende**, nicht an den Anfang: So bleibt eine von
 * Hand gepflegte Datei in der Reihenfolge, die ihr Autor gewählt hat, und der
 * Anhang ist ein reines Anfügen ohne Umbau.
 */
function appendMemoryEntry(currentText, entry) {
  const line = formatMemoryEntryLine(entry);
  if (!line) return typeof currentText === 'string' ? currentText : '';
  const base = typeof currentText === 'string' ? currentText.replace(/\s+$/, '') : '';
  if (!base) {
    return `${memoryFileHeading(entry?.scope)}\n\n${line}\n`;
  }
  return `${base}\n${line}\n`;
}

/**
 * Die Zeile mit der Nummer `line` entfernen. Trifft die Nummer keine
 * Eintragszeile, bleibt der Text unverändert — ein Vergessen, das die falsche
 * Zeile trifft, wäre schlimmer als eines, das nichts tut.
 */
function removeMemoryEntryLine(currentText, line) {
  if (typeof currentText !== 'string' || !Number.isInteger(line) || line < 0) {
    return { text: typeof currentText === 'string' ? currentText : '', removed: false };
  }
  const lines = currentText.split(/\r?\n/);
  if (line >= lines.length || !ENTRY_LINE.test(lines[line])) {
    return { text: currentText, removed: false };
  }
  lines.splice(line, 1);
  return { text: lines.join('\n'), removed: true };
}

/** Nur Dateien mit Inhalt; alles andere ist kein Fehler, sondern leer. */
function normalizeMemoryFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.filter(
    (file) => file && isMemoryScope(file.scope) && typeof file.text === 'string' && file.text.trim()
  );
}

module.exports = {
  MEMORY_FILE,
  MEMORY_SCOPES,
  MEMORY_SCOPE_ORDER,
  MEMORY_SCOPE_LABEL_KEYS,
  MEMORY_SCOPE_PROMPT_LABELS,
  MEMORY_SCOPE_PATHS,
  MEMORY_SCOPE_SHORT_PATHS,
  MEMORY_ORIGINS,
  SELF_ORIGIN_MARKER,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_ENTRY_CHARS,
  isMemoryScope,
  memoryFileHeading,
  formatMemoryDate,
  formatMemoryEntryLine,
  parseMemoryEntries,
  appendMemoryEntry,
  removeMemoryEntryLine,
  normalizeMemoryFiles,
};
