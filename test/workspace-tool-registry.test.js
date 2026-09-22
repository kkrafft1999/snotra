const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createToolRegistry,
  createWorkspaceToolRegistry,
} = require('../src/main/tools/workspace-tool-registry');
const { TOOL_RISK_CLASSES } = require('../src/shared/contracts/tool-permissions');

function definition(name, { riskClass = TOOL_RISK_CLASSES.READ, requiresWorkspace } = {}) {
  return {
    name,
    ...(requiresWorkspace === undefined ? {} : { requiresWorkspace }),
    description: `Beschreibung für ${name}`,
    promptDescription: `Prompt für ${name}`,
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    },
    riskClass,
    handler: async (args, context) =>
      JSON.stringify({ name, value: args.value, workspaceRoot: context.workspaceRoot }),
  };
}

const APPROVED = { approved: true };

test('registry exposes registered tools in provider format', () => {
  const registry = createToolRegistry([definition('read')]);

  assert.deepEqual(registry.getTools(), [
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Beschreibung für read',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
        },
      },
    },
  ]);
});

test('registry verlangt eine gültige riskClass und kennt keinen read-Default (Issue #66)', () => {
  assert.throws(
    () => createToolRegistry([{ ...definition('ohne'), riskClass: undefined }]),
    /riskClass/
  );
  assert.throws(
    () => createToolRegistry([{ ...definition('falsch'), riskClass: 'shell' }]),
    /riskClass/
  );
  const registry = createToolRegistry([definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE })]);
  assert.equal(registry.getDefinition('write').riskClass, TOOL_RISK_CLASSES.WRITE);
  assert.equal(registry.getDefinition('missing'), null);
});

test('registry zeigt Schreib-Tools unabhängig vom Modus und filtert nur nach Allowlist', () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('other'),
    definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
  ]);

  // Kein globaler Schreibschalter mehr: die Policy entscheidet pro Aufruf.
  assert.deepEqual(
    registry.getTools().map((tool) => tool.function.name),
    ['read', 'other', 'write']
  );
  assert.deepEqual(
    registry.getTools({ allowedNames: ['read', 'write'] }).map((tool) => tool.function.name),
    ['read', 'write']
  );

  // Seit #182 zaehlt der Block keine Tool-Namen mehr auf, seit #268 traegt er
  // auch keinen Schreib-Vorbehalt mehr: Der hat Modelle davon abgehalten,
  // ueberhaupt zu schreiben. Ein sichtbares Schreib-Tool darf den Block
  // deshalb nicht mehr veraendern.
  assert.equal(
    registry.buildSystemPrompt({ allowedNames: ['read', 'write'] }),
    registry.buildSystemPrompt({ allowedNames: ['read'] })
  );
  assert.doesNotMatch(
    registry.buildSystemPrompt({ allowedNames: ['read', 'write'] }),
    /zurückhaltend/
  );
});

test('registry filters disabled tool names from tools, prompt and execution', async () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('other'),
    definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
  ]);

  assert.deepEqual(
    registry.getTools({ disabledNames: ['other', 'write'] }).map((tool) => tool.function.name),
    ['read']
  );
  assert.match(
    JSON.parse(await registry.execute('other', {}, { ...APPROVED, disabledNames: ['other'] })).error,
    /switched off/
  );
  assert.deepEqual(
    JSON.parse(await registry.execute('read', { value: 'x' }, { ...APPROVED, disabledNames: ['other'] })),
    { name: 'read', value: 'x' }
  );

  // Leere Liste = alles aktiv (Default).
  assert.deepEqual(
    registry.getTools({ disabledNames: [] }).map((tool) => tool.function.name),
    ['read', 'other', 'write']
  );
});

// Issue #96: Die Tool-Liste haengt nicht mehr pauschal am geoeffneten Ordner.
test('registry zeigt ohne Workspace nur Tools ohne Ordnerbezug (#96)', () => {
  const registry = createToolRegistry([
    definition('read_file_text'),
    definition('web_search', { riskClass: TOOL_RISK_CLASSES.EXTERNAL, requiresWorkspace: false }),
  ]);

  const withWorkspace = registry.getTools().map((tool) => tool.function.name);
  assert.deepEqual(withWorkspace, ['read_file_text', 'web_search']);

  const withoutWorkspace = registry.getTools({ workspaceOpen: false }).map((tool) => tool.function.name);
  assert.deepEqual(withoutWorkspace, ['web_search'], 'Datei-Tools brauchen einen Ordner');
});

test('registry lässt den Pfad-Hinweis weg, wenn kein Datei-Tool dabei ist (#96)', () => {
  const registry = createToolRegistry([
    definition('read_file_text'),
    definition('web_search', { riskClass: TOOL_RISK_CLASSES.EXTERNAL, requiresWorkspace: false }),
  ]);

  assert.match(registry.buildSystemPrompt(), /relative to the folder root/);

  const withoutWorkspace = registry.buildSystemPrompt({ workspaceOpen: false });
  assert.doesNotMatch(withoutWorkspace, /relative to the folder root/);
  // Bedingung 1 aus #182: ohne Datei-Tools bleibt der Block trotzdem gefuellt —
  // sein Rueckgabewert ist fuer die Engine das Signal „es gibt Tools".
  assert.notEqual(withoutWorkspace, '');
});

test('registry liefert ohne Workspace und ohne ordnerfreie Tools einen leeren Prompt (#96)', () => {
  const registry = createToolRegistry([definition('read_file_text')]);

  assert.deepEqual(registry.getTools({ workspaceOpen: false }), []);
  assert.equal(registry.buildSystemPrompt({ workspaceOpen: false }), '');
});

test('registry lists its full catalog with risk classes independent of filters', () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
  ]);

  // Der Katalog traegt beide Texte: die Einstellungen zeigen den Kurztext und
  // klappen den Volltext auf Wunsch auf (Issue #98).
  assert.deepEqual(registry.listCatalog(), [
    {
      name: 'read',
      description: 'Beschreibung für read',
      shortDescription: 'Prompt für read',
      riskClass: 'read',
    },
    {
      name: 'write',
      description: 'Beschreibung für write',
      shortDescription: 'Prompt für write',
      riskClass: 'write',
    },
  ]);
});

test('catalog falls back to the full description when a tool has no short text', () => {
  const { promptDescription, ...withoutShort } = definition('read');
  const registry = createToolRegistry([withoutShort]);

  assert.deepEqual(registry.listCatalog(), [
    {
      name: 'read',
      description: 'Beschreibung für read',
      shortDescription: 'Beschreibung für read',
      riskClass: 'read',
    },
  ]);
});

test('modelDescription geht an das Modell, description bleibt in den Einstellungen (#181)', () => {
  const lang = 'Ausfuehrlicher Text fuer die Einstellungen, der alles erklaert.';
  const registry = createToolRegistry([
    { ...definition('read'), description: lang, modelDescription: 'Liest eine Datei.' },
  ]);

  assert.equal(registry.getTools()[0].function.description, 'Liest eine Datei.');
  // Die Einstellungen zeigen unveraendert den Volltext und die Kurzzeile.
  assert.deepEqual(registry.listCatalog(), [
    {
      name: 'read',
      description: lang,
      shortDescription: 'Prompt für read',
      riskClass: TOOL_RISK_CLASSES.READ,
    },
  ]);
  // `promptDescription` traegt seit #182 nur noch die zugeklappte Zeile in den
  // Einstellungen — der System-Prompt zaehlt keine Tools mehr auf.
  assert.doesNotMatch(registry.buildSystemPrompt(), /Prompt für read/);
});

test('ohne modelDescription bleibt getTools() byte-identisch (#181)', () => {
  const ohneFeld = createToolRegistry([definition('read'), definition('write')]);
  // Das Feld ueberhaupt zu kennen darf nichts aendern, solange niemand es setzt —
  // das ist die Abnahmebedingung der Trennung: erst trennen, dann kuerzen.
  const mitLeerem = createToolRegistry([
    { ...definition('read'), modelDescription: '' },
    { ...definition('write'), modelDescription: '   \n  ' },
  ]);

  assert.equal(
    JSON.stringify(mitLeerem.getTools()),
    JSON.stringify(ohneFeld.getTools())
  );
  // Explizit: ein leer gelassenes Feld schickt dem Modell keine leere
  // Beschreibung, sondern faellt auf description zurueck.
  assert.equal(mitLeerem.getTools()[0].function.description, 'Beschreibung für read');
  assert.equal(mitLeerem.getTools()[1].function.description, 'Beschreibung für write');
});

test('modelDescription vom falschen Typ faellt sofort auf (#181)', () => {
  assert.throws(
    () => createToolRegistry([{ ...definition('read'), modelDescription: 42 }]),
    /modelDescription/
  );
});

// Was der Nutzer in den Einstellungen sieht, bekommt auch das Modell — und
// umgekehrt (Issue #180). Den Weg „nur das Modell" gibt es weiter, aber nur
// als ausdrueckliche Grundausstattung (#195); den Weg „weder noch" trug
// `internal`, das mit #203 entfallen ist.
test('Katalog und Schemas nennen dieselben Tools (#180)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  // Ohne Ordner- und Skill-Bindung vergleichen, sonst filtert nicht die
  // Sichtbarkeit, sondern die Verfuegbarkeit (#96/#173).
  const schemas = registry.getTools().map((tool) => tool.function.name);
  const katalog = registry.listCatalog().map((entry) => entry.name);
  const essenziell = schemas.filter((name) => registry.getDefinition(name).essential === true);

  assert.ok(essenziell.length > 0, 'ohne Grundausstattung prueft der Vergleich nichts');
  assert.deepEqual(
    schemas.filter((name) => !essenziell.includes(name)).sort(),
    // Konfigurationsgebundene Tools stehen im Katalog, aber ohne Schluessel
    // bzw. Laufzeit nicht in den Schemas (#63/#86/#95/#102).
    katalog.filter((name) => registry.getDefinition(name).isAvailable() === true).sort()
  );
});

test('registry executes handlers with request context', async () => {
  const registry = createToolRegistry([definition('read')]);

  const result = JSON.parse(
    await registry.execute(
      'read',
      { value: 'hello' },
      { ...APPROVED, workspaceRoot: '/tmp/project' }
    )
  );

  assert.deepEqual(result, {
    name: 'read',
    value: 'hello',
    workspaceRoot: '/tmp/project',
  });
});

test('registry führt ohne Policy-Freigabe keinen Handler aus (Issue #66)', async () => {
  let handlerCalls = 0;
  const registry = createToolRegistry([
    {
      ...definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
      handler: async () => {
        handlerCalls += 1;
        return JSON.stringify({ ok: true });
      },
    },
  ]);

  for (const context of [undefined, {}, { approved: false }, { approved: 'true' }]) {
    const out = JSON.parse(await registry.execute('write', { value: 'x' }, context));
    assert.equal(out.error, 'permission_denied');
    assert.equal(out.reason, 'not_approved');
  }
  assert.equal(handlerCalls, 0);

  const ok = JSON.parse(await registry.execute('write', { value: 'x' }, APPROVED));
  assert.deepEqual(ok, { ok: true });
  assert.equal(handlerCalls, 1);
});

test('registry rejects unavailable, unknown and duplicate tools', async () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
  ]);

  assert.match(
    JSON.parse(await registry.execute('read', {}, { ...APPROVED, allowedNames: ['write'] })).error,
    /not enabled/
  );
  assert.match(JSON.parse(await registry.execute('missing', {}, APPROVED)).error, /Unknown tool/);
  assert.throws(() => registry.register(definition('read')), /bereits registriert/);
});

function makeFsServiceStub() {
  return {
    runListDirectoryTool() {},
    runReadFileTextTool() {},
    runReadFileLinesTool() {},
    runWriteFileTextTool() {},
    runEditFileTool() {},
    runSearchInFilesTool() {},
    runFindFilesTool() {},
    runStatPathTool() {},
    runOutlineFileTool() {},
    runListDirectoryTreeTool() {},
    runApplyPatchTool() {},
    listApplyPatchTargets: (args) => (args.relative_path ? [args.relative_path] : []),
  };
}

test('workspace registry declares all built-in tools with their minimum risk classes', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });

  const names = registry.getTools().map((tool) => tool.function.name);
  assert.deepEqual(names, [
    'list_directory',
    'load_skill',
    'read_file_text',
    'read_file_lines',
    'search_in_files',
    'find_files',
    'stat_path',
    'outline_file',
    'list_directory_tree',
    'write_file_text',
    'edit_file',
    'apply_patch',
  ]);
  // Kein Schreib-Vorbehalt mehr im Block (#268) — der Schutz haengt an der
  // Freigabe je Aufruf, nicht an einer Bitte im Prompt.
  assert.doesNotMatch(registry.buildSystemPrompt(), /zurückhaltend/);
  // web_search fehlt oben bewusst: ohne eingerichteten Suchdienst wird es dem
  // Modell nicht angeboten (Issue #63). Im Katalog der Einstellungen steht es.
  assert.equal(names.includes('web_search'), false);
  // run_python ebenso: ohne erlaubte und gefundene Python-Installation
  // erreicht es das Modell nicht (Issue #86).
  assert.equal(names.includes('run_python'), false);
  // fetch_url ebenso: ohne Abruf-Adapter gibt es nichts zu lesen (Issue #95).
  assert.equal(names.includes('fetch_url'), false);
  // shell_execute ebenso: ohne erlaubte und gefundene Shell erreicht es das
  // Modell nicht (Issue #102).
  assert.equal(names.includes('shell_execute'), false);
  // remember ebenso: ohne Memory-Port gibt es nichts zu merken (Issue #166).
  assert.equal(names.includes('remember'), false);

  // Konzept §2: neun Lesetools → read, drei Schreibtools → write,
  // web_search und fetch_url → external.
  const classes = Object.fromEntries(registry.listCatalog().map((entry) => [entry.name, entry.riskClass]));
  // Die Grundausstattung steht oben in den Schemas, aber nicht im Katalog
  // (#195) — ihre Klasse kommt deshalb direkt aus der Definition.
  assert.equal(registry.getDefinition('list_directory').riskClass, 'read');
  // Nachladen einer Skill-Anleitung liest nur, und zwar aus einem
  // schreibgeschuetzten Verzeichnis (Issue #173).
  assert.equal(registry.getDefinition('load_skill').riskClass, 'read');
  const readTools = [
    'read_file_text',
    'read_file_lines',
    'search_in_files',
    'find_files',
    'stat_path',
    'outline_file',
    'list_directory_tree',
  ];
  for (const name of readTools) assert.equal(classes[name], 'read', name);
  // `remember` schreibt eine Datei wie die drei anderen — dass sie der App
  // gehoert und nicht dem Projekt, aendert an der Klasse nichts (Issue #166).
  for (const name of ['write_file_text', 'edit_file', 'apply_patch', 'remember']) {
    assert.equal(classes[name], 'write', name);
  }
  assert.equal(classes.web_search, 'external');
  assert.equal(classes.fetch_url, 'external');
  assert.equal(classes.run_python, 'execute');
  assert.equal(classes.shell_execute, 'execute');
  // 17 registrierte Tools minus die beiden essenziellen list_directory und
  // load_skill, die niemand abwaehlt (#195).
  assert.equal(Object.keys(classes).length, 15);
  assert.equal(Object.hasOwn(classes, 'list_directory'), false);
  assert.equal(Object.hasOwn(classes, 'load_skill'), false);
});

// Grundausstattung (#195): Wer alle Tools abwaehlte, um Tokens zu sparen, nahm
// `load_skill` mit — und bekam dafür jede Skill-Anleitung voll in jede Anfrage
// (chat-engine.js). Diese Tools bleiben deshalb sichtbar fuer das Modell und
// unsichtbar in den Einstellungen: Es gibt nichts zu entscheiden.
test('die Grundausstattung lässt sich nicht abwählen und steht nicht im Katalog (#195)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const essential = ['list_directory', 'load_skill'];

  // Alles abgewaehlt, was es gibt — genau der Fall aus dem Fehlerbericht.
  const alleAb = registry
    .getTools({ disabledNames: registry.listCatalog().map((entry) => entry.name).concat(essential) })
    .map((tool) => tool.function.name);
  assert.deepEqual(alleAb, essential);
  // Der Konventionsblock bleibt damit ebenfalls bestehen — er ist fuer die
  // Engine das Signal ‚es gibt Tools' und traegt die Sicherheitsregel (#182).
  assert.notEqual(registry.buildSystemPrompt({ disabledNames: essential }), '');

  const katalog = registry.listCatalog().map((entry) => entry.name);
  for (const name of essential) {
    assert.equal(katalog.includes(name), false, `${name} gehört nicht in die Tool-Liste`);
    // Registriert, ausfuehrbar und als Grundausstattung markiert bleibt es.
    assert.equal(registry.getDefinition(name).essential, true, name);
  }
});

// Grundausstattung heisst nicht ‚immer da': list_directory braucht weiterhin
// einen Ordner, load_skill einen eingeschalteten Skill (#96/#173).
test('die Grundausstattung hält sich weiter an Ordner und Skills (#195)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });

  const ohneOrdner = registry
    .getTools({ workspaceOpen: false, skillNames: [] })
    .map((tool) => tool.function.name);
  assert.equal(ohneOrdner.includes('list_directory'), false);
  assert.equal(ohneOrdner.includes('load_skill'), false);

  const mitSkill = registry
    .getTools({ workspaceOpen: false, skillNames: ['demo'] })
    .map((tool) => tool.function.name);
  assert.equal(mitSkill.includes('load_skill'), true);
});

test('der System-Prompt zählt keine Tool-Namen mehr auf (#182)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const prompt = registry.buildSystemPrompt();
  const namen = registry.getTools().map((tool) => tool.function.name);

  assert.doesNotMatch(prompt, /Du hast folgende Tools/);
  // Genannt werden nur die Tools, über die der Block eine Aussage macht —
  // die übrigen stehen ausschließlich im tools-Feld der Anfrage.
  const genannt = namen.filter((name) => prompt.includes(name));
  assert.deepEqual(genannt, [
    'list_directory',
    'search_in_files',
    'find_files',
    'list_directory_tree',
  ]);
});

test('der Konventionsblock beschreibt, statt zu verallgemeinern (#182)', () => {
  const registry = createToolRegistry([
    { ...definition('list_directory'), skips: ['hidden'] },
    { ...definition('find_files'), skips: ['hidden', 'ignored'] },
    { ...definition('read_file_text') },
  ]);

  const prompt = registry.buildSystemPrompt();
  // Beide überspringen Verstecktes, nur find_files zusätzlich .gitignore —
  // „alle Tools überspringen versteckte Dateien" wäre schlicht falsch.
  assert.match(prompt, /list_directory and find_files skip hidden entries/);
  assert.match(prompt, /find_files additionally skip everything excluded by the \.gitignore/);
  assert.doesNotMatch(prompt, /list_directory zusätzlich/);
  // Der gitignore-Hinweis muss bleiben: ohne ihn ist ein leeres Ergebnis nicht
  // von „gibt es nicht" zu unterscheiden (#183).
  assert.match(prompt, /An empty result can therefore mean/);

  // Wer abgewählt ist, taucht im Satz nicht auf.
  const ohneFindFiles = registry.buildSystemPrompt({ disabledNames: ['find_files'] });
  assert.doesNotMatch(ohneFindFiles, /find_files/);
  assert.doesNotMatch(ohneFindFiles, /\.gitignore/);
  assert.match(ohneFindFiles, /list_directory skip hidden entries/);
});

test('der Block steht, sobald überhaupt ein Tool sichtbar ist (#182)', () => {
  // Bedingung 1 aus #182: Der Rückgabewert ist für die Engine das Signal
  // „es gibt Tools". Ein leerer Block nähme dem „kein Projektordner"-Baustein
  // die Prompt-Injection-Regel mit — Sparen wäre das nicht.
  const nurWebsuche = createToolRegistry([
    definition('web_search', { riskClass: TOOL_RISK_CLASSES.EXTERNAL, requiresWorkspace: false }),
  ]);
  assert.notEqual(nurWebsuche.buildSystemPrompt(), '');
  assert.notEqual(nurWebsuche.buildSystemPrompt({ workspaceOpen: false }), '');

  // Nur wirklich ohne sichtbares Tool bleibt er leer.
  const nurDatei = createToolRegistry([definition('read_file_text')]);
  assert.equal(nurDatei.buildSystemPrompt({ workspaceOpen: false }), '');
});

test('die Schemas wiederholen die Konventionen nicht mehr (#183)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const schemas = JSON.stringify(registry.getTools());

  // Was einmal im Konventionsblock steht, steht nicht noch 30-mal im Schema.
  for (const wiederholung of ['Relativer Pfad', '2 MB', 'Punkt-Präfix', '.gitignore']) {
    assert.equal(schemas.includes(wiederholung), false, `„${wiederholung}" steht noch im Schema`);
  }
  // Grenzen sagt das Schema selbst — maschinenlesbar statt in Prosa daneben.
  assert.equal(schemas.includes('Obergrenze'), false);
  const suche = registry.getTools().find((tool) => tool.function.name === 'search_in_files');
  assert.equal(suche.function.parameters.properties.max_results.default, 50);
  assert.equal(suche.function.parameters.properties.max_results.maximum, 200);
  assert.equal(suche.function.parameters.properties.include_hidden.default, false);
});

test('die Ordner-Parameter behalten ihre eigene, korrekte Kurzfassung (#183)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const beschreibung = (name) =>
    registry.getTools().find((tool) => tool.function.name === name)
      .function.parameters.properties.relative_path.description;

  // Ordner-Startpunkte ohne `required` — ein Datei-Beispiel wäre hier
  // irreführender als gar keins, deshalb ausdrücklich nicht die
  // Datei-Formulierung der übrigen Tools.
  for (const name of ['list_directory', 'find_files', 'list_directory_tree']) {
    assert.equal(beschreibung(name), 'Starting folder; empty or "." = the whole project.', name);
  }
  assert.equal(
    beschreibung('search_in_files'),
    'Starting folder or a single file; empty or "." = the whole project.'
  );
  for (const name of ['read_file_text', 'read_file_lines', 'edit_file']) {
    assert.match(beschreibung(name), /^File path, e\.g\./, name);
  }
});

test('der gitignore-Hinweis überlebt die Kürzung (#183)', () => {
  // Ohne ihn liefert etwa `find_files out/**/*.html` ein sauberes, leeres
  // Ergebnis ohne jeden Hinweis — eine stille Falschantwort ohne
  // Selbstkorrektur. Er ist aus den Schemas verschwunden, muss also im
  // System-Prompt stehen.
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  assert.equal(JSON.stringify(registry.getTools()).includes('.gitignore'), false);
  assert.match(registry.buildSystemPrompt(), /\excluded by the .gitignore of the project root/);
  assert.match(registry.buildSystemPrompt(), /An empty result can therefore mean/);
});

/* ── Die teuersten Schemata neu gefasst (Issue #184) ───────────────────────── */

test('die Schemas erklären nicht mehr, was die Fehlermeldung ohnehin sagt (#184)', () => {
  // Leitregel: Name und Typ tragen die Bedeutung, die Beschreibung nur noch
  // das, was daraus nicht folgt. Jeder Satz hier hat einen zweiten Träger in
  // fs-service.js bzw. search-line-matcher.js — er kostet im Fehlerfall eine
  // Runde statt in jeder Runde Tokens.
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const schemas = JSON.stringify(registry.getTools());

  const gestrichen = [
    // apply_patch: Atomarität und Rollback (die Datei ist im Fehlerfall
    // unverändert — das sieht das Modell, ohne dass man es ihm vorher sagt).
    'Alles oder nichts',
    'atomar',
    'zurückgesetzt',
    // apply_patch: die ausbuchstabierte Diff-Grammatik. Der Parser gibt sie
    // wörtlich zurück (fs-service.js:540/588/638/696).
    '@@ -alteZeile',
    'unverändert)',
    // edit_file/apply_patch: die Eindeutigkeitsregel im Wortlaut der
    // Fehlermeldung (fs-service.js:461/1288).
    'inklusive Einrückung und Zeilenumbrüchen',
    'umgebende Zeilen mit aufnehmen',
    // search_in_files: Länge und Komplexität des Regex melden
    // search-line-matcher.js:55/113.
    '(a+)+',
    'höchstens 256 Zeichen',
    // list_directory_tree: Suchreihenfolge und Symlinks ändern die Wahl des
    // Tools nicht, das Baumformat liest man an der Antwort ab.
    'Breitensuche',
    'Symlinks',
    'Text-Baum mit Einrückung',
  ];
  for (const satz of gestrichen) {
    assert.equal(schemas.includes(satz), false, `„${satz}" steht noch im Schema`);
  }
});

test('die beiden Rettungssätze überleben die Kürzung (#184)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const tool = (name) => registry.getTools().find((t) => t.function.name === name);

  // 1. Der gitignore-/Versteckt-Hinweis. Ohne ihn ist ein leeres Ergebnis
  //    nicht von „gibt es nicht" zu unterscheiden — stille Falschantwort ohne
  //    Selbstkorrektur, die teuerste Fehlerklasse.
  assert.match(registry.buildSystemPrompt(), /An empty result can therefore mean/);

  // 2. Der Ersparnis-Satz an read_file_lines. Er kostet 9 Token; eine
  //    unnötige Volllesung von workspace-tool-registry.js kostet über 10.000.
  assert.match(
    tool('read_file_lines').function.description,
    /Cheaper in tokens than read_file_text/
  );

  // Die stille Teilmessung bleibt benannt: ohne Bereich liefert das Tool 200
  // Zeilen und meldet dabei truncated=false (fs-service.js:215).
  assert.match(
    tool('read_file_lines').function.parameters.properties.end_line.description,
    /default start_line \+ 199/
  );
  // „[+N]" ist das einzige Zeichen dafür, dass der Baum unvollständig ist.
  assert.match(tool('list_directory_tree').function.description, /\[\+N\]/);
});

test('read_file_lines behält beide Modi im Parametersatz (#184)', () => {
  // Zeilen- und Byte-Bereich sind zwei echte Modi (fs-service.js:1083-1114).
  // Eine Sparfassung, die start_byte/length stillschweigend streicht, spart
  // keine Token, sondern nimmt dem Tool einen Modus.
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const { properties } = registry
    .getTools()
    .find((tool) => tool.function.name === 'read_file_lines').function.parameters;

  assert.deepEqual(Object.keys(properties), [
    'relative_path',
    'start_line',
    'end_line',
    'start_byte',
    'length',
  ]);
  // Die Unvereinbarkeit steht genau einmal — am zweiten Modus.
  assert.match(properties.start_byte.description, /cannot be combined with start_line\/end_line/);
  assert.equal(properties.start_line.description.includes('kombinierbar'), false);
});

test('der Aufklapptext in den Einstellungen bleibt der ausführliche (#184)', () => {
  // `modelDescription` ist gekürzt, der Volltext nicht: In Einstellungen ›
  // Tools ist er die einzige Stelle, an der ein Nutzer erfährt, was ein Tool
  // wirklich tut — und er muss länger sein als die Kurzzeile darüber. Seit
  // #291 gilt das in beiden Sprachen, sonst verkommt eine davon zur Notlösung.
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const schema = new Map(registry.getTools().map((tool) => [tool.function.name, tool.function]));

  for (const locale of ['en', 'de']) {
    const katalog = new Map(registry.listCatalog({ locale }).map((eintrag) => [eintrag.name, eintrag]));
    for (const name of [
      'apply_patch',
      'search_in_files',
      'read_file_lines',
      'list_directory_tree',
      'find_files',
      'edit_file',
    ]) {
      const eintrag = katalog.get(name);
      assert.ok(
        eintrag.description.length > eintrag.shortDescription.length,
        `${locale}/${name}: der Volltext ist nicht länger als die Kurzzeile darüber`
      );
      assert.ok(
        eintrag.description.length > schema.get(name).description.length,
        `${locale}/${name}: der Volltext ist nicht länger als der Schema-Text`
      );
    }
  }

  // Was aus dem Schema gestrichen wurde, steht im Aufklapptext weiterhin —
  // in beiden Sprachen, nicht nur in der Quellfassung.
  const de = new Map(registry.listCatalog({ locale: 'de' }).map((e) => [e.name, e]));
  const en = new Map(registry.listCatalog({ locale: 'en' }).map((e) => [e.name, e]));
  assert.match(de.get('apply_patch').description, /Alles oder nichts/);
  assert.match(en.get('apply_patch').description, /All or nothing/);
  assert.match(de.get('edit_file').description, /inklusive Einrückung und Zeilenumbrüchen/);
  assert.match(en.get('edit_file').description, /indentation and line breaks included/);
  assert.match(de.get('list_directory_tree').description, /Breitensuche/);
  assert.match(en.get('list_directory_tree').description, /Breadth first/);
  assert.match(de.get('search_in_files').description, /Zeitbudget von 5 s/);
  assert.match(en.get('search_in_files').description, /time budget of 5 s/);
});

test('der Katalog spricht die uebergebene Sprache, ohne Angabe die Voreinstellung (#291)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const eintrag = (locale) => registry.listCatalog(locale === undefined ? undefined : { locale })
    .find((e) => e.name === 'read_file_text');

  assert.equal(eintrag('de').shortDescription, 'Liest Textdateien innerhalb des Projektordners.');
  assert.equal(eintrag('en').shortDescription, 'Reads text files inside the project folder.');
  // Ohne Angabe gilt die Voreinstellung des Katalogs, nicht die letzte Wahl.
  assert.equal(eintrag(undefined).shortDescription, eintrag('en').shortDescription);
  // Eine unbekannte Sprache faellt zurueck, statt den Schluessel zu zeigen.
  assert.equal(eintrag('kl').shortDescription, eintrag('en').shortDescription);
});

test('jedes Tool im Katalog traegt beide Texte in beiden Sprachen (#291)', () => {
  const registry = createWorkspaceToolRegistry({
    fsService: makeFsServiceStub(),
    webSearch: { isConfigured: () => true, search: async () => ({ ok: true, query: '', results: [] }) },
    urlFetch: { fetchUrl: async () => ({ ok: true, url: 'https://example.org', text: '', truncated: false }) },
    pythonRunner: { isAvailable: () => true, run: async () => ({}) },
    shellRunner: { isAvailable: () => true, run: async () => ({}) },
    memory: { remember: async () => ({}) },
  });
  for (const locale of ['de', 'en']) {
    for (const eintrag of registry.listCatalog({ locale })) {
      for (const feld of ['description', 'shortDescription']) {
        const text = eintrag[feld];
        assert.equal(typeof text, 'string', `${locale}/${eintrag.name}.${feld}`);
        assert.notEqual(text.trim(), '', `${locale}/${eintrag.name}.${feld} ist leer`);
        // Ein fehlender Katalogeintrag faellt auf den Schluessel zurueck —
        // sichtbar, aber eben doch nur ein Schluessel.
        assert.doesNotMatch(text, /^tools\.(desc|short)\./, `${locale}/${eintrag.name}.${feld}`);
      }
    }
  }
});

test('workspace registry bindet alle Datei-Tools an den Ordner, web_search nicht (#96)', () => {
  const registry = createWorkspaceToolRegistry({
    fsService: makeFsServiceStub(),
    webSearch: { isConfigured: () => true, search: async () => ({ ok: true, query: '', results: [] }) },
    urlFetch: { fetchUrl: async () => ({ ok: true, url: 'https://example.org', text: '', truncated: false }) },
  });

  const withoutWorkspace = registry.getTools({ workspaceOpen: false }).map((tool) => tool.function.name);
  // load_skill haengt nicht am Ordner, sondern an eingeschalteten Skills (#173).
  assert.deepEqual(withoutWorkspace, ['load_skill', 'web_search', 'fetch_url']);
  assert.deepEqual(
    registry.getTools({ workspaceOpen: false, skillNames: [] }).map((tool) => tool.function.name),
    ['web_search', 'fetch_url'],
    'ohne eingeschalteten Skill faellt load_skill weg'
  );

  const withWorkspace = registry.getTools().map((tool) => tool.function.name);
  assert.ok(withWorkspace.includes('list_directory'));
  assert.ok(withWorkspace.includes('web_search'));
});

test('workspace registry beschreibt die Zielpfade jedes Tools für den Planer (Issue #66)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const targets = (name, args) => registry.getDefinition(name).targets(args);

  assert.deepEqual(targets('read_file_text', { relative_path: 'a.md' }), [
    { path: 'a.md', kind: 'file', access: 'read' },
  ]);
  assert.deepEqual(targets('stat_path', { relative_path: '.env' }), [
    { path: '.env', kind: 'any', access: 'read' },
  ]);
  assert.deepEqual(targets('list_directory', {}), [{ path: '', kind: 'tree', access: 'read' }]);
  assert.deepEqual(targets('search_in_files', { query: 'x', relative_path: 'src' }), [
    { path: 'src', kind: 'tree', access: 'read' },
  ]);
  // Ein Tool ohne Dateiziel: die Policy hat hier nur „alles" zu greifen.
  assert.deepEqual(targets('web_search', { query: 'x' }), []);
  assert.deepEqual(targets('write_file_text', { relative_path: 'n.md', content: '' }), [
    { path: 'n.md', kind: 'file', access: 'write', overwrite: true },
  ]);
  assert.deepEqual(targets('edit_file', { relative_path: 'a.js' }), [
    { path: 'a.js', kind: 'file', access: 'write' },
  ]);
  assert.deepEqual(targets('apply_patch', { relative_path: 'a.js', edits: [] }), [
    { path: 'a.js', kind: 'file', access: 'write' },
  ]);
});
