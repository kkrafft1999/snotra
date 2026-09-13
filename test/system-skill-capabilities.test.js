/**
 * Der System-Skill `snotra-capabilities` beschreibt dem Modell die Fähigkeiten
 * der App. Er ist voreingestellt aktiv und geht als Teil des System-Prompts
 * hinaus — steht dort etwas Falsches, verbreitet das Modell es mit Nachdruck.
 *
 * Genau dieser Drift ist über vier Releases unbemerkt geblieben (Issue #114):
 * `run_python`, `shell_execute`, `web_search` und `fetch_url` kamen dazu,
 * während im Skill weiter „keine Shell" und „kein Internetzugriff" stand.
 * Dieser Test hängt den Skilltext an die Registry: ein neu angebotenes Tool
 * lässt ihn fehlschlagen, solange es im Skill nicht vorkommt.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');

const SKILL_PATH = path.join(
  __dirname,
  '..',
  'system-skills',
  'snotra-capabilities',
  'SKILL.md'
);

// Der Katalog kennt keine Handler-Aufrufe, ein leerer fsService genügt.
// `listCatalog()` filtert bereits alles mit `internal: true` (debug_wait).
const catalog = createWorkspaceToolRegistry({ fsService: {} }).listCatalog();
const skillText = fs.readFileSync(SKILL_PATH, 'utf8');

test('snotra-capabilities nennt jedes Tool, das dem Modell angeboten wird (Issue #114)', () => {
  assert.ok(catalog.length > 0, 'Die Registry liefert keine Tools.');

  const missing = catalog
    .map((entry) => entry.name)
    .filter((name) => !skillText.includes(`\`${name}\``));

  assert.deepEqual(
    missing,
    [],
    `Diese Tools werden dem Modell angeboten, kommen im System-Skill aber nicht vor: `
      + `${missing.join(', ')}. Bitte ${path.relative(path.join(__dirname, '..'), SKILL_PATH)} `
      + `ergänzen — sonst behauptet die App wieder, sie könne etwas nicht, was sie kann.`
  );
});

test('snotra-capabilities erklärt die Freigabe jeder vorkommenden Risikoklasse (Issue #114)', () => {
  const classes = [...new Set(catalog.map((entry) => entry.riskClass))];
  const missing = classes.filter((riskClass) => !skillText.includes(`\`${riskClass}\``));

  assert.deepEqual(
    missing,
    [],
    `Diese Risikoklassen kommen in der Registry vor, im System-Skill aber nicht: ${missing.join(', ')}.`
  );
});

test('snotra-capabilities behauptet nicht mehr, Shell und Internet seien unmöglich (Issue #114)', () => {
  // Die beiden Sätze, die vier Releases lang falsch waren.
  assert.ok(
    !/Keine Shell, keine Befehle/.test(skillText),
    'Der widerlegte Satz „Keine Shell, keine Befehle" steht wieder im Skill.'
  );
  assert.ok(
    !/Kein Internetzugriff für dich/.test(skillText),
    'Der widerlegte Satz „Kein Internetzugriff für dich" steht wieder im Skill.'
  );
});
