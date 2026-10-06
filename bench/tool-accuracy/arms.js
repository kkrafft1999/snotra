'use strict';

/**
 * The two arms of the benchmark (#186).
 *
 * `current` is the app as it ships: the tool schemas and the conventions block
 * from the registry, untouched.
 *
 * `uncut` puts back what #190 (#182, #183) and #192 (#184) took out, so that
 * the difference between the arms is the cuts and nothing else:
 *
 * - The sentences those pull requests deleted from descriptions and parameter
 *   descriptions are back — translated, because the schemas went English with
 *   #279 after the cuts. The source is the registry at bcbdd36a, the last
 *   commit before #190.
 * - Limits and defaults are prose again instead of `default` / `maximum` /
 *   `maxItems` / `maxLength` keywords, as they were before #184.
 * - The system prompt carries the prose tool list again instead of the
 *   conventions block.
 *
 * Deliberately not restored: the "use write tools sparingly" sentence of the old
 * prompt. #269 removed it later for a reason of its own (it stopped some models
 * from writing at all), so it is not part of the cuts under test. Everything
 * that was added to a tool after the cuts — the entry cap of list_directory,
 * the sandbox paragraphs, network_domains — stays in both arms. The three tools
 * that did not exist before the cuts (extract_document_text, generate_image,
 * remember) are identical in both arms; only their line in the prose list is
 * new, written in the style of the old ones.
 */

const LIMIT_KEYWORDS = ['default', 'maximum', 'maxItems', 'maxLength'];

const UNCUT_TOOLS = {
  list_directory: {
    description:
      'Lists the files and subfolders of a directory relative to the open project folder, folders ' +
      'first (without hidden entries, which start with a dot). At most 1000 entries; a longer list ' +
      'is cut and marked `truncated` with the number of `entries_hidden` — then narrow down to a ' +
      'subfolder or use find_files.',
    params: {
      relative_path: 'Relative path to the folder; empty string or "." for the project root.',
    },
  },
  read_file_text: {
    description:
      'Reads the text content of a file as UTF-8 (only inside the project folder). Maximum file ' +
      'size: 2 MB — larger files return an error.',
    params: {
      relative_path: 'Relative path to the file, e.g. "package.json" or "src/app.js".',
      max_characters:
        'Maximum number of characters in the returned text (default 32000, upper limit 200000).',
    },
  },
  read_file_lines: {
    description:
      'Reads a targeted slice of a text file (UTF-8, only inside the project folder): either a line ' +
      'range (start_line/end_line, 1-based, inclusive) or a byte range (start_byte/length). In line ' +
      'mode each line is prefixed with its line number plus a tab — matching the hits from ' +
      'search_in_files. Cheaper in tokens than read_file_text when only part of the file is needed. ' +
      'Maximum file size: 2 MB.',
    params: {
      relative_path: 'Relative path to the file, e.g. "src/app.js".',
      start_line:
        'First line of the slice (1-based, default 1). Cannot be combined with start_byte/length.',
      end_line: 'Last line (inclusive; default start_line + 199, at most 1000 lines per call).',
      start_byte:
        'Byte offset (0-based) to start reading from. Cannot be combined with start_line/end_line.',
      length: 'Number of bytes from start_byte (default 16000, upper limit 32000).',
    },
  },
  search_in_files: {
    description:
      'Searches text files in the project folder recursively for a search string or regular ' +
      'expression and returns only the matching lines with line number and context — instead of ' +
      'whole files. Skips hidden entries, patterns from the .gitignore of the project root as well ' +
      'as binary and oversized files. Each line is only checked up to 10,000 characters; regular ' +
      'expressions run with a time budget of 5 s per search.',
    params: {
      query:
        'Search string; with is_regex=true a regular expression in JavaScript syntax (at most 256 ' +
        'characters, no nested unbounded repetitions such as "(a+)+" — such patterns are rejected).',
      is_regex: 'true to interpret query as a regular expression (default false = literal search).',
      relative_path:
        'Starting folder (or single file) relative to the project root; empty or "." for the whole ' +
        'project.',
      context_lines:
        'Number of context lines before and after each matching line (default 2, maximum 10).',
      max_results: 'Maximum number of hits (default 50, upper limit 200).',
      case_sensitive: 'true to match upper and lower case (default false).',
      include:
        'Optional glob pattern (gitignore syntax); only matching files are searched, e.g. "*.js" or ' +
        '"src/**/*.md".',
      exclude:
        'Optional glob pattern (gitignore syntax); matching files and folders are skipped, e.g. ' +
        '"dist" or "*.min.js".',
      include_hidden:
        'true to search hidden entries (dot prefix) as well (default false; .git is always left out).',
    },
  },
  find_files: {
    description:
      'Finds files and folders in the project folder recursively by glob pattern and returns the ' +
      'paths only — one call instead of many list_directory rounds. Patterns in gitignore syntax ' +
      '(*, ?, **); patterns containing / are anchored at the project root, a trailing / finds ' +
      'folders only. Skips hidden entries, patterns from the .gitignore of the project root as well ' +
      'as .git.',
    params: {
      pattern:
        'Glob pattern (gitignore syntax: *, ?, **, [abc], [a-z], [!x]), e.g. "*.md", "src/**/*.js", ' +
        '"*.[jt]s" or "components/"; matched against the path relative to the project root.',
      relative_path:
        'Starting folder relative to the project root; empty or "." for the whole project.',
      max_results: 'Maximum number of paths found (default 100, upper limit 500).',
      include_hidden:
        'true to find hidden entries (dot prefix) as well (default false; .git is always left out).',
    },
  },
  stat_path: {
    description:
      'Returns metadata about a path in the project folder without reading the file: existence, ' +
      'type (file/folder), size in bytes, modification time (ISO 8601) and, on request, the line ' +
      'count. Cheap in tokens for deciding whether and how to read before reading — e.g. ' +
      'read_file_lines instead of read_file_text for large files.',
    params: {
      relative_path:
        'Relative path to a file or folder, e.g. "src/app.js"; "." for the project root.',
      include_line_count:
        'true to additionally return the line count for text files (default false).',
    },
  },
  outline_file: {
    description:
      'Returns the outline of a file in the project folder with line numbers without reading its ' +
      'content: for Markdown the headings (levels 1-6), for code the function, method, class and ' +
      'type signatures (level derived from indentation, generic heuristic). A cheap map for then ' +
      'reading just the relevant section with read_file_lines. max_depth hides the deeper levels.',
    params: {
      relative_path: 'Relative path to the file, e.g. "docs/concept.md" or "src/app.js".',
      max_entries:
        'Maximum number of entries (default 200, at most 1000); beyond that truncated=true is ' +
        'reported.',
    },
  },
  list_directory_tree: {
    description:
      'Returns a compact recursive folder tree of the project folder in one call instead of many ' +
      'list_directory rounds. Text tree with indentation; folders end in "/". "[+N]" after a folder ' +
      'means: N direct entries are not shown (max_depth or max_entries reached). Breadth-first, so ' +
      'that with a tight budget the upper levels are complete first. Skips hidden entries, patterns ' +
      'from the .gitignore of the project root as well as .git; does not follow symlinks.',
    params: {
      relative_path:
        'Starting folder relative to the project root; empty or "." for the whole project.',
      max_depth:
        'Maximum depth (1 = direct entries only; default 3, upper limit 10). Deeper folders appear ' +
        'with [+N].',
      max_entries:
        'Maximum number of entries shown in total (default 200, upper limit 1000); beyond that ' +
        'truncated=true.',
      include_hidden:
        'true to show hidden entries (dot prefix) as well (default false; .git is always left out).',
    },
  },
  write_file_text: {
    description:
      'Creates or overwrites a text file (UTF-8) inside the open project folder. Missing ' +
      'intermediate folders are created automatically. Replaces any existing content entirely. ' +
      'Maximum content size: 2 MB.',
    params: {
      relative_path: 'Relative path to the target file, e.g. "src/notes.md" or "docs/new.md".',
    },
  },
  edit_file: {
    description:
      'Replaces one specific passage in a text file (UTF-8, only inside the project folder): ' +
      'old_string is replaced by new_string, without rewriting the whole file. old_string must ' +
      'occur exactly and uniquely — including indentation and line breaks; with several matches ' +
      'give more context or set replace_all=true. Maximum file size: 2 MB.',
    params: {
      relative_path: 'Relative path to the file, e.g. "src/app.js".',
      old_string:
        'The exact text to replace; must occur uniquely in the file — include surrounding lines if ' +
        'needed.',
      replace_all:
        'true to replace every occurrence (default false = exactly one unique match required).',
    },
  },
  apply_patch: {
    description:
      'Changes existing text files (UTF-8, only inside the project folder) with several related ' +
      'edits in one call — either as a list of replacements (edits, all in the same file, applied ' +
      'in this order) or as a unified diff (patch, also across several files). All or nothing: if ' +
      'a step or a hunk fails, every affected file stays unchanged. Each file is replaced ' +
      'atomically on its own (never half-written); across several files that does not hold — if a ' +
      'write fails, the files already written are restored. For a single replacement edit_file is ' +
      'simpler. apply_patch cannot create files (write_file_text), delete them or rename them. ' +
      'Maximum file size: 2 MB.',
    params: {
      relative_path:
        'Relative path to the file, e.g. "src/app.js". Required in edits mode; unnecessary in patch ' +
        'mode, because the paths are in the "+++" header lines of the diff.',
      edits:
        'Replacements in relative_path, applied in order (at most 50). Each step sees the result ' +
        'of the previous ones. Cannot be combined with patch.',
      'edits[].old_string':
        'The exact text to replace; must occur uniquely at the time of this step — include ' +
        'surrounding lines if needed.',
      'edits[].replace_all':
        'true to replace every occurrence in this step (default false = exactly one unique match ' +
        'required).',
      patch:
        'Unified diff as text: per file "--- old" and "+++ new" (a/ and b/ prefixes allowed), below ' +
        'that hunks "@@ -oldLine,count +newLine,count @@" with body lines beginning with " " ' +
        '(unchanged), "-" (removed) or "+" (added). The line numbers may be slightly off, the ' +
        'context must match exactly. Cannot be combined with edits.',
    },
  },
  run_python: {
    params: {
      timeout_ms: 'Time limit in milliseconds (default 10000, upper limit 120000).',
    },
  },
  shell_execute: {
    params: {
      cwd:
        'Optional subfolder of the project folder as working directory, given relative (e.g. ' +
        '"frontend"). Without it the command runs in the project folder.',
      timeout_ms: 'Time limit in milliseconds (default 30000, upper limit 300000).',
    },
  },
  web_search: {
    params: {
      query: 'Search query in natural language or as keywords (at most 400 characters).',
      max_results: 'Maximum number of hits (default 5, upper limit 10).',
    },
  },
  fetch_url: {
    params: {
      max_characters:
        'Maximum number of characters in the returned text (default 20000, upper limit 100000).',
    },
  },
};

/** The lines of the old prose tool list (registry `promptDescription`s at bcbdd36a). */
const UNCUT_PROMPT_LINES = {
  list_directory: 'Lists files and subfolders in the project folder.',
  read_file_text: 'Reads text files inside the project folder.',
  read_file_lines:
    'Reads line or byte slices of text files in the project folder (lines numbered).',
  search_in_files:
    'Searches text or regex in files of the project folder and returns file, line and context of ' +
    'the hits.',
  find_files: 'Finds file and folder paths in the project folder by glob pattern (e.g. "**/*.js").',
  stat_path:
    'Returns metadata (existence, type, size, modification time, optionally line count) for paths ' +
    'in the project folder, without file content.',
  outline_file:
    'Returns the outline of a file (Markdown headings or function/class signatures) with line ' +
    'numbers, without the full text.',
  list_directory_tree:
    'Returns a compact recursive folder tree of the project folder (depth and size can be limited) ' +
    'in one call.',
  write_file_text: 'Creates or overwrites text files in the project folder.',
  edit_file:
    'Replaces specific passages in files of the project folder (old_string → new_string) without ' +
    'rewriting the whole file.',
  apply_patch:
    'Applies several related changes (edits list or unified diff) atomically to files of the ' +
    'project folder.',
  run_python:
    'Runs Python 3 code and returns output and exit code. Use it to calculate and check instead ' +
    'of estimating results yourself.',
  shell_execute:
    'Runs a command in the operating system shell (git, npm, installed CLI tools) and returns ' +
    'output and exit code.',
  web_search:
    'Searches the web and returns title, URL and a short excerpt per hit. It is not meant for ' +
    'reading a page in full.',
  fetch_url:
    'Reads a web page as text. For content that goes beyond the short excerpt from web_search.',
  // Added after the cuts; written in the style of the lines above.
  extract_document_text: 'Extracts the text of PDF, DOCX, XLSX and PPTX files in the project folder.',
  generate_image: 'Generates an image from a text prompt and saves it as a file in the project folder.',
  remember: 'Remembers a lasting statement for later chats, for this folder or everywhere.',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripLimitKeywords(schema) {
  if (!schema || typeof schema !== 'object') return;
  for (const key of LIMIT_KEYWORDS) delete schema[key];
  for (const child of Object.values(schema.properties || {})) stripLimitKeywords(child);
  if (schema.items) stripLimitKeywords(schema.items);
}

/** Looks up "edits[].old_string"-style paths in a parameters schema. */
function propertyAt(parameters, dottedPath) {
  let node = parameters;
  for (const part of dottedPath.split('.')) {
    const isItem = part.endsWith('[]');
    const name = isItem ? part.slice(0, -2) : part;
    node = node?.properties?.[name];
    if (isItem) node = node?.items;
  }
  return node || null;
}

function applyUncutTool(tool) {
  const overlay = UNCUT_TOOLS[tool.function.name];
  if (!overlay) return tool;
  const fn = clone(tool.function);
  if (overlay.description) fn.description = overlay.description;
  stripLimitKeywords(fn.parameters);
  for (const [dottedPath, text] of Object.entries(overlay.params || {})) {
    const property = propertyAt(fn.parameters, dottedPath);
    if (!property) {
      throw new Error(`uncut arm: ${fn.name} has no parameter ${dottedPath} — update arms.js`);
    }
    property.description = text;
  }
  return { ...tool, function: fn };
}

function buildUncutToolsPrompt(toolNames) {
  if (toolNames.length === 0) return '';
  const lines = toolNames.map((name) => {
    const line = UNCUT_PROMPT_LINES[name];
    if (!line) throw new Error(`uncut arm: no prompt line for ${name} — update arms.js`);
    return `- ${name}: ${line}`;
  });
  return (
    `You have the following tools:\n${lines.join('\n')}\n` +
    'For file tools use only paths relative to the folder root (e.g. "" or "." for the root, ' +
    '"src/index.js" for a file).'
  );
}

/**
 * Wraps the registry so that the engine sees the arm's schemas and prompt.
 * Everything else — planning, policy, argument validation (#187) — keeps
 * working on the real definitions, the same in both arms.
 */
function wrapRegistryForArm(registry, arm) {
  if (arm === 'current') return registry;
  if (arm !== 'uncut') throw new Error(`Unknown arm: ${arm}`);
  return {
    ...registry,
    getTools(options) {
      return registry.getTools(options).map(applyUncutTool);
    },
    buildSystemPrompt(options) {
      if (options?.workspaceOpen === false) return registry.buildSystemPrompt(options);
      return buildUncutToolsPrompt(registry.getTools(options).map((tool) => tool.function.name));
    },
  };
}

const ARMS = ['current', 'uncut'];

module.exports = {
  ARMS,
  UNCUT_TOOLS,
  UNCUT_PROMPT_LINES,
  wrapRegistryForArm,
  propertyAt,
};
