const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEnvironmentSystemPrompt,
  formatLocalDate,
} = require('../src/application/chat/environment-prompt');

// Lokale Zeit, damit die Datumsangabe unabhaengig von der Zeitzone bleibt:
// ein aus UTC gebautes Datum kippt in Mitteleuropa abends auf den Folgetag.
const MONDAY = new Date(2026, 8, 15, 14, 30);

function facts(overrides = {}) {
  return {
    appName: 'Snotra AI',
    appVersion: '1.5.3',
    workspaceRoot: '/Users/du/Projects/snotra',
    isGitRepository: true,
    platform: 'darwin',
    osVersion: 'Darwin 27.0.0',
    shell: 'zsh',
    now: MONDAY,
    ...overrides,
  };
}

test('Environment-Block nennt Pfad, Git, Plattform, Shell und Datum', () => {
  const block = buildEnvironmentSystemPrompt(facts());
  assert.match(block, /Umgebung, in der du gerade läufst \(Snotra AI 1\.5\.3\):/);
  assert.match(block, /- Arbeitsverzeichnis: \/Users\/du\/Projects\/snotra$/m);
  assert.match(block, /- Git-Repository: ja$/m);
  assert.match(block, /- Plattform: darwin \(macOS\)$/m);
  assert.match(block, /- Betriebssystem: Darwin 27\.0\.0$/m);
  assert.match(block, /- Shell für shell_execute: zsh$/m);
  assert.match(block, /- Heutiges Datum: Dienstag, 2026-09-15$/m);
});

test('ohne offenen Ordner bleiben Pfad- und Git-Zeile weg', () => {
  const block = buildEnvironmentSystemPrompt(
    facts({ workspaceRoot: null, isGitRepository: null })
  );
  assert.ok(!block.includes('Arbeitsverzeichnis'), 'kein leeres Arbeitsverzeichnis');
  assert.ok(!block.includes('Git-Repository'), 'keine Git-Angabe ohne Ordner');
  assert.match(block, /- Plattform: darwin \(macOS\)$/m);
  assert.match(block, /- Heutiges Datum:/);
});

test('Git-Angabe faellt weg, wenn sie nicht ermittelt werden konnte', () => {
  const block = buildEnvironmentSystemPrompt(facts({ isGitRepository: null }));
  assert.match(block, /- Arbeitsverzeichnis:/);
  assert.ok(!block.includes('Git-Repository'), 'unbekannt heisst: keine Zeile');
});

test('Git-Angabe „nein" wird ausgeschrieben', () => {
  const block = buildEnvironmentSystemPrompt(facts({ isGitRepository: false }));
  assert.match(block, /- Git-Repository: nein$/m);
});

test('abgeschaltete Shell wird nicht genannt', () => {
  const block = buildEnvironmentSystemPrompt(facts({ shell: null }));
  assert.ok(!block.includes('shell_execute'), 'keine Shell ohne verfuegbares Tool');
  assert.match(block, /- Plattform: darwin/);
});

test('unbekannte Plattform bleibt ohne Klammerzusatz', () => {
  const block = buildEnvironmentSystemPrompt(facts({ platform: 'freebsd' }));
  assert.match(block, /- Plattform: freebsd$/m);
});

test('Windows und Linux bekommen ihren gelaeufigen Namen', () => {
  assert.match(buildEnvironmentSystemPrompt(facts({ platform: 'win32' })), /win32 \(Windows\)/);
  assert.match(buildEnvironmentSystemPrompt(facts({ platform: 'linux' })), /linux \(Linux\)/);
});

test('ohne jede Angabe entsteht kein Block', () => {
  assert.equal(buildEnvironmentSystemPrompt({}), '');
  assert.equal(buildEnvironmentSystemPrompt(null), '');
  assert.equal(
    buildEnvironmentSystemPrompt({ appName: 'Snotra AI', appVersion: '1.5.3' }),
    '',
    'Name und Version allein tragen keinen Block'
  );
});

test('der Block nennt keine Uhrzeit — sonst bricht das Prompt-Caching', () => {
  const morgens = buildEnvironmentSystemPrompt(facts({ now: new Date(2026, 8, 15, 8, 5) }));
  const abends = buildEnvironmentSystemPrompt(facts({ now: new Date(2026, 8, 15, 23, 55) }));
  assert.equal(morgens, abends);
});

test('formatLocalDate haelt sich an die Ortszeit und faengt Unsinn ab', () => {
  assert.equal(formatLocalDate(new Date(2026, 0, 1)), 'Donnerstag, 2026-01-01');
  assert.equal(formatLocalDate(new Date(2026, 11, 31)), 'Donnerstag, 2026-12-31');
  assert.equal(formatLocalDate(new Date('kaputt')), '');
  assert.equal(formatLocalDate('2026-09-15'), '');
});
