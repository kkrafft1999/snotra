const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { MEMORY_SCOPES, MEMORY_ORIGINS } = require('../src/shared/contracts/memory');
const { TOOL_RISK_CLASSES } = require('../src/shared/contracts/tool-permissions');
const { toolCategory, TOOL_CATEGORIES } = require('../src/shared/contracts/tool-categories');

function makeFsServiceStub() {
  return new Proxy({}, { get: () => async () => ({}) });
}

/** Merkt sich die Aufrufe; `fail` laesst `remember` mit dieser Meldung scheitern. */
function makeMemoryStub({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async remember(request) {
      calls.push(request);
      if (fail) throw new Error(fail);
      return { scope: request.scope, file: `/pfad/${request.scope}/memory.md`, text: request.text };
    },
    async load() {
      return [];
    },
  };
}

function registryWith(memory) {
  return createWorkspaceToolRegistry({ fsService: makeFsServiceStub(), memory });
}

test('ohne Memory-Port wird das Tool dem Modell nicht angeboten', () => {
  // Wie bei `web_search` (Issue #63): Im Katalog der Einstellungen steht es,
  // in der Tool-Liste des Modells nur, wenn es auch etwas tun kann.
  const offered = registryWith(null)
    .getTools()
    .map((tool) => tool.function.name);
  assert.equal(offered.includes('remember'), false);
  const withPort = registryWith(makeMemoryStub())
    .getTools()
    .map((tool) => tool.function.name);
  assert.equal(withPort.includes('remember'), true);
});

test('mit Memory-Port steht remember als Schreib-Tool im Katalog', () => {
  const entry = registryWith(makeMemoryStub())
    .listCatalog()
    .find((item) => item.name === 'remember');
  assert.ok(entry);
  assert.equal(entry.riskClass, TOOL_RISK_CLASSES.WRITE);
  // Im Tool-Log gehoert es zu den Schreibschritten (Issue #166).
  assert.equal(toolCategory('remember'), TOOL_CATEGORIES.WRITE);
});

test('das Tool nimmt keinen Pfad entgegen — nur Ebene, Text und Herkunft', () => {
  const registry = registryWith(makeMemoryStub());
  const def = registry.getDefinition('remember');
  assert.deepEqual(Object.keys(def.parameters.properties).sort(), ['origin', 'scope', 'text']);
  assert.deepEqual(def.parameters.required.sort(), ['origin', 'scope', 'text']);
  // Kein Pfad heisst auch: nichts, was der Pfad-Freigabe vorzulegen waere.
  assert.deepEqual(def.targets({ scope: 'workspace', text: 'x' }), []);
  // Ohne geoeffneten Ordner bleibt die globale Ebene nutzbar.
  assert.equal(def.requiresWorkspace, false);
});

test('gemerkt wird mit Ebene, Text und dem Ordner aus dem Aufrufkontext', async () => {
  const memory = makeMemoryStub();
  const registry = registryWith(memory);
  const raw = await registry.getDefinition('remember').handler(
    { scope: 'workspace', text: 'Tests laufen mit npm test', origin: 'requested' },
    { workspaceRoot: '/tmp/projekt' }
  );
  assert.deepEqual(memory.calls, [
    {
      scope: 'workspace',
      text: 'Tests laufen mit npm test',
      origin: MEMORY_ORIGINS.REQUESTED,
      workspaceRoot: '/tmp/projekt',
    },
  ]);
  // Der Zielpfad geht mit zurueck: „gemerkt" allein laesst offen, ob es den
  // Ordner oder alle Ordner betrifft.
  const result = JSON.parse(raw);
  assert.equal(result.ok, true);
  assert.equal(result.scope, MEMORY_SCOPES.WORKSPACE);
  assert.match(result.file, /memory\.md$/);
});

test('eine unbekannte Herkunft gilt als vom Nutzer erbeten, nicht als selbst gemerkt', async () => {
  const memory = makeMemoryStub();
  await registryWith(memory)
    .getDefinition('remember')
    .handler({ scope: 'user', text: 'x', origin: 'quatsch' }, {});
  // Im Zweifel die harmlosere Auslegung: „self" waere der Fall, den der
  // Nutzer abschalten kann — den darf ein Tippfehler nicht herbeifuehren.
  assert.equal(memory.calls[0].origin, MEMORY_ORIGINS.REQUESTED);
});

test('ein abgelehnter Merkversuch kommt als Fehlertext zurueck, nicht als Absturz', async () => {
  const memory = makeMemoryStub({ fail: 'Selbstständiges Merken ist abgeschaltet.' });
  const raw = await registryWith(memory)
    .getDefinition('remember')
    .handler({ scope: 'user', text: 'etwas', origin: 'self' }, {});
  const result = JSON.parse(raw);
  assert.equal(result.ok, undefined);
  assert.match(result.error, /abgeschaltet/);
});

test('die Beschreibung fuer das Modell nennt die Grenze und den Skill', () => {
  const def = registryWith(makeMemoryStub()).getDefinition('remember');
  assert.match(def.modelDescription, /niemals Passwörter/i);
  assert.match(def.modelDescription, /snotra-memory/);
  // Die Prompt-Zeile steht bei *jeder* Anfrage in der Tool-Liste und muss
  // deshalb schon ohne den Skill sagen, wann das Tool gemeint ist.
  assert.match(def.promptDescription, /merk dir/i);
});

/* ── Freigabekarte (Issue #166) ──────────────────────────────────────────── */

const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');

test('die Vorschau-Zusatzangaben überleben den Weg zum Renderer', () => {
  // Der DTO-Bau filtert die Vorschau. Fielen diese Felder weg, zeigte die
  // Karte „ohne Dateiziel" und verschwiege, worüber entschieden wird — beim
  // Merken die Reichweite, bei `shell_execute` Shell und Arbeitsordner.
  const dto = createToolApprovalRequestDto({
    requestId: 'r-1',
    tool: 'remember',
    riskClasses: ['write'],
    targets: [],
    mode: 'smart',
    sessionAllowed: true,
    preview: { kind: 'memory', text: 'Merksatz', memoryScope: 'user' },
  });
  assert.equal(dto.preview.memoryScope, 'user');

  const shellDto = createToolApprovalRequestDto({
    requestId: 'r-2',
    tool: 'shell_execute',
    riskClasses: ['execute'],
    targets: [],
    mode: 'smart',
    sessionAllowed: false,
    preview: { kind: 'shell', text: 'npm test', shell: 'zsh', shellLogin: true, cwd: '/tmp/p' },
  });
  assert.equal(shellDto.preview.shell, 'zsh');
  assert.equal(shellDto.preview.shellLogin, true);
  assert.equal(shellDto.preview.cwd, '/tmp/p');
});

const nodePath = require('path');
const { pathToFileURL } = require('url');
const loadApprovalView = () =>
  import(pathToFileURL(nodePath.join(__dirname, '..', 'src', 'renderer', 'utils', 'tool-approval-view.js')).href);

test('die Karte nennt die Reichweite und den Merksatz statt eines Dateiziels', async () => {
  const { buildApprovalCardView } = await loadApprovalView();
  const view = buildApprovalCardView({
    contractVersion: 1,
    requestId: 'req-mem',
    tool: 'remember',
    riskClasses: ['write'],
    targets: [],
    mode: 'smart',
    sessionAllowed: true,
    preview: { kind: 'memory', text: 'Tests laufen mit npm test.', memoryScope: 'workspace' },
  });
  // Worüber hier entschieden wird, ist die Reichweite — nicht ein Pfad, den
  // der Nutzer ohnehin nicht beeinflussen kann.
  assert.match(view.memoryScopeLabel, /Projekt/);
  assert.equal(view.preview.kindLabel, 'Merksatz');
  assert.equal(view.preview.text, 'Tests laufen mit npm test.');

  const global = buildApprovalCardView({
    contractVersion: 1,
    requestId: 'req-mem-2',
    tool: 'remember',
    riskClasses: ['write'],
    targets: [],
    mode: 'smart',
    sessionAllowed: true,
    preview: { kind: 'memory', text: 'Anrede Du.', memoryScope: 'user' },
  });
  assert.match(global.memoryScopeLabel, /Global/);
});
