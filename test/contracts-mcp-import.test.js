const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMcpServersBlock,
  toMcpServerInput,
  toServerId,
  looksSecret,
  MCP_IMPORT_MAX_SERVERS,
} = require('../src/shared/contracts/mcp-import');
const { validateMcpServerInput, MCP_LIMITS } = require('../src/shared/contracts/mcp');

/** Der Block, wie er in Claude Desktop und Cursor steht. */
const VOLL = JSON.stringify({
  mcpServers: {
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    },
  },
});

test('liest den vollständigen Block mit umschließendem mcpServers', () => {
  const { ok, candidates, skipped, errors } = parseMcpServersBlock(VOLL);
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(skipped, []);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'github');
  assert.equal(candidates[0].label, 'github');
  assert.equal(candidates[0].command, 'npx');
  assert.deepEqual(candidates[0].args, ['-y', '@modelcontextprotocol/server-github']);
});

test('liest ebenso den blanken Inhalt ohne mcpServers-Hülle', () => {
  // Beides wird kopiert, je nachdem, wo der Cursor stand.
  const nurInhalt = JSON.stringify(JSON.parse(VOLL).mcpServers);
  const { ok, candidates } = parseMcpServersBlock(nurInhalt);
  assert.equal(ok, true);
  assert.equal(candidates[0].id, 'github');
});

test('ein Markdown-Zaun um den Block stört nicht', () => {
  const { ok, candidates } = parseMcpServersBlock('```json\n' + VOLL + '\n```');
  assert.equal(ok, true);
  assert.equal(candidates.length, 1);
});

test('Kommentare und angehängte Kommas werden geschluckt', () => {
  // So sieht eine von Hand gepflegte Konfiguration aus (VS Code, Cursor).
  const block = `{
    // der Server fuer GitHub
    "mcpServers": {
      /* Paket wird per npx geholt */
      "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
      },
    }
  }`;
  const { ok, candidates, errors } = parseMcpServersBlock(block);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.equal(candidates[0].command, 'npx');
});

test('ein // in einer Zeichenkette ist kein Kommentar', () => {
  // Der naheliegende Fehler: eine URL im Wert als Kommentar zu lesen.
  const block = JSON.stringify({
    mcpServers: { api: { command: 'node', args: ['--url', 'https://example.com/pfad'], env: { BASE_URL: 'https://api.example.com' } } },
  });
  const { ok, candidates } = parseMcpServersBlock(block);
  assert.equal(ok, true);
  assert.deepEqual(candidates[0].args, ['--url', 'https://example.com/pfad']);
  assert.equal(candidates[0].env[0].value, 'https://api.example.com');
});

test('ein Komma in einem Argument bleibt stehen', () => {
  const block = JSON.stringify({ mcpServers: { x: { command: 'tool', args: ['--liste=a,b,c'] } } });
  const { candidates } = parseMcpServersBlock(block);
  assert.deepEqual(candidates[0].args, ['--liste=a,b,c']);
});

test('Einträge mit HTTP- oder SSE-Transport werden mit Begründung übersprungen', () => {
  const block = JSON.stringify({
    mcpServers: {
      fern: { type: 'sse', url: 'https://example.com/sse' },
      auchfern: { url: 'https://example.com/mcp' },
      nah: { command: 'npx', args: ['-y', 'server'] },
    },
  });
  const { ok, candidates, skipped } = parseMcpServersBlock(block);
  assert.equal(ok, true, 'der brauchbare Eintrag rettet den Import');
  assert.deepEqual(candidates.map((c) => c.id), ['nah']);
  assert.deepEqual(skipped.map((s) => s.name), ['fern', 'auchfern']);
  assert.match(skipped[0].reason, /sse/i);
  assert.match(skipped[1].reason, /URL/);
});

test('ein Eintrag ohne Kommando wird übersprungen, nicht stillschweigend übernommen', () => {
  const block = JSON.stringify({ mcpServers: { leer: { args: ['-y'] } } });
  const { ok, candidates, skipped, errors } = parseMcpServersBlock(block);
  assert.equal(ok, false);
  assert.deepEqual(candidates, []);
  assert.match(skipped[0].reason, /command/);
  assert.equal(errors.length, 1, 'und es bleibt nicht bei einer leeren Liste ohne Wort');
});

test('aus einem freien Namen wird eine gültige Kennung abgeleitet', () => {
  assert.equal(toServerId('Atlassian Jira'), 'atlassian-jira');
  assert.equal(toServerId('mcp-atlassian'), 'mcp-atlassian');
  assert.equal(toServerId('  GitHub  '), 'github');
  // Doppelte Unterstriche trennen im Tool-Namen Server und Tool.
  assert.equal(toServerId('a__b').includes('__'), false);
  assert.equal(toServerId('###'), '', 'bleibt nichts übrig, ist es keine Kennung');
});

test('der abgeleitete Name steht als Hinweis am Kandidaten', () => {
  const block = JSON.stringify({ mcpServers: { 'Atlassian Jira': { command: 'npx' } } });
  const { candidates } = parseMcpServersBlock(block);
  assert.equal(candidates[0].id, 'atlassian-jira');
  assert.equal(candidates[0].label, 'Atlassian Jira', 'der Anzeigename bleibt der Originalname');
  assert.ok(candidates[0].notes.some((n) => n.includes('atlassian-jira')));
});

test('eine schon vergebene Kennung wird gemeldet, nicht heimlich überschrieben', () => {
  const block = JSON.stringify({ mcpServers: { github: { command: 'npx' } } });
  const { candidates } = parseMcpServersBlock(block, { existingIds: ['github'] });
  assert.equal(candidates[0].id, 'github', 'die Kennung bleibt — Ersetzen kann gewollt sein');
  assert.equal(candidates[0].conflict, true);
});

test('zwei Namen, die auf dieselbe Kennung fallen, bleiben unterscheidbar', () => {
  const block = JSON.stringify({
    mcpServers: { 'My Server': { command: 'a' }, 'my/server': { command: 'b' } },
  });
  const { candidates } = parseMcpServersBlock(block);
  assert.deepEqual(candidates.map((c) => c.id), ['my-server', 'my-server-2']);
  assert.equal(candidates[1].conflict, false, 'das ist kein Konflikt mit Gespeichertem');
});

test('token-artige Werte sind als geheim vorgemerkt, harmlose nicht', () => {
  const block = JSON.stringify({
    mcpServers: {
      x: {
        command: 'npx',
        env: {
          GITHUB_TOKEN: 'abc',            // Schlüsselname verrät es
          GH: 'ghp_0123456789abcdef',     // Wertform verrät es
          LANG: 'de_DE',                  // harmlos
          PORT: 8080,                     // Zahl wird zu Text
        },
      },
    },
  });
  const { candidates } = parseMcpServersBlock(block);
  const env = Object.fromEntries(candidates[0].env.map((e) => [e.key, e]));
  assert.equal(env.GITHUB_TOKEN.secret, true);
  assert.equal(env.GH.secret, true, 'auch ohne verräterischen Schlüsselnamen');
  assert.equal(env.LANG.secret, false);
  assert.equal(env.PORT.value, '8080', 'Zahlen werden übernommen, nicht verworfen');
});

test('die Geheim-Heuristik irrt lieber in die sichere Richtung', () => {
  assert.equal(looksSecret('AUTHOR', 'Konrad'), true, 'lieber einmal zu viel verschlüsselt');
  assert.equal(looksSecret('HOME', '/Users/kk'), false);
});

test('leere Werte und Platzhalter werden angesprochen', () => {
  const block = JSON.stringify({
    mcpServers: { x: { command: 'npx', env: { A_TOKEN: '', B_TOKEN: '<dein-token>' } } },
  });
  const { candidates } = parseMcpServersBlock(block);
  assert.ok(candidates[0].notes.some((n) => n.includes('A_TOKEN') && n.includes('Wert')));
  assert.ok(candidates[0].notes.some((n) => n.includes('B_TOKEN') && n.includes('Platzhalter')));
});

test('kaputtes JSON erzeugt eine verständliche Meldung statt eines stillen Fehlschlags', () => {
  const { ok, errors, candidates } = parseMcpServersBlock('{ "mcpServers": { "x": ');
  assert.equal(ok, false);
  assert.deepEqual(candidates, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /kein gültiges JSON/);
});

test('nichts eingefügt, leerer Block und falscher Typ sagen jeweils, was fehlt', () => {
  assert.match(parseMcpServersBlock('').errors[0], /nichts eingefügt/i);
  assert.match(parseMcpServersBlock('[]').errors[0], /Objekt/);
  assert.match(parseMcpServersBlock('{"mcpServers":{}}').errors[0], /keine Server/);
  assert.match(parseMcpServersBlock('{"mcpServers":[]}').errors[0], /mcpServers/);
});

test('mehr als die Obergrenze an Servern wird nicht klammheimlich gekappt', () => {
  const viele = {};
  for (let i = 0; i < MCP_IMPORT_MAX_SERVERS + 5; i += 1) viele[`srv${i}`] = { command: 'npx' };
  const { candidates, errors } = parseMcpServersBlock(JSON.stringify({ mcpServers: viele }));
  assert.equal(candidates.length, MCP_IMPORT_MAX_SERVERS);
  assert.match(errors[0], new RegExp(String(MCP_IMPORT_MAX_SERVERS)));
});

test('zu lange Argumentlisten und env-Blöcke werden gekappt und gemeldet', () => {
  const block = {
    mcpServers: {
      x: { command: 'npx', args: Array(MCP_LIMITS.MAX_ARGS + 3).fill('-y'), env: {} },
    },
  };
  for (let i = 0; i < MCP_LIMITS.MAX_ENV_ENTRIES + 3; i += 1) block.mcpServers.x.env[`V${i}`] = 'x';
  const { candidates } = parseMcpServersBlock(JSON.stringify(block));
  assert.equal(candidates[0].args.length, MCP_LIMITS.MAX_ARGS);
  assert.equal(candidates[0].env.length, MCP_LIMITS.MAX_ENV_ENTRIES);
  assert.equal(candidates[0].notes.filter((n) => n.includes('ersten')).length, 2);
});

test('importierte Server sind aus — der Import ist keine Freigabe', () => {
  const { candidates } = parseMcpServersBlock(VOLL);
  assert.equal(toMcpServerInput(candidates[0]).enabled, false);
});

test('die Abbildung wird vom echten Validator angenommen', () => {
  // Der eigentliche Beleg: Was der Import erzeugt, muss durch dieselbe Prüfung
  // gehen wie eine von Hand eingetragene Konfiguration — sonst scheitert der
  // Import erst beim Speichern.
  const { candidates } = parseMcpServersBlock(VOLL);
  const result = validateMcpServerInput(toMcpServerInput(candidates[0]));

  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.value.id, 'github');
  assert.equal(result.value.enabled, false);
  assert.deepEqual(result.env, [
    { key: 'GITHUB_TOKEN', secret: true, value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', keep: false },
  ]);
});

test('auch ein Kandidat mit abgeleiteter Kennung und cwd übersteht den Validator', () => {
  const block = JSON.stringify({
    mcpServers: { 'Atlassian Jira': { command: 'docker', args: ['run', '--rm', 'img'], cwd: '/tmp', env: { LANG: 'de_DE' } } },
  });
  const { candidates } = parseMcpServersBlock(block);
  const result = validateMcpServerInput(toMcpServerInput(candidates[0]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.value.id, 'atlassian-jira');
  assert.equal(result.value.cwd, '/tmp');
  assert.deepEqual(result.env, [{ key: 'LANG', secret: false, value: 'de_DE', keep: false }]);
});
