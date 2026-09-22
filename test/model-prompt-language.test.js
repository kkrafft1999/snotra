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
