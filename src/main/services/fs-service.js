const { SKILL_PATH_PREFIX, parseSkillPath } = require('../../shared/runtime/skill-path');
const {
  SEARCH_MAX_PATTERN_CHARS,
  SEARCH_MAX_MATCH_LINE_CHARS,
  collectLineMatches,
  validateRegexPattern,
} = require('./search-line-matcher');
const {
  REGEX_SEARCH_DEFAULT_TIME_BUDGET_MS,
  RegexSearchTimeoutError,
  createRegexSearchWorker,
} = require('./regex-search-worker');

const READ_LINES_DEFAULT_COUNT = 200;
const READ_LINES_MAX_COUNT = 1000;
const READ_SLICE_DEFAULT_MAX_CHARS = 32000;
const READ_BYTES_DEFAULT_LENGTH = 16000;

const SEARCH_DEFAULT_CONTEXT_LINES = 2;
const SEARCH_MAX_CONTEXT_LINES = 10;
const SEARCH_DEFAULT_MAX_RESULTS = 50;
const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_LINE_CHARS = 400;
const SEARCH_BINARY_PROBE_BYTES = 8192;
const SEARCH_DEFAULT_MAX_SCANNED_FILES = 5000;

const FIND_DEFAULT_MAX_RESULTS = 100;
const FIND_MAX_RESULTS = 500;
// @-Vervollständigung im Chat: Obergrenze der flachen Pfadliste pro Workspace.
const MENTION_MAX_ENTRIES = 5000;
const OUTLINE_DEFAULT_MAX_ENTRIES = 200;
const OUTLINE_MAX_ENTRIES = 1000;
const OUTLINE_MAX_TEXT_CHARS = 200;
const OUTLINE_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.mdc']);
const OUTLINE_JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);

const PATCH_MAX_EDITS = 50;
const PATCH_MAX_FILES = 20;
const PATCH_MAX_HUNKS = 200;
const PATCH_MAX_MESSAGE_LINE_CHARS = 120;
/** Zeilen eines unified diff, die vor dem Dateikopf stehen dürfen und übersprungen werden. */
const PATCH_PRELUDE_PREFIXES = [
  'diff ',
  'index ',
  'new file mode',
  'deleted file mode',
  'old mode ',
  'new mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
];

const TREE_DEFAULT_MAX_DEPTH = 3;
const TREE_MAX_DEPTH = 10;
const TREE_DEFAULT_MAX_ENTRIES = 200;
const TREE_MAX_ENTRIES = 1000;


function escapeRegExpLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Übersetzt ein Glob-Muster in gitignore-Syntax (`*`, `?`, `**`, führendes `/`
 * verankert, abschließendes `/` = nur Ordner) in eine RegExp über den
 * posix-relativen Pfad. Muster ohne `/` matchen auf jeder Ebene.
 */
function globToRegExp(pattern) {
  let p = pattern;
  let dirOnly = false;
  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  } else if (p.includes('/')) {
    anchored = true;
  }
  let source = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          source += '(?:[^/]+/)*';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      source += '[^/]';
      i += 1;
    } else {
      source += escapeRegExpLiteral(c);
      i += 1;
    }
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return { regex: new RegExp(`${prefix}${source}$`), dirOnly };
}

/**
 * Baut aus einem .gitignore-Text einen Matcher (relPath, isDirectory) → ignoriert?
 * Unterstützte Teilmenge: Kommentare, Negation (!), Ordner-Muster (…/),
 * verankerte Muster sowie *, ?, **. Die letzte passende Regel gewinnt.
 */
function createGitignoreMatcher(text) {
  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let body = line;
    let negated = false;
    if (body.startsWith('!')) {
      negated = true;
      body = body.slice(1);
    }
    if (!body) continue;
    const { regex, dirOnly } = globToRegExp(body);
    rules.push({ regex, dirOnly, negated });
  }
  if (!rules.length) return null;
  return (relPath, isDirectory) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(relPath)) ignored = !rule.negated;
    }
    return ignored;
  };
}

function readIntegerArg(args, name) {
  const value = args[name];
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `${name} muss eine Ganzzahl sein.` };
  }
  return { value: Math.floor(value) };
}

/** Teilt Text in Zeilen; eine einzelne Leerzeile durch abschließenden Umbruch zählt nicht mit. */
function splitFileLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function buildLineSliceResult(rel, text, startLineArg, endLineArg, maxChars) {
  const startLine = startLineArg === undefined ? 1 : startLineArg;
  if (startLine < 1) return { error: 'start_line muss mindestens 1 sein.' };
  const endLine = endLineArg === undefined ? startLine + READ_LINES_DEFAULT_COUNT - 1 : endLineArg;
  if (endLine < startLine) return { error: 'end_line darf nicht kleiner als start_line sein.' };

  const lines = splitFileLines(text);
  const totalLines = lines.length;
  if (totalLines === 0 && startLine === 1) {
    return { relative_path: rel, total_lines: 0, start_line: 1, end_line: 0, truncated: false, content: '' };
  }
  if (startLine > totalLines) {
    return {
      error: `start_line (${startLine}) liegt hinter dem Dateiende — die Datei hat ${totalLines} Zeilen.`,
    };
  }

  const wantedEnd = Math.min(endLine, totalLines);
  const spanEnd = Math.min(wantedEnd, startLine + READ_LINES_MAX_COUNT - 1);
  const numbered = [];
  let chars = 0;
  let lastLine = startLine - 1;
  let clipped = false;
  for (let n = startLine; n <= spanEnd; n++) {
    const lineText = `${n}\t${lines[n - 1]}`;
    if (numbered.length && chars + lineText.length + 1 > maxChars) {
      clipped = true;
      break;
    }
    if (lineText.length > maxChars) {
      // Erste Zeile sprengt allein das Budget — hart kappen statt leer zurückgeben.
      numbered.push(`${lineText.slice(0, maxChars)}…`);
      lastLine = n;
      clipped = true;
      break;
    }
    numbered.push(lineText);
    chars += lineText.length + 1;
    lastLine = n;
  }

  return {
    relative_path: rel,
    total_lines: totalLines,
    start_line: startLine,
    end_line: lastLine,
    truncated: clipped || lastLine < wantedEnd,
    content: numbered.join('\n'),
  };
}

function buildByteSliceResult(rel, buf, startByteArg, lengthArg, maxChars) {
  const startByte = startByteArg === undefined ? 0 : startByteArg;
  if (startByte < 0) return { error: 'start_byte darf nicht negativ sein.' };
  const requested = lengthArg === undefined ? READ_BYTES_DEFAULT_LENGTH : lengthArg;
  if (requested < 1) return { error: 'length muss mindestens 1 sein.' };
  if (startByte >= buf.length && !(startByte === 0 && buf.length === 0)) {
    return {
      error: `start_byte (${startByte}) liegt hinter dem Dateiende — die Datei hat ${buf.length} Bytes.`,
    };
  }

  const end = Math.min(startByte + Math.min(requested, maxChars), buf.length);
  let firstLine = 1;
  for (let i = 0; i < startByte; i++) {
    if (buf[i] === 0x0a || (buf[i] === 0x0d && buf[i + 1] !== 0x0a)) firstLine += 1;
  }

  return {
    relative_path: rel,
    size_bytes: buf.length,
    start_byte: startByte,
    length: end - startByte,
    first_line: firstLine,
    truncated: end < Math.min(startByte + requested, buf.length),
    content: buf.subarray(startByte, end).toString('utf8'),
  };
}

function isBinaryBuffer(buf) {
  return buf.subarray(0, SEARCH_BINARY_PROBE_BYTES).includes(0);
}

function clipOutlineText(text) {
  const t = text.trim();
  return t.length <= OUTLINE_MAX_TEXT_CHARS ? t : `${t.slice(0, OUTLINE_MAX_TEXT_CHARS)}…`;
}

/** Markdown-Gliederung: ATX- (#) und Setext-Überschriften (===/---), ohne Code-Fences und Front-Matter. */
function extractMarkdownOutline(lines) {
  const entries = [];
  let i = 0;
  if (lines.length && /^---\s*$/.test(lines[0])) {
    const end = lines.findIndex((line, idx) => idx > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end > 0) i = end + 1;
  }
  let fenceClose = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fenceClose) {
      if (fenceClose.test(line)) fenceClose = null;
      continue;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      fenceClose = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (atx) {
      const text = (atx[2] || '').replace(/[ \t]+#+$/, '').trim();
      if (text) {
        entries.push({ line: i + 1, level: atx[1].length, kind: 'heading', text: clipOutlineText(text) });
      }
      continue;
    }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (!setext || i === 0) continue;
    const prev = lines[i - 1];
    const prevText = prev.trim();
    const prevIsHeading = entries.length > 0 && entries[entries.length - 1].line === i;
    // Kein Setext-Titel nach Leerzeile (Trennlinie), Listen-/Zitat-/Tabellenzeilen oder eingerücktem Code.
    if (
      !prevText ||
      prevIsHeading ||
      /^(?: {4,}|\t)/.test(prev) ||
      /^(?:[-*+>|#]|=+$|\d+[.)]\s)/.test(prevText)
    ) {
      continue;
    }
    entries.push({
      line: i,
      level: setext[1][0] === '=' ? 1 : 2,
      kind: 'heading',
      text: clipOutlineText(prevText),
    });
  }
  return entries;
}

/** Zeilenanfänge, die trotz Klammer-Optik keine Signaturen sind (Kontrollfluss, Aufrufe, Importe). */
const CODE_NON_SIGNATURE_START =
  /^(?:if|else|elif|for|foreach|while|do|switch|case|catch|try|finally|return|new|throw|await|yield|typeof|delete|with|goto|sizeof|import|from|using|package|require|match|when|unless|until|begin|end|loop|print|echo|assert|super|this|self|go|defer)\b/;

/** Schlüsselwörter, die als "Name" gefangen wurden, sind keine Signatur (z. B. "go func() {"). */
const CODE_RESERVED_NAMES = /^(?:function|func|fun|fn|def|lambda|class|struct|enum|interface|type|return|if|else|while|for|switch|catch|do|try)$/;

/** Generische Signatur-Heuristiken; Reihenfolge = Priorität. kind 'keyword' nimmt das Schlüsselwort aus Gruppe 1. */
const CODE_SIGNATURE_PATTERNS = [
  // JS/TS/PHP: function foo(  ·  export default async function* foo(
  {
    kind: 'function',
    re: /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/,
  },
  // Python/Ruby: def foo(  ·  async def foo(  ·  def self.foo
  { kind: 'function', re: /^(?:async\s+)?def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/ },
  // Klassenartige Deklarationen; kind = Schlüsselwort (class, interface, enum, struct, …)
  {
    kind: 'keyword',
    re: /^(?:export\s+(?:default\s+)?)?(?:(?:public|private|protected|internal|abstract|static|final|sealed|data|open|partial|declare|pub(?:\([^)]*\))?)\s+)*(class|interface|enum|struct|trait|record|protocol|module|namespace|object|union|extension|mod)\s+([A-Za-z_$][\w$.]*)/,
  },
  // Rust: impl<T> Foo for Bar
  { kind: 'impl', re: /^(?:unsafe\s+)?impl\b/ },
  // Go/TS/Rust: type Foo struct  ·  export type Props = …
  { kind: 'type', re: /^(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  // Go/Kotlin/Swift: func (s *Server) Start(  ·  override fun onCreate(  ·  func viewDidLoad(
  {
    kind: 'function',
    re: /^(?:(?:public|private|protected|internal|fileprivate|open|override|static|class|suspend|inline|operator|infix|mutating|final|tailrec|external)\s+)*(?:fun|func)\s+(?:\([^)]*\)\s*)?(?:<[^>]*>\s*)?(?:[A-Za-z_][\w.<>?]*\.)?([A-Za-z_]\w*)\s*[(<]/,
  },
  // Rust: pub async fn foo(
  {
    kind: 'function',
    re: /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/,
  },
  // JS/TS: const foo = (a, b) =>  ·  export const bar = async function
  {
    kind: 'function',
    re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+?)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  },
  // Java/C#/PHP/C mit Modifier: public static void main(  ·  public function foo(  ·  static int helper(
  {
    kind: 'function',
    re: /^(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|native|default|unsafe|extern|inline|constexpr|open|suspend|fileprivate|mutating|convenience|required|readonly)\s+)+(?:[A-Za-z_][\w<>\[\],.?:]*\s+)?([A-Za-z_]\w*)\s*\(/,
  },
  // C/C++/Java ohne Modifier, Block in derselben Zeile: int main(void) {  ·  char *name(int a) {
  {
    kind: 'function',
    re: /^(?:[A-Za-z_][\w<>\[\],.:*&?]*\s+)+\*?((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*\([^()]*\)\s*(?:const\s*)?(?:throws\s+[\w.,\s]+)?\{$/,
  },
  // Shell/JS/C: foo() {
  { kind: 'function', re: /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{$/ },
];

/** Nur JS/TS: Methoden-Kurzform in Klassen sowie Objekt-Eigenschaften mit Funktionswert. */
const JS_SIGNATURE_PATTERNS = [
  // constructor(props) {  ·  static async load(id) {  ·  get value(): number {  ·  #secret() {
  {
    kind: 'function',
    re: /^(?:(?:static|async|get|set|public|private|protected|readonly|override|abstract)\s+)*\*?(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^()]*\)\s*(?::\s*[^{]+)?\{$/,
  },
  // onClick: (e) => {  ·  render: function () {
  {
    kind: 'function',
    re: /^(#?[A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+?)?=>)/,
  },
];

function measureIndentColumns(line) {
  let columns = 0;
  for (const ch of line) {
    if (ch === ' ') columns += 1;
    else if (ch === '\t') columns += 4;
    else break;
  }
  return columns;
}

/** Generische Code-Gliederung: Signaturzeilen per Regex; Ebene = Rang der Einrücktiefe (1 = am weitesten links). */
function extractCodeOutline(lines, { isJavaScript = false } = {}) {
  const patterns = isJavaScript
    ? [...CODE_SIGNATURE_PATTERNS, ...JS_SIGNATURE_PATTERNS]
    : CODE_SIGNATURE_PATTERNS;
  const found = [];
  const indents = new Set();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || CODE_NON_SIGNATURE_START.test(trimmed)) continue;
    for (const { kind, re } of patterns) {
      const m = re.exec(trimmed);
      if (!m) continue;
      const indent = measureIndentColumns(raw);
      indents.add(indent);
      const entry = {
        line: i + 1,
        indent,
        kind: kind === 'keyword' ? m[1] : kind,
        text: clipOutlineText(trimmed.replace(/\s*\{$/, '')),
      };
      const name = kind === 'keyword' ? m[2] : m[1];
      if (name && CODE_RESERVED_NAMES.test(name)) continue;
      if (name) entry.name = name;
      found.push(entry);
      break;
    }
  }
  const ranks = new Map([...indents].sort((a, b) => a - b).map((indent, idx) => [indent, idx + 1]));
  return found.map(({ indent, line, kind, name, text }) => {
    const entry = { line, level: ranks.get(indent), kind };
    if (name) entry.name = name;
    entry.text = text;
    return entry;
  });
}

function clipPatchLine(line) {
  const text = String(line ?? '');
  if (text.length <= PATCH_MAX_MESSAGE_LINE_CHARS) return text;
  return `${text.slice(0, PATCH_MAX_MESSAGE_LINE_CHARS - 1)}…`;
}

/**
 * Wendet mehrere Ersetzungen der Reihe nach auf einen Text an. Jeder Schritt sieht
 * das Ergebnis der vorherigen Schritte; der erste Fehler bricht ab, ohne dass der
 * Aufrufer etwas geschrieben hat (alles oder nichts).
 */
function applyEditsToText(text, edits) {
  let current = text;
  let replacements = 0;
  let firstChangedIndex = -1;

  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    const label = `edits[${i}]`;
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
      return { error: `${label} muss ein Objekt mit old_string und new_string sein.` };
    }
    if (typeof edit.old_string !== 'string' || !edit.old_string.length) {
      return { error: `${label}.old_string (nicht leerer Text) ist erforderlich.` };
    }
    if (typeof edit.new_string !== 'string') {
      return { error: `${label}.new_string (Text, darf leer sein) ist erforderlich.` };
    }
    if (edit.old_string === edit.new_string) {
      return { error: `${label}: old_string und new_string müssen sich unterscheiden.` };
    }

    const firstIndex = current.indexOf(edit.old_string);
    if (firstIndex === -1) {
      return {
        error:
          `${label}: old_string wurde nicht gefunden — der Text muss exakt übereinstimmen ` +
          `(inklusive Einrückung und Zeilenumbrüchen) und darf nicht von einem früheren Schritt verändert worden sein.`,
      };
    }
    let count = 0;
    for (
      let idx = firstIndex;
      idx !== -1;
      idx = current.indexOf(edit.old_string, idx + edit.old_string.length)
    ) {
      count += 1;
    }
    if (count > 1 && edit.replace_all !== true) {
      return {
        error: `${label}: old_string ist nicht eindeutig (${count} Treffer). Mehr umgebenden Kontext angeben oder replace_all=true setzen.`,
      };
    }

    current =
      edit.replace_all === true
        ? current.split(edit.old_string).join(edit.new_string)
        : current.slice(0, firstIndex) +
          edit.new_string +
          current.slice(firstIndex + edit.old_string.length);
    replacements += edit.replace_all === true ? count : 1;
    if (firstChangedIndex === -1 || firstIndex < firstChangedIndex) firstChangedIndex = firstIndex;
  }

  return { text: current, replacements, firstChangedIndex };
}

/** Vorherrschendes Zeilenende eines Textes — CRLF-Dateien sollen CRLF bleiben. */
function detectLineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Zerlegt Dateitext für die Patch-Anwendung in Zeilen ohne Zeilenendezeichen. */
function splitTextForPatch(text) {
  const eol = detectLineEnding(text);
  if (text === '') return { lines: [], endsWithNewline: false, eol };
  const lines = text.split(/\r\n|\r|\n/);
  const endsWithNewline = lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline, eol };
}

function joinPatchLines(lines, endsWithNewline, eol) {
  if (!lines.length) return '';
  return lines.join(eol) + (endsWithNewline ? eol : '');
}

/** `\ No newline at end of file` gewinnt über den Ausgangszustand der Datei. */
function resolveTrailingNewline(hunks, originalEndsWithNewline) {
  if (hunks.some((hunk) => hunk.noNewlineNew)) return false;
  if (hunks.some((hunk) => hunk.noNewlineOld)) return true;
  return originalEndsWithNewline;
}

/** Entfernt Zeitstempel und den üblichen a//b/-Präfix aus einem Diff-Dateikopf. */
function normalizeDiffPath(raw) {
  let value = String(raw ?? '').split('\t')[0].replace(/\s+$/, '');
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  if (value === '/dev/null') return value;
  return value.replace(/^[ab]\//, '').replace(/^\.\//, '');
}

/**
 * Liest einen Hunk ab dem Kopf `@@ -alt,anzahl +neu,anzahl @@`. Die Zeilenzahlen im
 * Kopf bestimmen, wie viele Rumpfzeilen gelesen werden — nur so ist eine entfernte
 * Zeile, die selbst mit "---" beginnt, nicht vom nächsten Dateikopf zu unterscheiden.
 */
function parseUnifiedDiffHunk(rawLines, headerIndex) {
  const header = rawLines[headerIndex];
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) {
    return {
      error:
        `Hunk-Kopf in Zeile ${headerIndex + 1} ist ungültig: "${clipPatchLine(header)}". ` +
        `Erwartet wird "@@ -alteZeile,anzahl +neueZeile,anzahl @@".`,
    };
  }
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);

  const oldLines = [];
  const newLines = [];
  const hunk = {
    header,
    oldStart,
    oldCount,
    oldLines,
    newLines,
    noNewlineOld: false,
    noNewlineNew: false,
  };
  let lastSide = null;
  let i = headerIndex + 1;

  const markNoNewline = () => {
    if (lastSide === 'old' || lastSide === 'both') hunk.noNewlineOld = true;
    if (lastSide === 'new' || lastSide === 'both') hunk.noNewlineNew = true;
  };

  while (i < rawLines.length && (oldLines.length < oldCount || newLines.length < newCount)) {
    const body = rawLines[i];
    // Eine leere Zeile ist eine unveränderte Leerzeile, deren führendes Leerzeichen
    // unterwegs verloren gegangen ist — verbreitet und harmlos.
    const marker = body === '' ? ' ' : body[0];
    const content = body === '' ? '' : body.slice(1);
    if (marker === '\\') {
      markNoNewline();
    } else if (marker === ' ') {
      oldLines.push(content);
      newLines.push(content);
      lastSide = 'both';
    } else if (marker === '-') {
      oldLines.push(content);
      lastSide = 'old';
    } else if (marker === '+') {
      newLines.push(content);
      lastSide = 'new';
    } else {
      return {
        error:
          `Unerwartete Zeile ${i + 1} im Hunk "${clipPatchLine(header)}": "${clipPatchLine(body)}". ` +
          `Hunk-Zeilen beginnen mit " " (unverändert), "-" (entfernt), "+" (neu) oder "\\".`,
      };
    }
    i += 1;
  }

  if (oldLines.length !== oldCount || newLines.length !== newCount) {
    return {
      error:
        `Hunk "${clipPatchLine(header)}" ist unvollständig: erwartet ${oldCount} alte und ${newCount} neue Zeilen, ` +
        `gefunden ${oldLines.length} und ${newLines.length}.`,
    };
  }

  while (i < rawLines.length && rawLines[i].startsWith('\\')) {
    markNoNewline();
    i += 1;
  }
  return { hunk, nextIndex: i };
}

/**
 * Zerlegt einen unified diff in Dateiabschnitte mit Hunks. Unterstützt werden
 * Änderungen an bestehenden Textdateien; Anlegen, Löschen, Umbenennen und
 * Binär-Patches werden mit einem erklärenden Fehler abgelehnt.
 */
function parseUnifiedDiff(text) {
  const rawLines = text.split(/\r?\n/).map((line) => line.replace(/\r$/, ''));
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const files = [];
  let totalHunks = 0;
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      return {
        error: 'Binär-Patches werden nicht unterstützt — apply_patch verarbeitet nur Text-Diffs.',
      };
    }
    if (line === '' || PATCH_PRELUDE_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      i += 1;
      continue;
    }
    if (!line.startsWith('--- ')) {
      return {
        error:
          `Unerwartete Zeile ${i + 1} im Patch: "${clipPatchLine(line)}". ` +
          `Erwartet wird ein Dateikopf ("--- …" gefolgt von "+++ …") oder ein Hunk ("@@ …").`,
      };
    }
    const oldPath = normalizeDiffPath(line.slice(4));
    i += 1;
    if (i >= rawLines.length || !rawLines[i].startsWith('+++ ')) {
      return { error: `Nach dem "--- "-Kopf in Zeile ${i} fehlt die zugehörige "+++ "-Zeile.` };
    }
    const newPath = normalizeDiffPath(rawLines[i].slice(4));
    i += 1;

    if (oldPath === '/dev/null') {
      return {
        error:
          `Der Patch legt "${newPath}" neu an — apply_patch ändert nur bestehende Dateien. ` +
          `Neue Dateien mit write_file_text erstellen.`,
      };
    }
    if (newPath === '/dev/null') {
      return { error: `Der Patch löscht "${oldPath}" — Dateien löschen kann apply_patch nicht.` };
    }
    if (oldPath !== newPath) {
      return {
        error: `Der Patch benennt "${oldPath}" in "${newPath}" um — Umbenennungen unterstützt apply_patch nicht.`,
      };
    }
    if (files.some((file) => file.relativePath === newPath)) {
      return {
        error: `"${newPath}" kommt mehrfach im Patch vor — alle Hunks einer Datei in einem Dateiabschnitt zusammenfassen.`,
      };
    }

    const hunks = [];
    while (i < rawLines.length && rawLines[i].startsWith('@@')) {
      const parsed = parseUnifiedDiffHunk(rawLines, i);
      if (parsed.error) return { error: parsed.error };
      hunks.push(parsed.hunk);
      totalHunks += 1;
      if (totalHunks > PATCH_MAX_HUNKS) {
        return {
          error: `Zu viele Hunks im Patch (mehr als ${PATCH_MAX_HUNKS}). Bitte auf mehrere Aufrufe verteilen.`,
        };
      }
      i = parsed.nextIndex;
    }
    if (!hunks.length) {
      return { error: `Für "${newPath}" enthält der Patch keinen Hunk ("@@ …").` };
    }

    files.push({ relativePath: newPath, hunks });
    if (files.length > PATCH_MAX_FILES) {
      return {
        error: `Zu viele Dateien im Patch (mehr als ${PATCH_MAX_FILES}). Bitte auf mehrere Aufrufe verteilen.`,
      };
    }
  }

  if (!files.length) {
    return { error: 'Der Patch enthält keinen Dateikopf ("--- …" gefolgt von "+++ …").' };
  }
  return { files };
}

/**
 * Sucht die Stelle, an der die alten Zeilen eines Hunks exakt stehen: zuerst an der
 * im Kopf genannten Position, dann in wachsendem Abstand darum herum (Offset-Toleranz
 * wie bei `patch`). Nie vor dem Ende des vorherigen Hunks.
 */
function findHunkIndex(lines, oldLines, expected, minIndex) {
  if (!oldLines.length) {
    if (expected > lines.length) {
      return {
        error:
          `die Einfügeposition (Zeile ${expected + 1}) liegt hinter dem Dateiende — ` +
          `die Datei hat ${lines.length} Zeilen.`,
      };
    }
    return { index: Math.min(Math.max(expected, minIndex), lines.length) };
  }
  const maxIndex = lines.length - oldLines.length;
  if (maxIndex < minIndex) {
    return {
      error: `die Datei hat ab Zeile ${minIndex + 1} weniger Zeilen als der Hunk erwartet (${oldLines.length}).`,
    };
  }
  const matches = (index) => oldLines.every((line, k) => lines[index + k] === line);
  const start = Math.min(Math.max(expected, minIndex), maxIndex);
  if (matches(start)) return { index: start };
  for (let distance = 1; distance <= lines.length; distance += 1) {
    const before = start - distance;
    if (before >= minIndex && matches(before)) return { index: before };
    const after = start + distance;
    if (after <= maxIndex && matches(after)) return { index: after };
  }
  return {
    error:
      `der Kontext passt nicht (erwartet ab Zeile ${expected + 1}, gesucht wurde "${clipPatchLine(oldLines[0])}"). ` +
      `Datei erneut lesen und den Patch auf dem aktuellen Stand erzeugen.`,
  };
}

/** Wendet alle Hunks einer Datei auf ihre Zeilen an — der erste Fehlschlag bricht ab. */
function applyHunksToLines(lines, hunks, relativePath) {
  const result = lines.slice();
  const offsets = [];
  let offset = 0;
  let minIndex = 0;

  for (let h = 0; h < hunks.length; h += 1) {
    const hunk = hunks[h];
    const declared = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const expected = declared + offset;
    const found = findHunkIndex(result, hunk.oldLines, expected, minIndex);
    if (found.error) {
      return {
        error: `Hunk ${h + 1} von ${hunks.length} lässt sich nicht auf "${relativePath}" anwenden: ${found.error}`,
      };
    }
    result.splice(found.index, hunk.oldLines.length, ...hunk.newLines);
    offsets.push(found.index - expected);
    offset += found.index - expected + (hunk.newLines.length - hunk.oldLines.length);
    minIndex = found.index + hunk.newLines.length;
  }

  return { lines: result, offsets };
}

function createFsService({
  fs,
  path,
  maxReadFileBytes,
  maxWriteFileBytes,
  maxSearchScannedFiles,
  maxReadSliceChars,
  regexSearchTimeBudgetMs,
}) {
  const MAX_READ_FILE_BYTES = maxReadFileBytes;
  const MAX_WRITE_FILE_BYTES = maxWriteFileBytes || maxReadFileBytes;
  const MAX_SEARCH_SCANNED_FILES = maxSearchScannedFiles || SEARCH_DEFAULT_MAX_SCANNED_FILES;
  // Zeitbudget für modellgelieferte reguläre Ausdrücke im Worker (Issue #69).
  const REGEX_SEARCH_TIME_BUDGET_MS = regexSearchTimeBudgetMs || REGEX_SEARCH_DEFAULT_TIME_BUDGET_MS;
  // Budget pro Ausschnitt: Zeichen im Zeilenmodus, Bytes im Byte-Modus.
  const MAX_READ_SLICE_CHARS = maxReadSliceChars || READ_SLICE_DEFAULT_MAX_CHARS;

  /** true, wenn candidate (aufgelöst) innerhalb von root liegt — Root selbst zählt mit. */
  function containsPath(root, candidate) {
    const rel = path.relative(path.resolve(root), path.resolve(candidate));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /** Fehlertexte je Wurzelart — der Nutzer soll sehen, woran ein Pfad scheitert. */
  const WORKSPACE_LABELS = {
    outside: 'Pfad liegt außerhalb des Arbeitsordners.',
    missing: 'Kein Arbeitsordner geöffnet.',
  };
  const SKILL_LABELS = {
    outside: 'Pfad liegt außerhalb des Skill-Ordners.',
    missing: 'Skill-Ordner nicht gefunden.',
  };

  function resolvePathInRoot(rootPath, relativePath, labels) {
    if (typeof rootPath !== 'string' || !rootPath.trim()) {
      return { error: labels.missing };
    }
    const root = path.resolve(rootPath);
    const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
    const joined = path.resolve(root, raw.length ? raw : '.');
    if (!containsPath(root, joined)) {
      return { error: labels.outside };
    }
    return { absPath: joined };
  }

  function resolveWorkspacePath(workspaceRoot, relativePath) {
    return resolvePathInRoot(workspaceRoot, relativePath, WORKSPACE_LABELS);
  }

  function assertAbsolutePathInRoot(rootPath, absPath, labels) {
    if (!rootPath) {
      return { error: labels.missing };
    }
    const raw = typeof absPath === 'string' ? absPath.trim() : '';
    if (!raw) {
      return { error: 'Pfad ist erforderlich.' };
    }
    const resolved = path.resolve(raw);
    if (!containsPath(rootPath, resolved)) {
      return { error: labels.outside };
    }
    return { absPath: resolved };
  }

  function assertAbsolutePathInWorkspace(workspaceRoot, absPath) {
    return assertAbsolutePathInRoot(workspaceRoot, absPath, WORKSPACE_LABELS);
  }

  /**
   * Resolves the nearest existing path (including symlinks) and appends any
   * not-yet-existing suffix. lstat is intentionally separate from realpath:
   * a dangling symlink must be rejected, not treated as a missing path.
   */
  async function resolveExistingRealPath(absPath) {
    let current = path.resolve(absPath);
    const missingSegments = [];

    while (true) {
      try {
        await fs.lstat(current);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const parent = path.dirname(current);
        if (parent === current) throw e;
        missingSegments.push(path.basename(current));
        current = parent;
        continue;
      }

      const realPath = await fs.realpath(current);
      return missingSegments.length
        ? path.join(realPath, ...missingSegments.reverse())
        : realPath;
    }
  }

  async function assertPathAccessibleInRoot(rootPath, absPath, labels) {
    const lexical = assertAbsolutePathInRoot(rootPath, absPath, labels);
    if (lexical.error) return lexical;

    try {
      const realRoot = await fs.realpath(path.resolve(rootPath));
      const realTarget = await resolveExistingRealPath(lexical.absPath);
      if (!containsPath(realRoot, realTarget)) {
        return { error: labels.outside };
      }
      return { absPath: lexical.absPath };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function assertPathAccessibleInWorkspace(workspaceRoot, absPath) {
    return assertPathAccessibleInRoot(workspaceRoot, absPath, WORKSPACE_LABELS);
  }

  /**
   * Waehlt die Wurzel fuer einen Tool-Pfad (Issue #61). Ohne Praefix ist das
   * der Arbeitsordner. Mit "skill:<name>/" ist es das Verzeichnis eines
   * eingeschalteten Skills — das bekommen ausschliesslich die Lese-Tools
   * uebergeben, Schreib-Tools erhalten nie eine `skillRoots`-Liste und
   * scheitern deshalb strukturell an solchen Pfaden.
   *
   * @param {string} workspaceRoot
   * @param {string} relativePath  Pfad wie vom Modell uebergeben.
   * @param {Array<{name: string, dir: string}>} [skillRoots]
   */
  function resolveAccessRoot(workspaceRoot, relativePath, skillRoots) {
    const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
    const parsed = parseSkillPath(raw);
    if (!parsed) {
      return { root: workspaceRoot, rel: raw, prefix: '', labels: WORKSPACE_LABELS };
    }
    if (!Array.isArray(skillRoots)) {
      return { error: 'Skill-Pfade (skill:…) sind nur mit den Lese-Tools möglich.' };
    }
    const known = skillRoots.filter((entry) => entry && entry.name && entry.dir);
    if (known.length === 0) {
      return { error: 'Es ist kein Skill eingeschaltet — Skill-Pfade gibt es hier nicht.' };
    }
    const hit = known.find((entry) => entry.name === parsed.name);
    if (!hit) {
      const names = known.map((entry) => entry.name).join(', ');
      return { error: `Unbekannter Skill: „${parsed.name}“. Eingeschaltet sind: ${names}.` };
    }
    return {
      root: hit.dir,
      rel: parsed.rest,
      prefix: `${SKILL_PATH_PREFIX}${hit.name}/`,
      skillName: hit.name,
      labels: SKILL_LABELS,
    };
  }

  /**
   * Loest einen Tool-Pfad gegen die passende Wurzel auf und prueft ihn gegen
   * Ausbrueche (lexikalisch und ueber Realpath, inkl. Symlinks).
   *
   * @returns {Promise<{absPath?: string, root?: string, prefix?: string,
   *   skillName?: string|null, error?: string}>} `root` ist die tatsaechlich
   *   genutzte Wurzel, `prefix` das Praefix fuer daraus erzeugte relative Pfade.
   */
  async function resolveToolPath(workspaceRoot, relativePath, options = {}) {
    const chosen = resolveAccessRoot(workspaceRoot, relativePath, options.skillRoots);
    if (chosen.error) return { error: chosen.error };
    const lexical = resolvePathInRoot(chosen.root, chosen.rel, chosen.labels);
    if (lexical.error) return lexical;
    const checked = await assertPathAccessibleInRoot(chosen.root, lexical.absPath, chosen.labels);
    if (checked.error) return checked;
    return {
      absPath: checked.absPath,
      root: path.resolve(chosen.root),
      prefix: chosen.prefix,
      skillName: chosen.skillName || null,
    };
  }

  /**
   * Wie `resolveToolPath`, aber ohne Skill-Wurzeln: nutzen die Schreib-Tools.
   * Ein "skill:"-Pfad scheitert hier bewusst mit einer klaren Meldung, statt
   * als Datei mit dem Namen „skill:…“ im Arbeitsordner zu landen.
   */
  async function resolveWorkspacePathForAccess(workspaceRoot, relativePath) {
    return resolveToolPath(workspaceRoot, relativePath);
  }

  async function runListDirectoryTool(args, workspaceRoot, options = {}) {
    const relArg = args.relative_path;
    const rel = typeof relArg === 'string' ? relArg : '';
    const { absPath, error } = await resolveToolPath(workspaceRoot, rel, options);
    if (error) return JSON.stringify({ error });
    try {
      const st = await fs.stat(absPath);
      if (!st.isDirectory()) {
        return JSON.stringify({ error: 'Pfad ist kein Ordner.' });
      }
      const entries = await fs.readdir(absPath, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          kind: e.isDirectory() ? 'directory' : 'file',
        }))
        .sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
      return JSON.stringify({ relative_path: rel || '.', items });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }

  async function runReadFileTextTool(args, workspaceRoot, options = {}) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) {
      return JSON.stringify({ error: 'relative_path ist erforderlich.' });
    }
    let maxChars = Number.isFinite(args.max_characters) ? Math.floor(args.max_characters) : 32000;
    maxChars = Math.min(Math.max(1000, maxChars), 200000);
    const { absPath, error } = await resolveToolPath(workspaceRoot, rel, options);
    if (error) return JSON.stringify({ error });
    try {
      const st = await fs.stat(absPath);
      if (st.isDirectory()) {
        return JSON.stringify({ error: 'Pfad ist ein Ordner, keine Datei.' });
      }
      if (st.size > MAX_READ_FILE_BYTES) {
        return JSON.stringify({
          error: `Datei zu groß (>${MAX_READ_FILE_BYTES} Bytes). Bitte andere Datei wählen.`,
        });
      }
      const buf = await fs.readFile(absPath);
      let text = buf.toString('utf8');
      const truncated = text.length > maxChars;
      if (truncated) {
        text = `${text.slice(0, maxChars)}\n… [gekürzt auf ${maxChars} Zeichen]`;
      }
      return JSON.stringify({
        relative_path: rel,
        size_bytes: st.size,
        truncated,
        content: text,
      });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }

  async function runReadFileLinesTool(args, workspaceRoot, options = {}) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) {
      return JSON.stringify({ error: 'relative_path ist erforderlich.' });
    }
    const hasLineRange = args.start_line !== undefined || args.end_line !== undefined;
    const hasByteRange = args.start_byte !== undefined || args.length !== undefined;
    if (hasLineRange && hasByteRange) {
      return JSON.stringify({
        error:
          'Entweder Zeilenbereich (start_line/end_line) oder Byte-Bereich (start_byte/length) angeben — nicht beides.',
      });
    }
    const parsed = {};
    for (const name of ['start_line', 'end_line', 'start_byte', 'length']) {
      const { value, error } = readIntegerArg(args, name);
      if (error) return JSON.stringify({ error });
      parsed[name] = value;
    }
    const { absPath, error } = await resolveToolPath(workspaceRoot, rel, options);
    if (error) return JSON.stringify({ error });
    let buf;
    try {
      const st = await fs.stat(absPath);
      if (st.isDirectory()) {
        return JSON.stringify({ error: 'Pfad ist ein Ordner, keine Datei.' });
      }
      if (st.size > MAX_READ_FILE_BYTES) {
        return JSON.stringify({
          error: `Datei zu groß (>${MAX_READ_FILE_BYTES} Bytes). Bitte andere Datei wählen.`,
        });
      }
      buf = await fs.readFile(absPath);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
    const result = hasByteRange
      ? buildByteSliceResult(rel, buf, parsed.start_byte, parsed.length, MAX_READ_SLICE_CHARS)
      : buildLineSliceResult(
          rel,
          buf.toString('utf8'),
          parsed.start_line,
          parsed.end_line,
          MAX_READ_SLICE_CHARS
        );
    return JSON.stringify(result);
  }

  async function runWriteFileTextTool(args, workspaceRoot) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) {
      return JSON.stringify({ error: 'relative_path ist erforderlich.' });
    }
    if (typeof args.content !== 'string') {
      return JSON.stringify({ error: 'content (Text) ist erforderlich.' });
    }
    const byteLength = Buffer.byteLength(args.content, 'utf8');
    if (byteLength > MAX_WRITE_FILE_BYTES) {
      return JSON.stringify({
        error: `Inhalt zu groß (>${MAX_WRITE_FILE_BYTES} Bytes). Bitte kleiner aufteilen.`,
      });
    }
    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
    if (error) return JSON.stringify({ error });
    if (path.resolve(absPath) === path.resolve(workspaceRoot)) {
      return JSON.stringify({ error: 'Der Projektordner selbst kann nicht als Datei beschrieben werden.' });
    }
    try {
      let existed = false;
      try {
        const st = await fs.stat(absPath);
        if (st.isDirectory()) {
          return JSON.stringify({ error: 'Pfad ist ein Ordner, keine Datei.' });
        }
        existed = true;
      } catch {
        existed = false;
      }
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, args.content, 'utf8');
      return JSON.stringify({
        relative_path: rel,
        created: !existed,
        overwritten: existed,
        bytes_written: byteLength,
      });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }

  async function runEditFileTool(args, workspaceRoot) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) {
      return JSON.stringify({ error: 'relative_path ist erforderlich.' });
    }
    if (typeof args.old_string !== 'string' || !args.old_string.length) {
      return JSON.stringify({ error: 'old_string (nicht leerer Text) ist erforderlich.' });
    }
    if (typeof args.new_string !== 'string') {
      return JSON.stringify({ error: 'new_string (Text, darf leer sein) ist erforderlich.' });
    }
    if (args.old_string === args.new_string) {
      return JSON.stringify({ error: 'old_string und new_string müssen sich unterscheiden.' });
    }
    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
    if (error) return JSON.stringify({ error });
    try {
      const st = await fs.stat(absPath);
      if (st.isDirectory()) {
        return JSON.stringify({ error: 'Pfad ist ein Ordner, keine Datei.' });
      }
      if (st.size > MAX_READ_FILE_BYTES) {
        return JSON.stringify({
          error: `Datei zu groß (>${MAX_READ_FILE_BYTES} Bytes). Bitte andere Datei wählen.`,
        });
      }
      const text = (await fs.readFile(absPath)).toString('utf8');
      let count = 0;
      const firstIndex = text.indexOf(args.old_string);
      for (let idx = firstIndex; idx !== -1; idx = text.indexOf(args.old_string, idx + args.old_string.length)) {
        count += 1;
      }
      if (count === 0) {
        return JSON.stringify({
          error:
            'old_string wurde nicht gefunden. Der Text muss exakt übereinstimmen — inklusive Einrückung und Zeilenumbrüchen.',
        });
      }
      if (count > 1 && args.replace_all !== true) {
        return JSON.stringify({
          error: `old_string ist nicht eindeutig (${count} Treffer). Mehr umgebenden Kontext angeben oder replace_all=true setzen.`,
        });
      }
      const updated =
        args.replace_all === true
          ? text.split(args.old_string).join(args.new_string)
          : text.slice(0, firstIndex) +
            args.new_string +
            text.slice(firstIndex + args.old_string.length);
      const byteLength = Buffer.byteLength(updated, 'utf8');
      if (byteLength > MAX_WRITE_FILE_BYTES) {
        return JSON.stringify({
          error: `Inhalt zu groß (>${MAX_WRITE_FILE_BYTES} Bytes). Bitte kleiner aufteilen.`,
        });
      }
      await fs.writeFile(absPath, updated, 'utf8');
      return JSON.stringify({
        relative_path: rel,
        replacements: args.replace_all === true ? count : 1,
        first_changed_line: text.slice(0, firstIndex).split(/\r\n|\r|\n/).length,
        bytes_written: byteLength,
      });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }

  /**
   * apply_patch, Modus `edits`: mehrere Ersetzungen in einer Datei. Erst wenn alle
   * Schritte durchlaufen, wird einmal geschrieben — schlägt einer fehl, bleibt die
   * Datei unverändert.
   */
  async function runApplyEditsMode(args, workspaceRoot) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) {
      return JSON.stringify({ error: 'relative_path ist erforderlich.' });
    }
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return JSON.stringify({ error: 'edits muss eine nicht leere Liste von Ersetzungen sein.' });
    }
    if (args.edits.length > PATCH_MAX_EDITS) {
      return JSON.stringify({
        error: `Zu viele Schritte in edits (${args.edits.length} > ${PATCH_MAX_EDITS}). Bitte auf mehrere Aufrufe verteilen.`,
      });
    }
    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
    if (error) return JSON.stringify({ error });
    try {
      const st = await fs.stat(absPath);
      if (st.isDirectory()) {
        return JSON.stringify({ error: 'Pfad ist ein Ordner, keine Datei.' });
      }
      if (st.size > MAX_READ_FILE_BYTES) {
        return JSON.stringify({
          error: `Datei zu groß (>${MAX_READ_FILE_BYTES} Bytes). Bitte andere Datei wählen.`,
        });
      }
      const text = (await fs.readFile(absPath)).toString('utf8');
      const applied = applyEditsToText(text, args.edits);
      if (applied.error) return JSON.stringify({ error: applied.error });
      const byteLength = Buffer.byteLength(applied.text, 'utf8');
      if (byteLength > MAX_WRITE_FILE_BYTES) {
        return JSON.stringify({
          error: `Inhalt zu groß (>${MAX_WRITE_FILE_BYTES} Bytes). Bitte kleiner aufteilen.`,
        });
      }
      await fs.writeFile(absPath, applied.text, 'utf8');
      return JSON.stringify({
        mode: 'edits',
        relative_path: rel,
        edits_applied: args.edits.length,
        replacements: applied.replacements,
        first_changed_line: text.slice(0, applied.firstChangedIndex).split(/\r\n|\r|\n/).length,
        bytes_written: byteLength,
      });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }

  /** Stellt nach einem fehlgeschlagenen Schreibvorgang die Ausgangsinhalte wieder her. */
  async function rollbackPatchedFiles(written) {
    const failed = [];
    for (const entry of written) {
      try {
        await fs.writeFile(entry.absPath, entry.original, 'utf8');
      } catch {
        failed.push(entry.relativePath);
      }
    }
    return failed;
  }

  /**
   * apply_patch, Modus `patch`: ein unified diff über eine oder mehrere Dateien.
   * Phase 1 prüft alles und berechnet die neuen Inhalte im Speicher, Phase 2
   * schreibt sie; scheitert ein Schreibvorgang, werden die bereits geschriebenen
   * Dateien auf ihren Ausgangsinhalt zurückgesetzt.
   */
  async function runApplyDiffMode(args, workspaceRoot) {
    if (typeof args.patch !== 'string' || !args.patch.trim()) {
      return JSON.stringify({ error: 'patch (unified diff als Text) ist erforderlich.' });
    }
    if (Buffer.byteLength(args.patch, 'utf8') > MAX_WRITE_FILE_BYTES) {
      return JSON.stringify({
        error: `Patch zu groß (>${MAX_WRITE_FILE_BYTES} Bytes). Bitte kleiner aufteilen.`,
      });
    }
    const parsed = parseUnifiedDiff(args.patch);
    if (parsed.error) return JSON.stringify({ error: parsed.error });

    const relArg = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (relArg && !parsed.files.some((file) => file.relativePath === relArg)) {
      return JSON.stringify({
        error:
          `relative_path ("${relArg}") kommt im Patch nicht vor. Im patch-Modus stehen die Pfade in den ` +
          `"+++"-Kopfzeilen: ${parsed.files.map((file) => file.relativePath).join(', ')}.`,
      });
    }

    const planned = [];
    for (const file of parsed.files) {
      const resolved = await resolveWorkspacePathForAccess(workspaceRoot, file.relativePath);
      if (resolved.error) {
        return JSON.stringify({ error: `"${file.relativePath}": ${resolved.error}` });
      }
      let st;
      try {
        st = await fs.stat(resolved.absPath);
      } catch {
        return JSON.stringify({
          error:
            `"${file.relativePath}" existiert nicht — apply_patch ändert nur bestehende Dateien. ` +
            `Neue Dateien mit write_file_text erstellen.`,
        });
      }
      if (st.isDirectory()) {
        return JSON.stringify({ error: `"${file.relativePath}": Pfad ist ein Ordner, keine Datei.` });
      }
      if (st.size > MAX_READ_FILE_BYTES) {
        return JSON.stringify({
          error: `"${file.relativePath}": Datei zu groß (>${MAX_READ_FILE_BYTES} Bytes). Bitte andere Datei wählen.`,
        });
      }
      let original;
      try {
        original = (await fs.readFile(resolved.absPath)).toString('utf8');
      } catch (e) {
        return JSON.stringify({ error: `"${file.relativePath}": ${e.message}` });
      }
      const source = splitTextForPatch(original);
      const applied = applyHunksToLines(source.lines, file.hunks, file.relativePath);
      if (applied.error) return JSON.stringify({ error: applied.error });
      const updated = joinPatchLines(
        applied.lines,
        resolveTrailingNewline(file.hunks, source.endsWithNewline),
        source.eol
      );
      const byteLength = Buffer.byteLength(updated, 'utf8');
      if (byteLength > MAX_WRITE_FILE_BYTES) {
        return JSON.stringify({
          error: `"${file.relativePath}": Inhalt zu groß (>${MAX_WRITE_FILE_BYTES} Bytes). Bitte kleiner aufteilen.`,
        });
      }
      planned.push({
        relativePath: file.relativePath,
        absPath: resolved.absPath,
        original,
        updated,
        byteLength,
        hunks: file.hunks.length,
        offsets: applied.offsets,
      });
    }

    const written = [];
    for (const entry of planned) {
      try {
        await fs.writeFile(entry.absPath, entry.updated, 'utf8');
        written.push(entry);
      } catch (e) {
        const failed = await rollbackPatchedFiles(written);
        let note = written.length
          ? ' Die bereits geschriebenen Dateien wurden zurückgesetzt.'
          : ' Es wurde nichts geändert.';
        if (failed.length) {
          note = ` Achtung: Rücknahme unvollständig — nicht zurückgesetzt: ${failed.join(', ')}.`;
        }
        return JSON.stringify({ error: `"${entry.relativePath}": ${e.message}.${note}` });
      }
    }

    return JSON.stringify({
      mode: 'unified_diff',
      files_changed: planned.length,
      hunks_applied: planned.reduce((sum, entry) => sum + entry.hunks, 0),
      files: planned.map((entry) => ({
        relative_path: entry.relativePath,
        hunks_applied: entry.hunks,
        // Nur melden, wenn ein Hunk versetzt zur Kopfzeile gegriffen hat.
        ...(entry.offsets.some((value) => value !== 0) ? { line_offsets: entry.offsets } : {}),
        bytes_written: entry.byteLength,
      })),
    });
  }

  async function runApplyPatchTool(args, workspaceRoot) {
    const hasEdits = args.edits !== undefined && args.edits !== null;
    const hasPatch = args.patch !== undefined && args.patch !== null;
    if (hasEdits && hasPatch) {
      return JSON.stringify({
        error:
          'Entweder edits (mehrere Ersetzungen in einer Datei) oder patch (unified diff) angeben — nicht beides.',
      });
    }
    if (!hasEdits && !hasPatch) {
      return JSON.stringify({
        error: 'edits (Liste von Ersetzungen) oder patch (unified diff als Text) ist erforderlich.',
      });
    }
    return hasEdits ? runApplyEditsMode(args, workspaceRoot) : runApplyDiffMode(args, workspaceRoot);
  }

  async function loadGitignoreMatcher(root) {
    try {
      const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
      return createGitignoreMatcher(gitignore);
    } catch {
      return null; // keine lesbare .gitignore — nichts auszuschließen
    }
  }

  /**
   * Liest einen Ordner mit den gemeinsamen Regeln von search_in_files, find_files und
   * list_directory_tree: .git und (ohne includeHidden) Punkt-Einträge überspringen,
   * .gitignore des Projektroots anwenden, Symlinks nicht verfolgen (an Dirents weder
   * isFile noch isDirectory). Sortiert Dateien vor Ordnern, dann nach Name.
   */
  async function readWorkspaceEntries(dirAbs, { root, includeHidden, isIgnored }) {
    let dirents;
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries = [];
    for (const dirent of dirents) {
      if (dirent.name === '.git') continue;
      if (!includeHidden && dirent.name.startsWith('.')) continue;
      const isDirectory = dirent.isDirectory();
      if (!isDirectory && !dirent.isFile()) continue;
      const absPath = path.join(dirAbs, dirent.name);
      const relPath = path.relative(root, absPath).split(path.sep).join('/');
      if (isIgnored && isIgnored(relPath, isDirectory)) continue;
      entries.push({ name: dirent.name, absPath, relPath, isDirectory });
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return entries;
  }

  async function runSearchInFilesTool(args, workspaceRoot, options = {}) {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query) {
      return JSON.stringify({ error: 'query ist erforderlich.' });
    }
    const isRegex = args.is_regex === true;
    const pattern = isRegex ? query : escapeRegExpLiteral(query);
    const flags = args.case_sensitive === true ? '' : 'i';
    if (isRegex) {
      // Bekannte ReDoS-Muster und überlange Ausdrücke vor jeder Ausführung ablehnen.
      const complexityError = validateRegexPattern(query, { maxChars: SEARCH_MAX_PATTERN_CHARS });
      if (complexityError) return JSON.stringify({ error: complexityError });
    }
    let matcher;
    try {
      matcher = new RegExp(pattern, flags);
    } catch (e) {
      return JSON.stringify({ error: `Ungültiger regulärer Ausdruck: ${e.message}` });
    }
    let contextLines = Number.isFinite(args.context_lines)
      ? Math.floor(args.context_lines)
      : SEARCH_DEFAULT_CONTEXT_LINES;
    contextLines = Math.min(Math.max(0, contextLines), SEARCH_MAX_CONTEXT_LINES);
    let maxResults = Number.isFinite(args.max_results)
      ? Math.floor(args.max_results)
      : SEARCH_DEFAULT_MAX_RESULTS;
    maxResults = Math.min(Math.max(1, maxResults), SEARCH_MAX_RESULTS);
    const includeHidden = args.include_hidden === true;
    const include =
      typeof args.include === 'string' && args.include.trim()
        ? globToRegExp(args.include.trim())
        : null;
    const exclude =
      typeof args.exclude === 'string' && args.exclude.trim()
        ? globToRegExp(args.exclude.trim())
        : null;

    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    const { absPath, root, prefix, error } = await resolveToolPath(workspaceRoot, rel, options);
    if (error) return JSON.stringify({ error });

    const walkOptions = { root, includeHidden, isIgnored: await loadGitignoreMatcher(root) };
    const matchOptions = {
      contextLines,
      matchLineChars: SEARCH_MAX_MATCH_LINE_CHARS,
      clipChars: SEARCH_MAX_LINE_CHARS,
    };
    // Wörtliche Suchen sind linear und laufen im Main-Thread. Reguläre Ausdrücke
    // vom Modell laufen in einem Worker mit hartem Zeitbudget, damit
    // katastrophales Backtracking die App nicht einfrieren kann (Issue #69).
    let regexWorker = null;
    function matchText(text, maxMatches) {
      if (!isRegex) return collectLineMatches(text, matcher, { ...matchOptions, maxMatches });
      if (!regexWorker) {
        regexWorker = createRegexSearchWorker({
          pattern,
          flags,
          options: matchOptions,
          timeBudgetMs: REGEX_SEARCH_TIME_BUDGET_MS,
        });
      }
      return regexWorker.search(text, maxMatches);
    }

    const state = {
      matches: [],
      filesScanned: 0,
      filesVisited: 0,
      matchLimitReached: false,
      scanLimitReached: false,
    };
    // Erzeugte Pfade tragen die Wurzel mit: aus einem Skill-Ordner kommen sie
    // als "skill:<name>/…" zurück und sind damit direkt wieder aufrufbar.
    const toRelPosix = (abs) => `${prefix}${path.relative(root, abs).split(path.sep).join('/')}`;

    async function scanFile(fileAbs, size) {
      if (state.filesVisited >= MAX_SEARCH_SCANNED_FILES) {
        state.scanLimitReached = true;
        return;
      }
      state.filesVisited += 1;
      if (size > MAX_READ_FILE_BYTES) return;
      let buf;
      try {
        buf = await fs.readFile(fileAbs);
      } catch {
        return;
      }
      if (isBinaryBuffer(buf)) return;
      state.filesScanned += 1;
      const relFile = toRelPosix(fileAbs);
      const found = await matchText(buf.toString('utf8'), maxResults - state.matches.length);
      for (const m of found) {
        state.matches.push({ file: relFile, ...m });
      }
      if (state.matches.length >= maxResults) state.matchLimitReached = true;
    }

    async function walk(dirAbs) {
      for (const entry of await readWorkspaceEntries(dirAbs, walkOptions)) {
        if (state.matchLimitReached || state.scanLimitReached) return;
        if (exclude && exclude.regex.test(entry.relPath)) continue;
        if (entry.isDirectory) {
          await walk(entry.absPath);
          continue;
        }
        if (include && !include.regex.test(entry.relPath)) continue;
        let st;
        try {
          st = await fs.stat(entry.absPath);
        } catch {
          continue;
        }
        await scanFile(entry.absPath, st.size);
      }
    }

    try {
      const st = await fs.stat(absPath);
      if (st.isDirectory()) {
        await walk(absPath);
      } else {
        await scanFile(absPath, st.size);
      }
    } catch (e) {
      if (e instanceof RegexSearchTimeoutError) {
        // Bisherige Treffer mitgeben — das Modell kann damit oft schon arbeiten.
        return JSON.stringify({
          error: e.message,
          aborted: true,
          matches: state.matches,
          files_scanned: state.filesScanned,
        });
      }
      return JSON.stringify({ error: e.message });
    } finally {
      if (regexWorker) regexWorker.terminate();
    }

    return JSON.stringify({
      relative_path: rel || '.',
      query,
      matches: state.matches,
      files_scanned: state.filesScanned,
      truncated: state.matchLimitReached,
      scan_limit_reached: state.scanLimitReached,
    });
  }

  async function runFindFilesTool(args, workspaceRoot, options = {}) {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (!pattern) {
      return JSON.stringify({ error: 'pattern ist erforderlich.' });
    }
    const glob = globToRegExp(pattern);
    let maxResults = Number.isFinite(args.max_results)
      ? Math.floor(args.max_results)
      : FIND_DEFAULT_MAX_RESULTS;
    maxResults = Math.min(Math.max(1, maxResults), FIND_MAX_RESULTS);
    const includeHidden = args.include_hidden === true;

    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    const { absPath, root, prefix, error } = await resolveToolPath(workspaceRoot, rel, options);
    if (error) return JSON.stringify({ error });

    const walkOptions = { root, includeHidden, isIgnored: await loadGitignoreMatcher(root) };

    const state = {
      results: [],
      entriesVisited: 0,
      matchLimitReached: false,
      scanLimitReached: false,
    };
    function addMatch(relEntry, isDirectory) {
      if (glob.dirOnly && !isDirectory) return;
      if (!glob.regex.test(relEntry)) return;
      state.results.push({ path: `${prefix}${relEntry}`, kind: isDirectory ? 'directory' : 'file' });
      if (state.results.length >= maxResults) state.matchLimitReached = true;
    }

    async function walk(dirAbs) {
      for (const entry of await readWorkspaceEntries(dirAbs, walkOptions)) {
        if (state.matchLimitReached || state.scanLimitReached) return;
        if (state.entriesVisited >= MAX_SEARCH_SCANNED_FILES) {
          state.scanLimitReached = true;
          return;
        }
        state.entriesVisited += 1;
        addMatch(entry.relPath, entry.isDirectory);
        if (state.matchLimitReached) return;
        if (entry.isDirectory) await walk(entry.absPath);
      }
    }

    try {
      const st = await fs.stat(absPath);
      if (!st.isDirectory()) {
        return JSON.stringify({ error: 'Pfad ist kein Ordner.' });
      }
      await walk(absPath);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }

    return JSON.stringify({
      relative_path: rel || '.',
      pattern,
      results: state.results,
      truncated: state.matchLimitReached,
      scan_limit_reached: state.scanLimitReached,
    });
  }

  /**
   * Flache Liste aller Dateien und Ordner des Workspace (relative POSIX-Pfade) für
   * die @-Vervollständigung im Chat. Gleiche Ausschlussregeln wie find_files ohne
   * include_hidden: .git, Punkt-Einträge, .gitignore-Muster des Projektroots, keine
   * Symlinks. Breitensuche, damit beim Erreichen der Obergrenze die oberen Ebenen
   * vollständig sind (die Liste zeigt bei leerer Eingabe die Wurzel zuerst).
   */
  async function listWorkspacePaths(workspaceRoot, { maxEntries = MENTION_MAX_ENTRIES } = {}) {
    const root = path.resolve(workspaceRoot);
    const cap = Math.max(1, Math.floor(Number(maxEntries) || MENTION_MAX_ENTRIES));
    const walkOptions = { root, includeHidden: false, isIgnored: await loadGitignoreMatcher(root) };
    const entries = [];
    let truncated = false;
    const queue = [root];
    while (queue.length > 0 && !truncated) {
      const dirAbs = queue.shift();
      for (const entry of await readWorkspaceEntries(dirAbs, walkOptions)) {
        if (entries.length >= cap) {
          truncated = true;
          break;
        }
        entries.push({ path: entry.relPath, kind: entry.isDirectory ? 'directory' : 'file' });
        if (entry.isDirectory) queue.push(entry.absPath);
      }
    }
    return { entries, truncated };
  }

  async function runStatPathTool(args, workspaceRoot, options = {}) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) {
      return JSON.stringify({ error: 'relative_path ist erforderlich ("." für das Projektroot).' });
    }
    const { absPath, error } = await resolveToolPath(workspaceRoot, rel, options);
    if (error) return JSON.stringify({ error });
    let st;
    try {
      st = await fs.stat(absPath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return JSON.stringify({ relative_path: rel, exists: false });
      }
      return JSON.stringify({ error: e.message });
    }
    const isDirectory = st.isDirectory();
    const result = {
      relative_path: rel,
      exists: true,
      kind: isDirectory ? 'directory' : 'file',
    };
    if (!isDirectory) result.size_bytes = st.size;
    result.modified = new Date(st.mtimeMs).toISOString();
    if (args.include_line_count === true && !isDirectory) {
      if (st.size > MAX_READ_FILE_BYTES) {
        result.line_count_skipped = `Datei zu groß für die Zeilenzählung (>${MAX_READ_FILE_BYTES} Bytes).`;
      } else {
        try {
          const buf = await fs.readFile(absPath);
          if (isBinaryBuffer(buf)) {
            result.line_count_skipped = 'Binärdatei — Zeilenzählung übersprungen.';
          } else {
            result.line_count = splitFileLines(buf.toString('utf8')).length;
          }
        } catch (e) {
          result.line_count_skipped = e.message;
        }
      }
    }
    return JSON.stringify(result);
  }

  async function runOutlineFileTool(args, workspaceRoot, options = {}) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) {
      return JSON.stringify({ error: 'relative_path ist erforderlich.' });
    }
    const depth = readIntegerArg(args, 'max_depth');
    if (depth.error) return JSON.stringify({ error: depth.error });
    if (depth.value !== undefined && depth.value < 1) {
      return JSON.stringify({ error: 'max_depth muss mindestens 1 sein.' });
    }
    let maxEntries = Number.isFinite(args.max_entries)
      ? Math.floor(args.max_entries)
      : OUTLINE_DEFAULT_MAX_ENTRIES;
    maxEntries = Math.min(Math.max(1, maxEntries), OUTLINE_MAX_ENTRIES);
    const { absPath, error } = await resolveToolPath(workspaceRoot, rel, options);
    if (error) return JSON.stringify({ error });
    let buf;
    try {
      const st = await fs.stat(absPath);
      if (st.isDirectory()) {
        return JSON.stringify({ error: 'Pfad ist ein Ordner, keine Datei.' });
      }
      if (st.size > MAX_READ_FILE_BYTES) {
        return JSON.stringify({
          error: `Datei zu groß (>${MAX_READ_FILE_BYTES} Bytes). Bitte andere Datei wählen.`,
        });
      }
      buf = await fs.readFile(absPath);
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
    if (isBinaryBuffer(buf)) {
      return JSON.stringify({ error: 'Binärdatei — keine Gliederung möglich.' });
    }
    const ext = path.extname(rel).toLowerCase();
    const isMarkdown = OUTLINE_MARKDOWN_EXTENSIONS.has(ext);
    const lines = splitFileLines(buf.toString('utf8').replace(/^\uFEFF/, ''));
    let entries = isMarkdown
      ? extractMarkdownOutline(lines)
      : extractCodeOutline(lines, { isJavaScript: OUTLINE_JS_EXTENSIONS.has(ext) });
    if (depth.value !== undefined) {
      entries = entries.filter((entry) => entry.level <= depth.value);
    }
    const total = entries.length;
    const result = {
      relative_path: rel,
      format: isMarkdown ? 'markdown' : 'code',
      line_count: lines.length,
      total_entries: total,
      entries: entries.slice(0, maxEntries),
      truncated: total > maxEntries,
    };
    if (total === 0) {
      result.hint = isMarkdown
        ? 'Keine Überschriften gefunden.'
        : 'Keine Signaturen erkannt (generische Heuristik für Funktionen, Klassen, Typen). Ggf. read_file_lines nutzen.';
    }
    return JSON.stringify(result);
  }

  async function runListDirectoryTreeTool(args, workspaceRoot, options = {}) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    const depth = readIntegerArg(args, 'max_depth');
    if (depth.error) return JSON.stringify({ error: depth.error });
    let maxDepth = depth.value === undefined ? TREE_DEFAULT_MAX_DEPTH : depth.value;
    if (maxDepth < 1) return JSON.stringify({ error: 'max_depth muss mindestens 1 sein.' });
    maxDepth = Math.min(maxDepth, TREE_MAX_DEPTH);
    let maxEntries = Number.isFinite(args.max_entries)
      ? Math.floor(args.max_entries)
      : TREE_DEFAULT_MAX_ENTRIES;
    maxEntries = Math.min(Math.max(1, maxEntries), TREE_MAX_ENTRIES);
    const includeHidden = args.include_hidden === true;

    const { absPath, root, error } = await resolveToolPath(workspaceRoot, rel, options);
    if (error) return JSON.stringify({ error });
    try {
      const st = await fs.stat(absPath);
      if (!st.isDirectory()) {
        return JSON.stringify({ error: 'Pfad ist kein Ordner.' });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
    const walkOptions = { root, includeHidden, isIgnored: await loadGitignoreMatcher(root) };

    // Breitensuche mit Gesamtbudget: obere Ebenen werden zuerst vollständig, tiefe zuletzt.
    // hidden = direkte Einträge eines Ordners, die wegen max_depth oder max_entries fehlen.
    const rootNode = { name: rel || '.', isDirectory: true, absPath, children: [], hidden: 0 };
    const queue = [{ node: rootNode, depth: 0 }];
    let shown = 0;
    let hiddenTotal = 0;
    let truncated = false;
    while (queue.length) {
      const { node, depth } = queue.shift();
      const entries = await readWorkspaceEntries(node.absPath, walkOptions);
      if (depth >= maxDepth) {
        node.hidden = entries.length;
        hiddenTotal += entries.length;
        continue;
      }
      for (const entry of entries) {
        if (shown >= maxEntries) {
          node.hidden += 1;
          hiddenTotal += 1;
          truncated = true;
          continue;
        }
        shown += 1;
        const child = {
          name: entry.name,
          isDirectory: entry.isDirectory,
          absPath: entry.absPath,
          children: [],
          hidden: 0,
        };
        node.children.push(child);
        if (entry.isDirectory) queue.push({ node: child, depth: depth + 1 });
      }
    }

    const lines = [];
    const label = (node) =>
      `${node.name}${node.isDirectory ? '/' : ''}${node.hidden > 0 ? ` [+${node.hidden}]` : ''}`;
    function render(node, indent) {
      const ordered = [...node.children].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      for (const child of ordered) {
        lines.push(`${indent}${label(child)}`);
        if (child.isDirectory) render(child, `${indent}  `);
      }
    }
    lines.push(label(rootNode));
    render(rootNode, '  ');

    return JSON.stringify({
      relative_path: rel || '.',
      max_depth: maxDepth,
      entries_shown: shown,
      entries_hidden: hiddenTotal,
      truncated,
      tree: lines.join('\n'),
    });
  }

  async function readDirectory(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map(async (entry) => {
          const fullPath = path.join(dirPath, entry.name);
          let stats = null;
          try {
            stats = await fs.lstat(fullPath);
          } catch {
            // skip inaccessible files
          }
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: stats ? stats.size : 0,
            modified: stats ? stats.mtimeMs : 0,
          };
        })
    );

    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return items;
  }

  async function moveItem(sourcePath, destDir) {
    const srcStat = await fs.stat(sourcePath);
    const dstStat = await fs.stat(destDir);
    if (!dstStat.isDirectory()) {
      return { error: 'Ziel ist kein Ordner.' };
    }
    const baseName = path.basename(sourcePath);
    let targetPath = path.join(destDir, baseName);

    const srcParent = path.dirname(sourcePath);
    if (path.resolve(srcParent) === path.resolve(destDir)) {
      return { error: 'Quelle liegt bereits in diesem Ordner.' };
    }

    if (srcStat.isDirectory() && path.resolve(destDir).startsWith(path.resolve(sourcePath) + path.sep)) {
      return { error: 'Ordner kann nicht in sich selbst verschoben werden.' };
    }

    try {
      await fs.access(targetPath);
      const ext = path.extname(baseName);
      const nameNoExt = ext ? baseName.slice(0, -ext.length) : baseName;
      let i = 2;
      do {
        targetPath = path.join(destDir, `${nameNoExt} (${i})${ext}`);
        i++;
        try { await fs.access(targetPath); } catch { break; }
      } while (true);
    } catch {
      // target does not exist – good
    }

    await fs.rename(sourcePath, targetPath);
    return { ok: true, newPath: targetPath };
  }

  async function readFilePreview(filePath) {
    const stats = await fs.stat(filePath);
    const MAX_SIZE = 1024 * 1024; // 1 MB limit for preview
    if (stats.size > MAX_SIZE) {
      return { error: 'File too large for preview', size: stats.size };
    }
    const content = await fs.readFile(filePath, 'utf-8');
    return { content, size: stats.size, modified: stats.mtimeMs };
  }

  return {
    containsPath,
    resolveWorkspacePath,
    assertAbsolutePathInWorkspace,
    resolveExistingRealPath,
    assertPathAccessibleInWorkspace,
    resolveWorkspacePathForAccess,
    runListDirectoryTool,
    runReadFileTextTool,
    runReadFileLinesTool,
    runWriteFileTextTool,
    runEditFileTool,
    runApplyPatchTool,
    runSearchInFilesTool,
    runFindFilesTool,
    listWorkspacePaths,
    runStatPathTool,
    runOutlineFileTool,
    runListDirectoryTreeTool,
    readDirectory,
    moveItem,
    readFilePreview,
  };
}

module.exports = {
  createFsService,
};
