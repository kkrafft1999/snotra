'use strict';

/**
 * The task set of the tool-accuracy benchmark (#186).
 *
 * Every task runs in a fresh copy of ./fixture. A positive task names the call
 * that serves the request; a negative task names what must *not* be called —
 * nothing at all, or no write, no execution, no network. Negatives are at
 * least a quarter of the set: without them over-triggering of the write tools
 * never shows, and that is what disappears first when boundary sentences go.
 *
 * `probes` names the sentence the cuts of #190/#192 removed (or moved into the
 * conventions block) that the task is aimed at — the targets are derived from
 * exactly those sentences, otherwise the benchmark measures past the damage.
 * Tasks without `probes` are controls for tools whose text barely changed.
 *
 * The prompts are user input, so they come in both languages the product
 * speaks; German is what the app is used in day to day.
 *
 * Expectation format:
 *   expect.call   { tool: name | [names], args?: { key: matcher } }
 *   expect.anyOf  [call, …]  — one of them is enough
 *   expect.allOf  [call, …]  — every one of them, in any order
 *   expect.files  { path: (content | null) => boolean }  — state afterwards
 *   expect.forbid [group | tool name, …]  — negative tasks
 * A matcher is a literal (compared after path normalisation for path keys), a
 * RegExp (tested against the string form) or a function (value, args) => bool.
 */

const WRITE = 'write';
const EXECUTE = 'execute';
const NETWORK = 'network';
const ANY = 'any';

const READ_FILE = ['read_file_text', 'read_file_lines'];
const EDIT = ['edit_file', 'apply_patch'];

const contains = (text) => (content) => typeof content === 'string' && content.includes(text);
const lacks = (pattern) => (content) => typeof content === 'string' && !pattern.test(content);
const json = (check) => (content) => {
  try {
    return check(JSON.parse(content));
  } catch {
    return false;
  }
};
const between = (lo, hi) => (value) => Number(value) >= lo && Number(value) <= hi;
const rootPath = (value) => value === undefined || value === '' || value === '.' || value === './';

const POSITIVE = [
  // list_directory — hidden entries and relative paths moved to the prompt (#183)
  {
    id: 'list-components',
    lang: 'de',
    prompt: 'Was liegt im Ordner src/components?',
    probes: 'list_directory: path relative to the project folder',
    expect: {
      anyOf: [
        { tool: 'list_directory', args: { relative_path: 'src/components' } },
        { tool: 'list_directory_tree', args: { relative_path: 'src/components' } },
        { tool: 'find_files', args: { pattern: /components/ } },
      ],
    },
  },
  {
    id: 'list-root',
    lang: 'en',
    prompt: 'List the top-level files and folders of the project.',
    probes: 'list_directory: empty string or "." for the project root',
    expect: {
      anyOf: [
        { tool: 'list_directory', args: { relative_path: rootPath } },
        { tool: 'list_directory_tree', args: { max_depth: 1 } },
      ],
    },
  },
  {
    id: 'list-hidden-github',
    lang: 'en',
    prompt: 'List the contents of the hidden .github folder.',
    probes: 'list_directory: without hidden entries, which start with a dot',
    expect: {
      anyOf: [
        { tool: 'list_directory', args: { relative_path: /^\.?\/?\.github/ } },
        { tool: 'list_directory_tree', args: { relative_path: /\.github/ } },
        { tool: 'list_directory_tree', args: { include_hidden: true } },
        { tool: 'find_files', args: { include_hidden: true } },
      ],
    },
  },

  // read_file_text — "only inside the project folder", 2 MB limit (#183)
  {
    id: 'read-package-json',
    lang: 'de',
    prompt: 'Zeig mir den Inhalt von package.json.',
    probes: 'read_file_text: relative path, e.g. "package.json"',
    expect: { call: { tool: READ_FILE, args: { relative_path: 'package.json' } } },
  },
  {
    id: 'read-settings',
    lang: 'en',
    prompt: "What's in config/settings.json?",
    expect: { call: { tool: READ_FILE, args: { relative_path: 'config/settings.json' } } },
  },
  {
    id: 'read-readme-options',
    lang: 'de',
    prompt: 'Lies die README und sag mir, welche Optionen das Tool hat.',
    expect: { call: { tool: READ_FILE, args: { relative_path: /^\.?\/?README\.md$/i } } },
  },
  {
    id: 'read-parser',
    lang: 'en',
    prompt: 'Read src/parser.js.',
    expect: { call: { tool: READ_FILE, args: { relative_path: 'src/parser.js' } } },
  },

  // read_file_lines — line/byte mode, numbering "matching search_in_files" (#183)
  {
    id: 'lines-events-range',
    lang: 'de',
    prompt: 'Zeig mir die Zeilen 300 bis 320 aus data/events.txt.',
    probes: 'read_file_lines: line range, 1-based, inclusive',
    expect: {
      call: {
        tool: 'read_file_lines',
        args: { relative_path: 'data/events.txt', start_line: 300, end_line: 320 },
      },
    },
  },
  {
    id: 'lines-invoice-head',
    lang: 'en',
    prompt: 'Show me lines 1-15 of src/invoice.js.',
    probes: 'read_file_lines: cheaper than read_file_text when only part is needed',
    expect: {
      call: {
        tool: 'read_file_lines',
        args: { relative_path: 'src/invoice.js', start_line: (v) => v === undefined || v === 1, end_line: 15 },
      },
    },
  },
  {
    id: 'lines-numbered',
    lang: 'en',
    prompt: 'Show lines 10 to 20 of src/invoice.js with their line numbers.',
    probes: 'read_file_lines: each line prefixed with its number',
    expect: {
      call: { tool: 'read_file_lines', args: { relative_path: 'src/invoice.js', start_line: 10, end_line: 20 } },
    },
  },
  {
    id: 'lines-single',
    lang: 'de',
    prompt: 'Was steht in data/events.txt in Zeile 777?',
    expect: {
      call: {
        tool: 'read_file_lines',
        args: { relative_path: 'data/events.txt', start_line: between(700, 777), end_line: between(777, 800) },
      },
    },
  },
  {
    id: 'bytes-sales-head',
    lang: 'en',
    prompt: 'Read the first 200 bytes of data/sales.csv.',
    probes: 'read_file_lines: byte range start_byte/length',
    expect: {
      call: {
        tool: 'read_file_lines',
        args: { relative_path: 'data/sales.csv', start_byte: (v) => v === undefined || v === 0, length: 200 },
      },
    },
  },
  {
    id: 'bytes-events-offset',
    lang: 'de',
    prompt: 'Zeig mir data/events.txt ab Byte 1000, und zwar 300 Bytes.',
    probes: 'read_file_lines: start_byte cannot be combined with start_line/end_line',
    expect: {
      call: {
        tool: 'read_file_lines',
        args: {
          relative_path: 'data/events.txt',
          start_byte: 1000,
          length: 300,
          start_line: (v) => v === undefined,
          end_line: (v) => v === undefined,
        },
      },
    },
  },
  {
    id: 'search-then-lines',
    lang: 'de',
    prompt:
      "Suche in data/events.txt nach 'user=u7 ' und zeig mir dann die drei Zeilen nach dem ersten Treffer.",
    probes: 'read_file_lines: numbering matches the hits of search_in_files',
    expect: {
      allOf: [
        { tool: 'search_in_files', args: { query: /u7/ } },
        { tool: 'read_file_lines', args: { relative_path: 'data/events.txt' } },
      ],
    },
  },

  // search_in_files — skips hidden/.gitignore/binary, regex limits, defaults (#183, #184)
  {
    id: 'search-usage',
    lang: 'de',
    prompt: 'Wo im Projekt wird calculateTotal verwendet?',
    expect: { call: { tool: 'search_in_files', args: { query: /calculateTotal/ } } },
  },
  {
    id: 'search-todo',
    lang: 'en',
    prompt: 'Find every TODO in the project.',
    expect: { call: { tool: 'search_in_files', args: { query: /TODO/i } } },
  },
  {
    id: 'search-ci-node-version',
    lang: 'de',
    prompt: 'Welche Node-Version verwendet die CI-Pipeline des Projekts?',
    probes: 'search_in_files: skips hidden entries',
    expect: {
      anyOf: [
        { tool: 'search_in_files', args: { include_hidden: true } },
        { tool: READ_FILE, args: { relative_path: /\.github\/workflows\/ci\.yml$/ } },
        { tool: 'find_files', args: { include_hidden: true } },
        { tool: 'list_directory_tree', args: { include_hidden: true } },
        { tool: 'list_directory', args: { relative_path: /\.github/ } },
      ],
    },
  },
  {
    id: 'search-hidden-explicit',
    lang: 'en',
    prompt: "Search for the string 'npm test' in all files, including hidden ones.",
    probes: 'search_in_files: include_hidden (.git always left out)',
    expect: {
      call: { tool: 'search_in_files', args: { query: /npm test/, include_hidden: true } },
    },
  },
  {
    id: 'search-regex-calculate',
    lang: 'de',
    prompt: "Suche per regulärem Ausdruck nach Funktionsdefinitionen, deren Name mit 'calculate' beginnt.",
    probes: 'search_in_files: is_regex, JavaScript syntax',
    expect: { call: { tool: 'search_in_files', args: { is_regex: true, query: /calculate/ } } },
  },
  {
    id: 'search-regex-tax-src',
    lang: 'en',
    prompt: 'Find lines matching the regex `TAX_\\w+` in src.',
    probes: 'search_in_files: starting folder or a single file',
    expect: {
      call: {
        tool: 'search_in_files',
        args: {
          is_regex: true,
          query: /TAX_/,
          relative_path: (v, args) => /^\.?\/?src\/?$/.test(v || '') || /src/.test(args.include || ''),
        },
      },
    },
  },
  {
    id: 'search-case-sensitive',
    lang: 'de',
    prompt: "Suche im Projekt nach 'Invoice' mit großem I – Groß- und Kleinschreibung beachten.",
    probes: 'search_in_files: case_sensitive (default false)',
    expect: { call: { tool: 'search_in_files', args: { query: /Invoice/, case_sensitive: true } } },
  },
  {
    id: 'search-include-md',
    lang: 'en',
    prompt: "Search for 'currency' but only in Markdown files.",
    probes: 'search_in_files: include glob, gitignore syntax',
    expect: { call: { tool: 'search_in_files', args: { query: /currency/i, include: /\.md/ } } },
  },
  {
    id: 'search-include-js',
    lang: 'de',
    prompt: "Durchsuche nur die JavaScript-Dateien nach 'require'.",
    probes: 'search_in_files: include glob, gitignore syntax',
    expect: { call: { tool: 'search_in_files', args: { query: /require/, include: /\.js/ } } },
  },
  {
    id: 'search-exclude-tests',
    lang: 'en',
    prompt: "Search all files except the tests for 'applyDiscount'.",
    probes: 'search_in_files: exclude glob skips files and folders',
    expect: { call: { tool: 'search_in_files', args: { query: /applyDiscount/, exclude: /test/ } } },
  },
  {
    id: 'search-src-only',
    lang: 'de',
    prompt: "Suche nach 'formatCurrency', aber nur im Ordner src.",
    expect: {
      call: {
        tool: 'search_in_files',
        args: {
          query: /formatCurrency/,
          relative_path: (v, args) => /^\.?\/?src\/?$/.test(v || '') || /src/.test(args.include || ''),
        },
      },
    },
  },
  {
    id: 'search-gitignored-dist',
    lang: 'en',
    prompt: 'Is calculateTotal also defined in the build output in dist/?',
    probes: 'search_in_files: skips patterns from the .gitignore of the project root',
    expect: {
      anyOf: [
        { tool: READ_FILE, args: { relative_path: /^\.?\/?dist\/bundle\.js$/ } },
        { tool: 'list_directory', args: { relative_path: /^\.?\/?dist\/?$/ } },
        { tool: 'shell_execute', args: { command: /dist/ } },
      ],
    },
  },
  {
    id: 'search-gitignored-logs',
    lang: 'de',
    prompt: 'Welche Fehler stehen in den Logdateien unter logs/?',
    probes: 'search_in_files: skips patterns from the .gitignore of the project root',
    expect: {
      anyOf: [
        { tool: READ_FILE, args: { relative_path: /^\.?\/?logs\/app\.log$/ } },
        { tool: 'list_directory', args: { relative_path: /^\.?\/?logs\/?$/ } },
        { tool: 'shell_execute', args: { command: /logs/ } },
      ],
    },
  },
  {
    id: 'search-context-5',
    lang: 'en',
    prompt: "Search for 'discount' with 5 lines of context around each hit.",
    probes: 'search_in_files: context_lines (default 2, maximum 10)',
    expect: { call: { tool: 'search_in_files', args: { query: /discount/i, context_lines: 5 } } },
  },
  {
    id: 'search-context-0',
    lang: 'en',
    prompt: "Search for 'Intl' in src and show the matching lines only, no context.",
    probes: 'search_in_files: context_lines (default 2)',
    expect: { call: { tool: 'search_in_files', args: { query: /Intl/, context_lines: 0 } } },
  },
  {
    id: 'search-max-3',
    lang: 'de',
    prompt: "Gib mir höchstens 3 Treffer für 'const' im Projekt.",
    probes: 'search_in_files: max_results (default 50)',
    expect: { call: { tool: 'search_in_files', args: { query: /const/, max_results: 3 } } },
  },
  {
    id: 'search-config-key',
    lang: 'de',
    prompt: "Finde heraus, wo 'paymentTermDays' konfiguriert ist, und zeig mir die Zeile.",
    expect: { call: { tool: 'search_in_files', args: { query: /paymentTermDays/ } } },
  },

  // find_files — anchoring, trailing slash, hidden, .gitignore (#183, #184)
  {
    id: 'find-markdown',
    lang: 'en',
    prompt: 'Find all Markdown files in the project.',
    expect: { call: { tool: 'find_files', args: { pattern: /\.md/ } } },
  },
  {
    id: 'find-components-folders',
    lang: 'de',
    prompt: "Welche Ordner im Projekt heißen 'components'? Nur Ordner, keine Dateien.",
    probes: 'find_files: a trailing / finds folders only',
    expect: { call: { tool: 'find_files', args: { pattern: /components\/$/ } } },
  },
  {
    id: 'find-anchored-src',
    lang: 'en',
    prompt: 'List the JavaScript files directly in src — not the ones in its subfolders.',
    probes: 'find_files: patterns containing / are anchored at the project root',
    expect: {
      anyOf: [
        { tool: 'find_files', args: { pattern: /^\/?src\/\*\.js$/ } },
        { tool: 'list_directory', args: { relative_path: /^\.?\/?src\/?$/ } },
      ],
    },
  },
  {
    id: 'find-hidden-files',
    lang: 'de',
    prompt: 'Finde alle versteckten Dateien im Projekt, also die mit einem Punkt am Anfang.',
    probes: 'find_files: skips hidden entries',
    expect: { call: { tool: 'find_files', args: { include_hidden: true } } },
  },
  {
    id: 'find-env-example',
    lang: 'en',
    prompt: 'Is there a .env.example file somewhere in the project?',
    probes: 'find_files: skips hidden entries',
    expect: {
      anyOf: [
        { tool: 'find_files', args: { include_hidden: true } },
        { tool: 'stat_path', args: { relative_path: /\.env\.example$/ } },
        { tool: 'list_directory_tree', args: { include_hidden: true } },
      ],
    },
  },
  {
    id: 'find-tests',
    lang: 'de',
    prompt: 'Finde alle Testdateien (*.test.js).',
    expect: { call: { tool: 'find_files', args: { pattern: /\.test\.js/ } } },
  },
  {
    id: 'find-docs-max-5',
    lang: 'en',
    prompt: 'Find files in the docs folder, at most 5 results.',
    probes: 'find_files: max_results (default 100)',
    expect: { call: { tool: 'find_files', args: { max_results: 5 } } },
  },
  {
    id: 'find-config-json',
    lang: 'de',
    prompt: 'Finde alle JSON-Dateien im Ordner config.',
    expect: {
      anyOf: [
        { tool: 'find_files', args: { pattern: /json/ } },
        { tool: 'list_directory', args: { relative_path: /^\.?\/?config\/?$/ } },
      ],
    },
  },
  {
    id: 'find-csv-txt',
    lang: 'en',
    prompt: 'Which files in the project end in .csv or .txt?',
    expect: { call: { tool: 'find_files', args: { pattern: /csv|txt/ } } },
  },

  // stat_path — controls, text barely changed
  {
    id: 'stat-size',
    lang: 'de',
    prompt: 'Wie groß ist die Datei data/events.txt?',
    expect: { call: { tool: 'stat_path', args: { relative_path: 'data/events.txt' } } },
  },
  {
    id: 'stat-line-count',
    lang: 'en',
    prompt: 'How many lines does src/invoice.js have?',
    expect: {
      call: { tool: 'stat_path', args: { relative_path: 'src/invoice.js', include_line_count: true } },
    },
  },
  {
    id: 'stat-line-count-csv',
    lang: 'de',
    prompt: 'Wie viele Zeilen hat data/sales.csv?',
    expect: {
      call: { tool: 'stat_path', args: { relative_path: 'data/sales.csv', include_line_count: true } },
    },
  },
  {
    id: 'stat-exists',
    lang: 'de',
    prompt: 'Gibt es im Projektroot eine Datei CHANGELOG.md?',
    expect: {
      anyOf: [
        { tool: 'stat_path', args: { relative_path: /CHANGELOG\.md$/i } },
        { tool: 'list_directory', args: { relative_path: rootPath } },
        { tool: 'find_files', args: { pattern: /changelog/i } },
      ],
    },
  },
  {
    id: 'stat-mtime',
    lang: 'en',
    prompt: 'When was package.json last modified?',
    expect: { call: { tool: 'stat_path', args: { relative_path: 'package.json' } } },
  },

  // outline_file — max_depth sentence removed (#183)
  {
    id: 'outline-architecture-chapters',
    lang: 'en',
    prompt:
      'What are the main chapters of docs/architecture.md? Only the level-2 headings, no subsections.',
    probes: 'outline_file: max_depth hides the deeper levels',
    expect: {
      call: { tool: 'outline_file', args: { relative_path: 'docs/architecture.md', max_depth: 2 } },
    },
  },
  {
    id: 'outline-setup-top',
    lang: 'de',
    prompt: 'Gib mir die Gliederung von docs/guide/setup.md, aber nur die oberste Ebene.',
    probes: 'outline_file: max_depth hides the deeper levels',
    expect: {
      call: { tool: 'outline_file', args: { relative_path: 'docs/guide/setup.md', max_depth: 1 } },
    },
  },
  {
    id: 'outline-functions',
    lang: 'de',
    prompt: 'Welche Funktionen und Klassen enthält src/invoice.js? Nur die Namen.',
    expect: { call: { tool: 'outline_file', args: { relative_path: 'src/invoice.js' } } },
  },
  {
    id: 'outline-readme',
    lang: 'en',
    prompt: 'Give me the outline of README.md.',
    expect: { call: { tool: 'outline_file', args: { relative_path: /^\.?\/?README\.md$/i } } },
  },
  {
    id: 'outline-max-entries',
    lang: 'en',
    prompt: 'Show me the outline of src/invoice.js, at most 3 entries.',
    probes: 'outline_file: max_entries (default 200)',
    expect: {
      call: { tool: 'outline_file', args: { relative_path: 'src/invoice.js', max_entries: 3 } },
    },
  },

  // list_directory_tree — breadth-first, hidden/.gitignore, defaults (#183, #184)
  {
    id: 'tree-depth-2',
    lang: 'en',
    prompt: 'Show me the project structure, two levels deep.',
    probes: 'list_directory_tree: max_depth (1 = direct entries only; default 3)',
    expect: { call: { tool: 'list_directory_tree', args: { max_depth: 2 } } },
  },
  {
    id: 'tree-overview',
    lang: 'de',
    prompt: 'Gib mir einen Überblick über die Ordnerstruktur des Projekts.',
    expect: { call: { tool: 'list_directory_tree' } },
  },
  {
    id: 'tree-hidden',
    lang: 'en',
    prompt: 'Show the folder tree, including hidden folders.',
    probes: 'list_directory_tree: skips hidden entries',
    expect: { call: { tool: 'list_directory_tree', args: { include_hidden: true } } },
  },
  {
    id: 'tree-src',
    lang: 'de',
    prompt: 'Zeig mir den Verzeichnisbaum unter src.',
    expect: { call: { tool: 'list_directory_tree', args: { relative_path: /^\.?\/?src\/?$/ } } },
  },

  // write_file_text — "inside the open project folder", 2 MB (#183)
  {
    id: 'write-faq',
    lang: 'de',
    prompt: "Leg eine Datei docs/faq.md mit der Überschrift 'FAQ' an.",
    expect: {
      call: { tool: 'write_file_text', args: { relative_path: 'docs/faq.md' } },
      files: { 'docs/faq.md': contains('FAQ') },
    },
  },
  {
    id: 'write-math',
    lang: 'en',
    prompt: 'Create a file src/utils/math.js that exports a function add(a, b).',
    expect: {
      call: { tool: 'write_file_text', args: { relative_path: 'src/utils/math.js' } },
      files: { 'src/utils/math.js': contains('add') },
    },
  },
  {
    id: 'write-replace-notes',
    lang: 'de',
    prompt: "Ersetze den kompletten Inhalt von notes.txt durch 'Alles erledigt.'",
    expect: {
      call: { tool: 'write_file_text', args: { relative_path: 'notes.txt' } },
      files: { 'notes.txt': (c) => typeof c === 'string' && c.trim() === 'Alles erledigt.' },
    },
  },
  {
    id: 'write-defaults-json',
    lang: 'en',
    prompt: 'Create config/defaults.json containing {"currency": "USD"}.',
    expect: {
      call: { tool: 'write_file_text', args: { relative_path: 'config/defaults.json' } },
      files: { 'config/defaults.json': json((v) => v.currency === 'USD') },
    },
  },
  {
    id: 'write-new-folder',
    lang: 'de',
    prompt: "Erstelle einen neuen Ordner scripts mit einer Datei build.js, die 'Building...' ausgibt.",
    probes: 'write_file_text: missing intermediate folders are created automatically',
    expect: {
      call: { tool: 'write_file_text', args: { relative_path: 'scripts/build.js' } },
      files: { 'scripts/build.js': contains('Building') },
    },
  },
  {
    id: 'write-roadmap-not-patch',
    lang: 'de',
    prompt: "Erstelle die Datei docs/roadmap.md mit dem Inhalt '# Roadmap'.",
    probes: 'apply_patch: cannot create files (write_file_text)',
    expect: {
      call: { tool: 'write_file_text', args: { relative_path: 'docs/roadmap.md' } },
      files: { 'docs/roadmap.md': contains('# Roadmap') },
    },
  },
  {
    id: 'write-test-file',
    lang: 'de',
    prompt: 'Lege test/date.test.js an, mit einem Test für addDays aus src/utils/date.js.',
    expect: {
      call: { tool: 'write_file_text', args: { relative_path: 'test/date.test.js' } },
      files: { 'test/date.test.js': contains('addDays') },
    },
  },

  // edit_file — exact and unique match, replace_all, more context (#183, #184)
  {
    id: 'edit-tax-rate',
    lang: 'en',
    prompt: 'In src/invoice.js, change TAX_RATE from 0.19 to 0.07.',
    expect: {
      call: { tool: EDIT, args: {} },
      files: { 'src/invoice.js': contains('TAX_RATE = 0.07') },
    },
  },
  {
    id: 'edit-version',
    lang: 'de',
    prompt: 'Ändere in package.json die Version auf 1.5.0.',
    expect: {
      call: { tool: EDIT },
      files: { 'package.json': json((v) => v.version === '1.5.0' && v.name === 'invoice-tool') },
    },
  },
  {
    id: 'edit-rename-in-file',
    lang: 'en',
    prompt: 'Rename the function formatDate to formatIsoDate in src/utils/date.js — every occurrence in that file.',
    probes: 'edit_file: with several matches set replace_all=true',
    expect: {
      call: { tool: EDIT },
      files: { 'src/utils/date.js': (c) => lacks(/\bformatDate\b/)(c) && /formatIsoDate/.test(c) },
    },
  },
  {
    id: 'edit-license',
    lang: 'de',
    prompt: "Ersetze in der README die Lizenz 'MIT' durch 'Apache-2.0'.",
    expect: {
      call: { tool: EDIT },
      files: { 'README.md': (c) => contains('Apache-2.0')(c) && !/\nMIT\n/.test(c) },
    },
  },
  {
    id: 'edit-settings',
    lang: 'en',
    prompt: 'In config/settings.json set paymentTermDays to 30.',
    expect: {
      call: { tool: EDIT },
      files: { 'config/settings.json': json((v) => v.paymentTermDays === 30 && v.taxRate === 0.19) },
    },
  },
  {
    id: 'edit-add-function',
    lang: 'de',
    prompt: 'Füge in src/utils/date.js eine Funktion subtractDays hinzu und exportiere sie.',
    expect: {
      call: { tool: EDIT },
      files: {
        'src/utils/date.js': (c) =>
          typeof c === 'string' && (c.match(/subtractDays/g) || []).length >= 2 && c.includes('addDays'),
      },
    },
  },
  {
    id: 'edit-message',
    lang: 'en',
    prompt:
      "In src/invoice.js the error message says 'Discount must be between 0 and 100'. Change it to " +
      "'Discount must be a percentage between 0 and 100'.",
    expect: {
      call: { tool: EDIT },
      files: { 'src/invoice.js': contains('Discount must be a percentage between 0 and 100') },
    },
  },
  {
    id: 'edit-delete-comment',
    lang: 'de',
    prompt: "Lösch in src/parser.js den Kommentar 'Parses the CSV export of the shop system. …'.",
    probes: 'edit_file: an empty string deletes the passage',
    expect: {
      call: { tool: EDIT },
      files: { 'src/parser.js': (c) => lacks(/Parses the CSV export/)(c) && c.includes('function parseSales') },
    },
  },
  {
    id: 'edit-setup-node',
    lang: 'de',
    prompt: "Ersetze in docs/guide/setup.md 'Node.js 20' durch 'Node.js 22'.",
    expect: { call: { tool: EDIT }, files: { 'docs/guide/setup.md': contains('Node.js 22') } },
  },
  {
    id: 'edit-hidden-ci',
    lang: 'en',
    prompt: 'In .github/workflows/ci.yml, bump node-version from 20 to 22.',
    expect: {
      call: { tool: EDIT, args: {} },
      files: { '.github/workflows/ci.yml': contains('node-version: 22') },
    },
  },
  {
    id: 'edit-top-comment',
    lang: 'de',
    prompt: "Schreib in src/index.js ganz oben einen Kommentar '// Entry point'.",
    expect: {
      call: { tool: EDIT },
      files: { 'src/index.js': (c) => contains('// Entry point')(c) && c.includes('function main') },
    },
  },
  {
    id: 'edit-changelog-section',
    lang: 'en',
    prompt: "In docs/changelog.md add a section '## 1.5.0' with '- Configurable tax rate.' above 1.4.2.",
    expect: {
      call: { tool: EDIT },
      files: {
        'docs/changelog.md': (c) =>
          typeof c === 'string' && c.indexOf('## 1.5.0') >= 0 && c.indexOf('## 1.5.0') < c.indexOf('## 1.4.2'),
      },
    },
  },

  // apply_patch — edits in order, unified diff format, atomic, cross-file (#184)
  {
    id: 'patch-rename-three',
    lang: 'en',
    prompt: 'In src/invoice.js, rename calculateTax to computeTax everywhere in that file (definition, call and export).',
    probes: 'apply_patch: edits applied in order, each step sees the previous one',
    expect: {
      call: { tool: EDIT },
      files: { 'src/invoice.js': (c) => lacks(/calculateTax/)(c) && (c.match(/computeTax/g) || []).length >= 3 },
    },
  },
  {
    id: 'patch-cross-file',
    lang: 'de',
    prompt: 'Benenne in src/invoice.js und src/index.js die Funktion calculateTotal in sumLines um.',
    probes: 'apply_patch: unified diff across several files',
    expect: {
      call: { tool: EDIT },
      files: {
        'src/invoice.js': (c) => lacks(/calculateTotal/)(c) && c.includes('sumLines'),
        'src/index.js': (c) => lacks(/calculateTotal/)(c) && c.includes('sumLines'),
      },
    },
  },
  {
    id: 'patch-apply-diff',
    lang: 'en',
    prompt:
      'Apply this diff:\n\n```diff\n--- a/src/utils/currency.js\n+++ b/src/utils/currency.js\n' +
      '@@ -3,3 +3,3 @@\n function formatCurrency(amount, currency) {\n' +
      "-  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount);\n" +
      "+  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);\n }\n```",
    probes: 'apply_patch: unified diff format, hunks, context must match',
    expect: {
      call: { tool: 'apply_patch', args: { patch: /en-US/ } },
      files: { 'src/utils/currency.js': (c) => contains("'en-US'")(c) && !c.includes("'de-DE'") },
    },
  },
  {
    id: 'patch-two-edits',
    lang: 'de',
    prompt:
      'In src/invoice.js: setze TAX_RATE auf 0.2 und benenne applyDiscount in withDiscount um – beides in einem Rutsch.',
    probes: 'apply_patch: several related edits in one call',
    expect: {
      call: { tool: 'apply_patch' },
      files: {
        'src/invoice.js': (c) => contains('TAX_RATE = 0.2')(c) && lacks(/applyDiscount/)(c) && c.includes('withDiscount'),
      },
    },
  },
  {
    id: 'patch-unified-diff-request',
    lang: 'en',
    prompt: "Use a unified diff to change the version in package.json to 2.0.0 and the description to 'Invoice CLI'.",
    probes: 'apply_patch: patch mode, paths in the "+++" header lines',
    expect: {
      call: { tool: 'apply_patch', args: { patch: /\+\+\+/ } },
      files: { 'package.json': json((v) => v.version === '2.0.0' && v.description === 'Invoice CLI') },
    },
  },

  // run_python — control, text only translated
  {
    id: 'python-revenue',
    lang: 'de',
    prompt: 'Was ist der Gesamtumsatz (quantity × unit_price) in data/sales.csv?',
    expect: { call: { tool: ['run_python', 'shell_execute'], args: {} } },
  },
  {
    id: 'python-rows-per-region',
    lang: 'en',
    prompt: 'How many rows per region are in data/sales.csv?',
    expect: { call: { tool: ['run_python', 'shell_execute'] } },
  },
  {
    id: 'python-regex-check',
    lang: 'de',
    prompt: "Prüfe, ob der reguläre Ausdruck ^INV-\\d{4}$ auf 'INV-0042' passt.",
    expect: { call: { tool: 'run_python', args: { code: /INV/ } } },
  },
  {
    id: 'python-csv-json',
    lang: 'en',
    prompt: 'Convert data/sales.csv to JSON and print the first 3 records.',
    expect: { call: { tool: ['run_python', 'shell_execute'] } },
  },
  {
    id: 'python-average',
    lang: 'de',
    prompt: 'Berechne den Durchschnitt von duration_ms in data/events.txt.',
    expect: { call: { tool: ['run_python', 'shell_execute'] } },
  },

  // shell_execute — control; cwd prose changed (#184)
  {
    id: 'shell-tests',
    lang: 'en',
    prompt: 'Run the tests.',
    expect: { call: { tool: 'shell_execute', args: { command: /npm (run )?test|node --test/ } } },
  },
  {
    id: 'shell-git-status',
    lang: 'de',
    prompt: 'Was sagt git status?',
    expect: { call: { tool: 'shell_execute', args: { command: /git status/ } } },
  },
  {
    id: 'shell-install',
    lang: 'en',
    prompt: 'Install the dependencies.',
    expect: { call: { tool: 'shell_execute', args: { command: /npm (ci|install|i)\b/ } } },
  },
  {
    id: 'shell-build',
    lang: 'de',
    prompt: "Führe 'npm run build' im Projekt aus.",
    expect: { call: { tool: 'shell_execute', args: { command: /npm run build/ } } },
  },
  {
    id: 'shell-git-log',
    lang: 'en',
    prompt: 'Show me the last 5 git commits.',
    expect: { call: { tool: 'shell_execute', args: { command: /git log/ } } },
  },
  {
    id: 'shell-node-version',
    lang: 'de',
    prompt: 'Welche Node-Version ist auf diesem Rechner installiert?',
    expect: { call: { tool: 'shell_execute', args: { command: /node (-v|--version)/ } } },
  },
  {
    id: 'shell-cwd',
    lang: 'en',
    prompt: 'List the files in the docs folder with `ls -la`, run from inside docs.',
    probes: 'shell_execute: cwd, a subfolder of the project folder',
    expect: {
      call: {
        tool: 'shell_execute',
        args: { command: /ls -la/, cwd: (v, args) => /docs/.test(v || '') || /cd docs/.test(args.command) },
      },
    },
  },

  // web_search / fetch_url — the boundary between the two lives in the prompt lines (#182)
  {
    id: 'web-node-lts',
    lang: 'en',
    prompt: 'What is the latest LTS version of Node.js?',
    expect: { call: { tool: 'web_search' } },
  },
  {
    id: 'web-csv-parse-vulns',
    lang: 'de',
    prompt: 'Gibt es aktuelle Sicherheitslücken in csv-parse? Such mal im Netz.',
    expect: { call: { tool: 'web_search', args: { query: /csv-parse/ } } },
  },
  {
    id: 'web-intl-chf',
    lang: 'en',
    prompt: 'Search the web for how to format Swiss francs with Intl.NumberFormat.',
    expect: { call: { tool: 'web_search' } },
  },
  {
    id: 'fetch-example',
    lang: 'de',
    prompt: 'Lies https://example.org/changelog und fass die Seite zusammen.',
    probes: 'web_search: not meant for reading a page in full',
    expect: { call: { tool: 'fetch_url', args: { url: 'https://example.org/changelog' } } },
  },
  {
    id: 'fetch-node-releases',
    lang: 'en',
    prompt: 'Fetch https://nodejs.org/en/about/previous-releases and tell me the end-of-life date of Node 20.',
    probes: 'web_search: not meant for reading a page in full',
    expect: { call: { tool: 'fetch_url', args: { url: /nodejs\.org\/en\/about\/previous-releases/ } } },
  },
  {
    id: 'web-then-fetch',
    lang: 'de',
    prompt: 'Such im Web nach dem Changelog von csv-parse und lies dann die Seite im Volltext.',
    probes: 'fetch_url: for content beyond the short excerpt from web_search',
    expect: { allOf: [{ tool: 'web_search' }, { tool: 'fetch_url' }] },
  },

  // Tools added after the cuts — identical in both arms, controls
  {
    id: 'extract-pdf-page',
    lang: 'de',
    prompt: 'Was steht in contracts/offer.pdf auf Seite 2?',
    expect: {
      call: { tool: 'extract_document_text', args: { relative_path: 'contracts/offer.pdf', pages: /^2/ } },
    },
  },
  {
    id: 'image-logo',
    lang: 'en',
    prompt: 'Create a logo for the invoice tool and save it as assets/logo.png.',
    expect: { call: { tool: 'generate_image', args: { relative_path: 'assets/logo.png' } } },
  },
  {
    id: 'remember-workspace',
    lang: 'de',
    prompt: 'Merk dir für dieses Projekt: Die Tests laufen mit npm test.',
    expect: { call: { tool: 'remember', args: { scope: 'workspace', origin: 'requested' } } },
  },
].map((task) => ({ ...task, kind: 'positive' }));

const NEGATIVE = [
  // Nothing to do with the folder — any tool call is over-triggering.
  { id: 'neg-git-rebase', lang: 'en', prompt: 'What does `git rebase` do, in two sentences?', forbid: [ANY] },
  { id: 'neg-let-const', lang: 'de', prompt: 'Erklär mir kurz den Unterschied zwischen let und const in JavaScript.', forbid: [ANY] },
  { id: 'neg-translate', lang: 'en', prompt: "Translate 'Payable within 14 days' into German.", forbid: [ANY] },
  { id: 'neg-unified-diff', lang: 'de', prompt: 'Was ist ein unified diff?', forbid: [ANY] },
  { id: 'neg-thanks', lang: 'en', prompt: "Thanks, that's all for now.", forbid: [ANY] },
  { id: 'neg-typescript', lang: 'de', prompt: 'Welche Vorteile hat TypeScript gegenüber JavaScript?', forbid: [ANY] },
  { id: 'neg-names', lang: 'en', prompt: 'Give me three name ideas for an invoicing CLI.', forbid: [ANY] },
  { id: 'neg-reminder-mail', lang: 'de', prompt: 'Formuliere eine freundliche Zahlungserinnerung als E-Mail-Text.', forbid: [ANY] },
  {
    id: 'neg-review-snippet',
    lang: 'en',
    prompt: "Here is a function:\n\n```js\nfunction add(a, b) { return a - b; }\n```\n\nWhat's wrong with it?",
    forbid: [ANY],
  },
  { id: 'neg-capital', lang: 'de', prompt: 'Was ist die Hauptstadt von Australien?', forbid: [ANY] },
  { id: 'neg-squash', lang: 'en', prompt: "What's the difference between a merge and a squash merge?", forbid: [ANY] },
  {
    id: 'neg-regex-pattern',
    lang: 'en',
    prompt: 'Write a regex that matches invoice numbers like INV-0042. Just give me the pattern.',
    forbid: [WRITE, NETWORK, 'shell_execute'],
  },

  // Reading is fine, writing is not — the over-triggering the issue is about.
  {
    id: 'neg-explain-change',
    lang: 'de',
    prompt: 'Was müsste ich in src/invoice.js ändern, um den Steuersatz konfigurierbar zu machen? Noch nichts ändern, nur erklären.',
    forbid: [WRITE],
  },
  { id: 'neg-review-parser', lang: 'en', prompt: "Review src/parser.js and tell me what could break. Don't change anything.", forbid: [WRITE] },
  {
    id: 'neg-draft-in-chat',
    lang: 'en',
    prompt: "Draft a short README section about the --discount option here in the chat; I'll paste it myself.",
    forbid: [WRITE],
  },
  { id: 'neg-suggest-message', lang: 'de', prompt: 'Schlag mir eine bessere Formulierung für die Fehlermeldung in applyDiscount vor.', forbid: [WRITE] },
  {
    id: 'neg-show-diff',
    lang: 'en',
    prompt: "How would a unified diff look that changes TAX_RATE in src/invoice.js to 0.07? Show it, don't apply it.",
    forbid: [WRITE],
  },
  { id: 'neg-check-date', lang: 'de', prompt: 'Ist der Code in src/utils/date.js korrekt? Nur prüfen.', forbid: [WRITE] },
  { id: 'neg-explain-index', lang: 'en', prompt: 'Explain what src/index.js does.', forbid: [WRITE] },
  { id: 'neg-missing-tests', lang: 'de', prompt: 'Welche Tests fehlen noch für src/invoice.js? Liste sie auf.', forbid: [WRITE] },
  { id: 'neg-opinion-config', lang: 'en', prompt: 'Should the tax rate live in config/settings.json? What do you think?', forbid: [WRITE] },
  { id: 'neg-gitignore-line', lang: 'de', prompt: 'Zeig mir, wie eine .gitignore-Zeile für einen coverage-Ordner aussehen würde.', forbid: [WRITE] },
  { id: 'neg-changelog-check', lang: 'en', prompt: 'Can you check whether docs/changelog.md is up to date with package.json?', forbid: [WRITE] },
  { id: 'neg-rename-opinion', lang: 'de', prompt: 'Ich überlege, calculateTotal in sumLines umzubenennen. Was hältst du davon?', forbid: [WRITE] },
  { id: 'neg-plan-only', lang: 'en', prompt: 'Outline a plan for adding multi-currency support. No code changes yet.', forbid: [WRITE] },
  { id: 'neg-doc-vs-code', lang: 'de', prompt: 'Vergleiche docs/architecture.md mit dem Code. Stimmt die Beschreibung?', forbid: [WRITE] },

  // The answer is in the files — no command, no network, no write.
  { id: 'neg-project-version', lang: 'en', prompt: 'What version is this project?', forbid: [WRITE, EXECUTE, NETWORK] },
  { id: 'neg-dependencies', lang: 'de', prompt: 'Welche Abhängigkeiten hat das Projekt?', forbid: [WRITE, EXECUTE, NETWORK] },
  { id: 'neg-test-runner', lang: 'en', prompt: 'Which test runner does this project use?', forbid: [WRITE, EXECUTE, NETWORK] },
  { id: 'neg-license', lang: 'de', prompt: 'Unter welcher Lizenz steht das Projekt?', forbid: [WRITE, EXECUTE, NETWORK] },
  { id: 'neg-currency-default', lang: 'en', prompt: 'What does the --currency option default to?', forbid: [WRITE, EXECUTE, NETWORK] },
  { id: 'neg-required-node', lang: 'de', prompt: 'Steht im Projekt irgendwo, welche Node-Version gebraucht wird?', forbid: [WRITE, EXECUTE, NETWORK] },
  {
    id: 'neg-no-run',
    lang: 'en',
    prompt: 'Without running anything: would `npm test` pick up test/invoice.test.js?',
    forbid: [WRITE, EXECUTE],
  },
  { id: 'neg-no-remember', lang: 'de', prompt: 'Merk dir das bitte nicht, aber: Ich mag kurze Antworten.', forbid: ['remember', WRITE] },
  {
    id: 'neg-no-image',
    lang: 'en',
    prompt: "Don't generate an image — just describe what a good logo for this tool could look like.",
    forbid: ['generate_image', WRITE],
  },
  { id: 'neg-no-search', lang: 'de', prompt: 'Ohne im Internet zu suchen: Was ist der Unterschied zwischen npm ci und npm install?', forbid: [ANY] },
].map((task) => ({ ...task, kind: 'negative' }));

const TASKS = [...POSITIVE, ...NEGATIVE];

module.exports = { TASKS, WRITE, EXECUTE, NETWORK, ANY };
