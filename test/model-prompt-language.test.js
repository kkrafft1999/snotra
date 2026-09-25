const test = require('node:test');
const assert = require('node:assert/strict');

// Was an das Modell geht, ist seit #276 englisch — der Bildschirm bleibt
// deutsch. Die Trennung haelt nicht von selbst: ein neues Tool erbt ohne
// `modelDescription` stillschweigend die deutsche `description`, und ein neuer
// Ablehnungsgrund faellt im Modell-Kanal auf `undefined` zurueck. Beides sieht
// man dem Diff nicht an und im Chat erst, wenn ein englischsprachiger Nutzer
// eine deutsche Antwort bekommt. Deshalb diese Datei.

const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { buildEnvironmentSystemPrompt } = require('../src/application/chat/environment-prompt');
const { buildMemorySystemPrompt } = require('../src/application/chat/memory-prompt');
const {
  buildProjectInstructionsSystemPrompt,
} = require('../src/application/chat/project-instructions-prompt');
const { MEMORY_SCOPES } = require('../src/shared/contracts/memory');
const { PROJECT_INSTRUCTION_SOURCES } = require('../src/shared/contracts/project-instructions');
const {
  PERMISSION_DENIAL_REASONS,
  PERMISSION_DENIED_MESSAGE_KEYS,
  PERMISSION_DENIED_TOOL_RESULT_MESSAGES,
  TOOL_RESULTS_ARE_DATA_RULE,
  SENSITIVE_CONTENT_REDACTED_TEXT,
  createPermissionDeniedToolResult,
} = require('../src/shared/contracts/tool-permissions');
const { hasKey, translate } = require('../src/shared/i18n');

// Menuepfade werden im Modelltext bewusst so zitiert, wie sie auf dem
// Bildschirm stehen — sonst schickt das Modell den Nutzer zu einem Menuepunkt,
// den es nicht gibt. Diese Stellen duerfen deutsch sein, alles andere nicht.
const ERLAUBTE_UI_ZITATE = [
  'Einstellungen › Tools',
  'Einstellungen › Gedächtnis',
  'Einstellungen › Skills',
  'Einstellungen › MCP',
];

function ohneUiZitate(text) {
  return ERLAUBTE_UI_ZITATE.reduce((rest, zitat) => rest.split(zitat).join(''), text);
}

// Umlaute und Eszett sind der verlaesslichste Marker: sie stehen in praktisch
// jedem deutschen Prompt-Satz dieses Projekts („geoeffneten", „ueberspringen",
// „zurueckgehalten") und in keinem englischen.
const DEUTSCHE_ZEICHEN = /[äöüÄÖÜß]/;

// Wortmarker fuer die Saetze, die ohne Umlaut auskommen.
const DEUTSCHE_WOERTER =
  /\b(?:und|oder|nicht|der|die|das|den|dem|ein|eine|einer|einem|wird|werden|ist|sind|kann|koennen|Datei|Ordner|Pfad|Nutzer|Anzahl|Zeichen|Zeile)\b/;

function istDeutsch(text) {
  const rest = ohneUiZitate(String(text ?? ''));
  return DEUTSCHE_ZEICHEN.test(rest) || DEUTSCHE_WOERTER.test(rest);
}

/** Jeden Beschreibungstext eines Schemas einsammeln, beliebig tief. */
function beschreibungenAus(knoten, pfad, treffer = []) {
  if (!knoten || typeof knoten !== 'object') return treffer;
  if (typeof knoten.description === 'string') treffer.push([pfad, knoten.description]);
  for (const [schluessel, wert] of Object.entries(knoten)) {
    if (wert && typeof wert === 'object') beschreibungenAus(wert, `${pfad}.${schluessel}`, treffer);
  }
  return treffer;
}

function registry() {
  // Alle Tools sichtbar machen: die optionalen haengen sonst an Adaptern, die
  // im Test nicht stehen, und fielen still aus der Pruefung.
  const immerDa = { isAvailable: () => true, isConfigured: () => true };
  return createWorkspaceToolRegistry({
    fsService: {},
    pythonRunner: immerDa,
    shellRunner: immerDa,
    webSearch: immerDa,
    urlFetch: immerDa,
    memory: {},
  });
}

test('jedes Tool hat eine eigene modelDescription — sonst erbt es die deutsche Oberflaechenfassung', () => {
  // Ueber getTools() statt listCatalog(): dort steht genau der Text, den der
  // Anbieter zu sehen bekommt, und die Grundausstattung ist mit drin.
  const tools = registry().getTools({ workspaceOpen: true });
  assert.ok(tools.length > 0, 'keine Tools im Katalog');
  for (const tool of tools) {
    const text = tool.function.description;
    assert.equal(typeof text, 'string', tool.function.name);
    assert.notEqual(text.trim(), '', tool.function.name);
    assert.equal(istDeutsch(text), false, `${tool.function.name}: deutsche Beschreibung am Modell:\n${text}`);
  }
});

test('kein deutscher Parametertext im Schema, das der Anbieter bekommt', () => {
  for (const tool of registry().getTools({ workspaceOpen: true, skillNames: ['demo'] })) {
    for (const [pfad, text] of beschreibungenAus(tool.function.parameters, tool.function.name)) {
      assert.equal(istDeutsch(text), false, `${pfad}: deutscher Parametertext am Modell:\n${text}`);
    }
  }
});

test('der Konventionsblock im System-Prompt ist englisch', () => {
  const prompt = registry().buildSystemPrompt({ workspaceOpen: true });
  assert.notEqual(prompt.trim(), '');
  assert.equal(istDeutsch(prompt), false, prompt);
});

test('die unveraenderlichen Prompt-Regeln sind englisch', () => {
  assert.equal(istDeutsch(TOOL_RESULTS_ARE_DATA_RULE), false, TOOL_RESULTS_ARE_DATA_RULE);
  assert.equal(istDeutsch(SENSITIVE_CONTENT_REDACTED_TEXT), false, SENSITIVE_CONTENT_REDACTED_TEXT);
});

test('beide Ablehnungstabellen decken dieselben Gruende ab', () => {
  const gruende = Object.values(PERMISSION_DENIAL_REASONS).sort();
  assert.deepEqual(Object.keys(PERMISSION_DENIED_TOOL_RESULT_MESSAGES).sort(), gruende);
  // Die Oberflaechenfassung muss dieselbe Breite haben, sonst steht auf dem
  // Bildschirm irgendwann „undefined" statt eines Grundes. Seit #293 traegt
  // sie Katalogschluessel; dass die auch im Katalog stehen, gehoert dazu.
  assert.deepEqual(Object.keys(PERMISSION_DENIED_MESSAGE_KEYS).sort(), gruende);
  for (const grund of gruende) {
    assert.ok(hasKey(PERMISSION_DENIED_MESSAGE_KEYS[grund]), grund);
  }
});

test('das Ablehnungsergebnis traegt den englischen Wortlaut, die Oberflaeche den deutschen', () => {
  for (const grund of Object.values(PERMISSION_DENIAL_REASONS)) {
    const ergebnis = JSON.parse(createPermissionDeniedToolResult({ reason: grund }));
    assert.equal(ergebnis.message, PERMISSION_DENIED_TOOL_RESULT_MESSAGES[grund], grund);
    assert.equal(istDeutsch(ergebnis.message), false, `${grund}: ${ergebnis.message}`);
  }
  // Gegenprobe: Die deutsche Oberflaechenfassung ist bewusst nicht
  // mitgewandert — sie steht jetzt im Katalog statt im Vertrag (#293).
  assert.match(
    translate('de', PERMISSION_DENIED_MESSAGE_KEYS[PERMISSION_DENIAL_REASONS.USER_DENIED]),
    /abgelehnt/
  );
});

// Die Bausteine, die nicht aus der Tool-Registry kommen. Der deutsche
// Wochentag im Umgebungsblock und der deutsche Gedaechtnis-Vorspann haben #276
// zunaechst ueberlebt, weil beide erst beim Zusammenbauen entstehen — ein grep
// ueber die Quellen sieht sie nicht. Deshalb wird hier gebaut statt gelesen.

test('der Umgebungsblock ist englisch, Wochentag eingeschlossen', () => {
  const block = buildEnvironmentSystemPrompt({
    workspaceRoot: '/tmp/demo',
    isGitRepository: true,
    platform: 'darwin',
    osVersion: '15.0',
    shell: 'zsh',
    now: new Date(2026, 8, 22),
    appName: 'Snotra AI',
    appVersion: '1.7.6',
  });
  assert.notEqual(block.trim(), '');
  assert.equal(istDeutsch(block), false, block);

  // Der Wochentag braucht eine eigene Pruefung: „Dienstag", „Montag" und
  // „Mittwoch" tragen weder Umlaut noch eines der Wortmuster, rutschen also
  // durch istDeutsch() — und genau dieses eine Wort ist in #276 als letztes
  // deutsch geblieben. Deshalb gegen die englischen Namen statt gegen eine
  // Heuristik.
  const WOCHENTAGE_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const getroffen = new Set();
  for (let tag = 0; tag < 7; tag += 1) {
    const datum = new Date(2026, 8, 20 + tag);
    const eins = buildEnvironmentSystemPrompt({ now: datum, appName: 'Snotra AI' });
    const erwartet = WOCHENTAGE_EN[datum.getDay()];
    assert.match(eins, new RegExp(`- Today's date: ${erwartet}, `), eins);
    assert.equal(istDeutsch(eins), false, eins);
    getroffen.add(erwartet);
  }
  assert.equal(getroffen.size, 7, 'alle sieben Wochentage geprueft');
});

// Gedaechtnis und AGENTS.md tragen Text des Nutzers — der bleibt in seiner
// Sprache. Geprueft wird deshalb nur der Rahmen, den die App darum baut.
function ohneNutzertext(text, ...inhalte) {
  return inhalte.reduce((rest, inhalt) => rest.split(inhalt).join(''), text);
}

test('der Gedaechtnis-Rahmen ist englisch, der Inhalt des Nutzers bleibt unangetastet', () => {
  const inhalt = 'Tests laufen mit npm test, und zwar täglich.';
  const { text } = buildMemorySystemPrompt([
    { scope: MEMORY_SCOPES.WORKSPACE, text: inhalt },
    { scope: MEMORY_SCOPES.USER, text: inhalt },
  ]);
  assert.ok(text.includes(inhalt), 'der Merksatz des Nutzers steht unveraendert im Prompt');
  assert.equal(istDeutsch(ohneNutzertext(text, inhalt)), false, text);
});

test('der AGENTS.md-Rahmen ist englisch, der Inhalt des Nutzers bleibt unangetastet', () => {
  const inhalt = 'Nutze npm test vor jedem Commit, für alle Änderungen.';
  const { text } = buildProjectInstructionsSystemPrompt([
    { source: PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS, text: inhalt },
    { source: PROJECT_INSTRUCTION_SOURCES.USER_AGENTS, text: inhalt },
  ]);
  assert.ok(text.includes(inhalt), 'die Anweisung des Nutzers steht unveraendert im Prompt');
  assert.equal(istDeutsch(ohneNutzertext(text, inhalt)), false, text);
});

// --- Tool errors (#309) ---------------------------------------------------
//
// A tool's *error* is a tool result like any other and reaches the model the
// same way. #276 made the happy paths English; the sentences a tool answers
// with when something goes wrong were left behind, and a model that reads
// "Pfad ist kein Ordner." mid-conversation tends to answer in German.
//
// Two checks, because each one misses what the other catches:
//
// 1. A source scan over the files that build those results. It sees every
//    literal, including error paths no test ever drives. Comments are German
//    throughout these files and would drown the scan, so esbuild (already a
//    dev dependency, it bundles the renderer vendor files) strips them first.
//    What is left is code plus string and template literals, and identifiers
//    are English, so any German that survives sits in a literal.
// 2. A behavioural pass that drives real error paths and checks the JSON the
//    model would receive, so a sentence assembled at runtime is covered too.

const esbuild = require('esbuild');
const nodeFs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const nodePath = require('node:path');
const { createFsService } = require('../src/main/services/fs-service');
const { validateArguments } = require('../src/main/tools/tool-call-planner');
const { createHttpUrlFetchAdapter } = require('../src/main/adapters/http-url-fetch-adapter');
const { renderContent, MAX_RESULT_CHARS } = require('../src/main/adapters/mcp-adapter');
const { parseHttpUrl } = require('../src/shared/runtime/url-safety');
const { describeFetchError } = require('../src/shared/runtime/fetch-errors');

// istDeutsch() was tuned for prose-length prompt text. Error messages are
// short and often get by without an umlaut or one of its marker words
// ("Unbekanntes Tool: x", "Kein Zielpfad angegeben."), so the error checks add
// the words those sentences are built from. The German opening quote counts as
// well: it framed most of the names quoted in them.
const GERMAN_ERROR_WORDS =
  /„|\b(?:muss|darf|kein|keine|keinen|Kein|Keine|Unbekannt\w*|unbekannt\w*|Ungültig\w*|ungültig\w*|erforderlich|gefunden|angegeben|abgebrochen|fehlgeschlagen|Ziel|Ziele|Seite|Adresse|Befehl|Aufruf)\b/;

function looksGerman(text) {
  const rest = ohneUiZitate(String(text ?? ''));
  return istDeutsch(rest) || GERMAN_ERROR_WORDS.test(rest);
}

/** Files whose strings end up in a tool result. */
const MODEL_CHANNEL_SOURCES = [
  'src/main/services/fs-service.js',
  'src/main/tools/tool-call-planner.js',
  'src/main/tools/workspace-tool-registry.js',
  'src/main/adapters/http-url-fetch-adapter.js',
  'src/main/adapters/mcp-adapter.js',
  'src/main/adapters/workspace-tool-adapter.js',
  'src/main/adapters/memory-adapter.js',
  // Both feed fetch_url's errors: the address check and the network failure.
  'src/shared/runtime/url-safety.js',
  'src/shared/runtime/fetch-errors.js',
];

// German that stays, each with the reason it is not the model's. An entry that
// no longer matches fails the test: a stale exception is how the next German
// sentence would slip through unnoticed.
const NOT_MODEL_CHANNEL = [
  // The IPC boundary's labels for the file tree, the preview and the context
  // menu. Tool paths have English labels of their own (WORKSPACE_TOOL_LABELS).
  { file: 'src/main/services/fs-service.js', text: 'Pfad liegt außerhalb des Arbeitsordners.' },
  { file: 'src/main/services/fs-service.js', text: 'Kein Arbeitsordner geöffnet.' },
  // Only the IPC boundary reaches it: a tool path is always resolved to a
  // non-empty absolute path before this check runs.
  { file: 'src/main/services/fs-service.js', text: 'Pfad ist erforderlich.' },
  // The preview on the approval card — the user reads it, the model does not.
  // (esbuild prints the template's \\n as a real line break, so none here.)
  { file: 'src/main/tools/tool-call-planner.js', text: '… [gekürzt]' },
  // Registration guards: programming errors at construction time (#278).
  { file: 'src/main/tools/workspace-tool-registry.js', text: 'Tool benötigt name, description bzw. descriptionKey, parameters und handler.' },
  { file: 'src/main/tools/workspace-tool-registry.js', text: ': ohne description braucht es eine modelDescription.' },
  { file: 'src/main/tools/workspace-tool-registry.js', text: ': modelDescription muss ein String sein.' },
  { file: 'src/main/tools/workspace-tool-registry.js', text: ' benötigt eine gültige riskClass.' },
  { file: 'src/main/tools/workspace-tool-registry.js', text: ' hat eine ungültige zusätzliche riskClass: ' },
  // Shown in Settings › MCP next to a skipped tool (#308).
  { file: 'src/main/adapters/mcp-adapter.js', text: 'Der Tool-Name ist zu lang.' },
  // Construction guard (#278).
  { file: 'src/main/adapters/memory-adapter.js', text: 'createMemoryAdapter benötigt fs und path.' },
  // forget() and replace() serve the settings page, never a tool: the model
  // only has `remember`, whose messages are English.
  { file: 'src/main/adapters/memory-adapter.js', text: 'Unbekannte Gedächtnis-Ebene: ' },
  { file: 'src/main/adapters/memory-adapter.js', text: 'Für diese Ebene gibt es gerade keinen Speicherort.' },
  { file: 'src/main/adapters/memory-adapter.js', text: 'Höchstens ${maxChars} Zeichen je Ebene.' },
];

function codeWithoutComments(file) {
  const source = nodeFs.readFileSync(nodePath.join(__dirname, '..', file), 'utf8');
  // Only whitespace minification drops the comments; a plain transform keeps
  // them. charset utf8, or every umlaut would come out as \uXXXX.
  return esbuild.transformSync(source, {
    loader: 'js',
    charset: 'utf8',
    legalComments: 'none',
    minifyWhitespace: true,
  }).code;
}

test('no German in the literals of the files that build tool results (#309)', () => {
  const hits = [];
  for (const file of MODEL_CHANNEL_SOURCES) {
    let code = codeWithoutComments(file);
    for (const entry of NOT_MODEL_CHANNEL.filter((candidate) => candidate.file === file)) {
      assert.ok(code.includes(entry.text), `${file}: stale exception, remove it:\n${entry.text}`);
      code = code.split(entry.text).join('');
    }
    // Minified code is one long line; cut it at statement and block edges so
    // a hit names the sentence rather than the whole file.
    for (const piece of code.split(/[;{}\n]/)) {
      if (looksGerman(piece)) hits.push(`${file}: ${piece.trim()}`);
    }
  }
  assert.deepEqual(hits, [], `German in the model channel:\n${hits.join('\n')}`);
});

test('the source scan would catch a German tool error', () => {
  // Counter-check: the detector has to fire on the kind of sentence #309
  // removed, or the scan above proves nothing.
  for (const sentence of [
    "return JSON.stringify({ error: 'Pfad ist kein Ordner.' });",
    'return { error: `Unbekanntes Tool: ${name}` };',
    "return { error: 'Kein Zielpfad angegeben.' };",
    'return `Argument „${key}“ muss Text sein.`;',
  ]) {
    assert.equal(looksGerman(sentence), true, sentence);
  }
});

/** Every string in a tool result, however deep. */
function stringsIn(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (value && typeof value === 'object') for (const inner of Object.values(value)) stringsIn(inner, found);
  return found;
}

test('tool errors reach the model in English (#309)', async (t) => {
  const workspace = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'snotra-309-'));
  t.after(() => fsPromises.rm(workspace, { recursive: true, force: true }));
  await fsPromises.writeFile(nodePath.join(workspace, 'a.txt'), 'one\ntwo\n');
  await fsPromises.writeFile(nodePath.join(workspace, 'notes.txt'), 'plain prose only\n');
  await fsPromises.mkdir(nodePath.join(workspace, 'dir'));

  const fsService = createFsService({ fs: fsPromises, path: nodePath, maxReadFileBytes: 1024, maxWriteFileBytes: 1024 });
  const tools = createWorkspaceToolRegistry({ fsService });
  const context = { approved: true, workspaceRoot: workspace };
  const calls = [
    ['read_file_text', {}],
    ['read_file_text', { relative_path: 'dir' }],
    ['read_file_text', { relative_path: 'skill:demo/SKILL.md' }, { skillRoots: [] }],
    ['read_file_lines', { relative_path: 'a.txt', start_line: 99 }],
    ['read_file_lines', { relative_path: 'a.txt', start_line: 'x' }],
    ['read_file_lines', { relative_path: 'a.txt', start_line: 1, start_byte: 0 }],
    ['list_directory', { relative_path: 'a.txt' }],
    ['list_directory_tree', { relative_path: '.', max_depth: 0 }],
    ['stat_path', {}],
    ['outline_file', { relative_path: 'notes.txt' }],
    ['search_in_files', {}],
    ['search_in_files', { query: '(', is_regex: true }],
    ['find_files', {}],
    ['write_file_text', { relative_path: 'b.txt' }],
    ['write_file_text', { relative_path: 'dir', content: 'x' }],
    ['edit_file', { relative_path: 'a.txt', old_string: 'missing', new_string: 'x' }],
    ['edit_file', { relative_path: 'a.txt', old_string: 'one', new_string: 'one' }],
    ['apply_patch', {}],
    ['apply_patch', { relative_path: 'a.txt', edits: [] }],
    ['apply_patch', { patch: 'just some text\n' }],
    ['apply_patch', { patch: '--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-nope\n+x\n' }],
    ['load_skill', { name: '' }],
  ];
  for (const [name, args, extra] of calls) {
    const result = JSON.parse(await tools.execute(name, args, { ...context, ...extra }));
    const texts = stringsIn(result);
    assert.ok(texts.length > 0, `${name}: empty result`);
    for (const text of texts) {
      assert.equal(looksGerman(text), false, `${name} ${JSON.stringify(args)}: German in the result:\n${text}`);
    }
  }

  // The planner's argument check travels into the denial result as `message`.
  for (const [type, value] of [['string', 1], ['number', 'x'], ['boolean', 'x'], ['array', 'x'], ['object', 'x']]) {
    const message = validateArguments({ parameters: { properties: { v: { type } } } }, { v: value });
    assert.equal(looksGerman(message), false, message);
  }
  assert.equal(looksGerman(validateArguments({ parameters: { required: ['v'] } }, {})), false);
  assert.equal(looksGerman(validateArguments({ parameters: {} }, [])), false);
});

test('fetch_url and MCP errors reach the model in English (#309)', async () => {
  for (const raw of ['', 'not a url', 'ftp://example.org', 'https://user:secret@example.org/']) {
    const { error } = parseHttpUrl(raw);
    assert.equal(looksGerman(error), false, error);
  }
  assert.equal(looksGerman(describeFetchError({}, 'https://example.org')), false);

  const blocked = await createHttpUrlFetchAdapter({
    fetchImpl: async () => null,
    lookup: async () => [{ address: '10.0.0.1' }],
  }).fetchUrl({ url: 'https://example.org' });
  assert.equal(looksGerman(blocked.error), false, blocked.error);

  const notFound = await createHttpUrlFetchAdapter({
    fetchImpl: async () => ({ status: 404, ok: false, headers: { get: () => null } }),
    lookup: async () => [{ address: '93.184.216.34' }],
  }).fetchUrl({ url: 'https://example.org/missing' });
  assert.equal(looksGerman(notFound.error), false, notFound.error);

  assert.equal(looksGerman(renderContent([{ type: 'image', data: 'x' }]).text), false);
  const tail = renderContent([{ type: 'text', text: 'x'.repeat(MAX_RESULT_CHARS + 1) }]).text.slice(MAX_RESULT_CHARS);
  assert.equal(looksGerman(tail), false, tail);
});
