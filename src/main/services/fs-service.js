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
const OUTLINE_DEFAULT_MAX_ENTRIES = 200;
const OUTLINE_MAX_ENTRIES = 1000;
const OUTLINE_MAX_TEXT_CHARS = 200;
const OUTLINE_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.mdc']);
const OUTLINE_JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);

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

function clipSearchLine(line) {
  if (line.length <= SEARCH_MAX_LINE_CHARS) return line;
  return `${line.slice(0, SEARCH_MAX_LINE_CHARS)}…`;
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

function createFsService({
  fs,
  path,
  maxReadFileBytes,
  maxWriteFileBytes,
  maxSearchScannedFiles,
  maxReadSliceChars,
}) {
  const MAX_READ_FILE_BYTES = maxReadFileBytes;
  const MAX_WRITE_FILE_BYTES = maxWriteFileBytes || maxReadFileBytes;
  const MAX_SEARCH_SCANNED_FILES = maxSearchScannedFiles || SEARCH_DEFAULT_MAX_SCANNED_FILES;
  // Budget pro Ausschnitt: Zeichen im Zeilenmodus, Bytes im Byte-Modus.
  const MAX_READ_SLICE_CHARS = maxReadSliceChars || READ_SLICE_DEFAULT_MAX_CHARS;

  /** true, wenn candidate (aufgelöst) innerhalb von root liegt — Root selbst zählt mit. */
  function containsPath(root, candidate) {
    const rel = path.relative(path.resolve(root), path.resolve(candidate));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  function resolveWorkspacePath(workspaceRoot, relativePath) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      return { error: 'Kein Arbeitsordner geöffnet.' };
    }
    const root = path.resolve(workspaceRoot);
    const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
    const joined = path.resolve(root, raw.length ? raw : '.');
    if (!containsPath(root, joined)) {
      return { error: 'Pfad liegt außerhalb des Arbeitsordners.' };
    }
    return { absPath: joined };
  }

  function assertAbsolutePathInWorkspace(workspaceRoot, absPath) {
    if (!workspaceRoot) {
      return { error: 'Kein Arbeitsordner geöffnet.' };
    }
    const raw = typeof absPath === 'string' ? absPath.trim() : '';
    if (!raw) {
      return { error: 'Pfad ist erforderlich.' };
    }
    const resolved = path.resolve(raw);
    if (!containsPath(workspaceRoot, resolved)) {
      return { error: 'Pfad liegt außerhalb des Arbeitsordners.' };
    }
    return { absPath: resolved };
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

  async function assertPathAccessibleInWorkspace(workspaceRoot, absPath) {
    const lexical = assertAbsolutePathInWorkspace(workspaceRoot, absPath);
    if (lexical.error) return lexical;

    try {
      const realRoot = await fs.realpath(path.resolve(workspaceRoot));
      const realTarget = await resolveExistingRealPath(lexical.absPath);
      if (!containsPath(realRoot, realTarget)) {
        return { error: 'Pfad liegt außerhalb des Arbeitsordners.' };
      }
      return { absPath: lexical.absPath };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function resolveWorkspacePathForAccess(workspaceRoot, relativePath) {
    const lexical = resolveWorkspacePath(workspaceRoot, relativePath);
    if (lexical.error) return lexical;
    return assertPathAccessibleInWorkspace(workspaceRoot, lexical.absPath);
  }

  async function runListDirectoryTool(args, workspaceRoot) {
    const relArg = args.relative_path;
    const rel = typeof relArg === 'string' ? relArg : '';
    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
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

  async function runReadFileTextTool(args, workspaceRoot) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) {
      return JSON.stringify({ error: 'relative_path ist erforderlich.' });
    }
    let maxChars = Number.isFinite(args.max_characters) ? Math.floor(args.max_characters) : 32000;
    maxChars = Math.min(Math.max(1000, maxChars), 200000);
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

  async function runReadFileLinesTool(args, workspaceRoot) {
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
    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
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

  async function runSearchInFilesTool(args, workspaceRoot) {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query) {
      return JSON.stringify({ error: 'query ist erforderlich.' });
    }
    let matcher;
    try {
      matcher = new RegExp(
        args.is_regex === true ? query : escapeRegExpLiteral(query),
        args.case_sensitive === true ? '' : 'i'
      );
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
    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
    if (error) return JSON.stringify({ error });

    const root = path.resolve(workspaceRoot);
    const walkOptions = { root, includeHidden, isIgnored: await loadGitignoreMatcher(root) };

    const state = {
      matches: [],
      filesScanned: 0,
      filesVisited: 0,
      matchLimitReached: false,
      scanLimitReached: false,
    };
    const toRelPosix = (abs) => path.relative(root, abs).split(path.sep).join('/');

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
      const lines = buf.toString('utf8').split(/\r\n|\r|\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!matcher.test(lines[i])) continue;
        state.matches.push({
          file: relFile,
          line: i + 1,
          text: clipSearchLine(lines[i]),
          before: lines.slice(Math.max(0, i - contextLines), i).map(clipSearchLine),
          after: lines.slice(i + 1, i + 1 + contextLines).map(clipSearchLine),
        });
        if (state.matches.length >= maxResults) {
          state.matchLimitReached = true;
          return;
        }
      }
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
      return JSON.stringify({ error: e.message });
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

  async function runFindFilesTool(args, workspaceRoot) {
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
    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
    if (error) return JSON.stringify({ error });

    const root = path.resolve(workspaceRoot);
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
      state.results.push({ path: relEntry, kind: isDirectory ? 'directory' : 'file' });
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

  async function runStatPathTool(args, workspaceRoot) {
    const rel = typeof args.relative_path === 'string' ? args.relative_path.trim() : '';
    if (!rel) {
      return JSON.stringify({ error: 'relative_path ist erforderlich ("." für das Projektroot).' });
    }
    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
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

  async function runOutlineFileTool(args, workspaceRoot) {
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
    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
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

  async function runListDirectoryTreeTool(args, workspaceRoot) {
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

    const { absPath, error } = await resolveWorkspacePathForAccess(workspaceRoot, rel);
    if (error) return JSON.stringify({ error });
    try {
      const st = await fs.stat(absPath);
      if (!st.isDirectory()) {
        return JSON.stringify({ error: 'Pfad ist kein Ordner.' });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
    const root = path.resolve(workspaceRoot);
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
    runSearchInFilesTool,
    runFindFilesTool,
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
