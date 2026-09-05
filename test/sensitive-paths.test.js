// Erkennung sensibler Pfade (Issue #66, Konzept §4): Mindestmuster,
// Fehlalarme, Windows-Trenner, skill:-Ziele, Nutzer-Muster.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SENSITIVE_NAME_PATTERNS,
  DEFAULT_SENSITIVE_DIRECTORY_NAMES,
  createSensitivePathMatcher,
} = require('../src/shared/runtime/sensitive-paths');

const matcher = createSensitivePathMatcher();

test('Mindestmuster aus dem Konzept sind vollständig hinterlegt', () => {
  assert.deepEqual(DEFAULT_SENSITIVE_NAME_PATTERNS, [
    '.env*',
    '*.pem',
    '*.key',
    'id_*',
    'credentials*',
    'secrets*',
    '*.p12',
    '*.pfx',
    '.netrc',
    '.npmrc',
    '.pypirc',
  ]);
  assert.deepEqual(DEFAULT_SENSITIVE_DIRECTORY_NAMES, ['.ssh', '.aws', '.gnupg', '.kube']);
});

test('Dateien mit Zugangsdaten treffen in jedem Segment, unabhängig von der Schreibweise', () => {
  for (const p of [
    '.env',
    '.env.local',
    'config/.ENV.production',
    'certs/server.pem',
    'keys/server.KEY',
    'id_rsa',
    'home/id_ed25519.pub',
    'credentials.json',
    'aws/Credentials',
    'secrets.yaml',
    'store.p12',
    'store.pfx',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.env.d/tokens.txt',
  ]) {
    assert.equal(matcher.isSensitivePath(p), true, p);
  }
});

test('.env.example ist ein erklärter Fehlalarm und wird ebenfalls markiert', () => {
  assert.equal(matcher.isSensitivePath('.env.example'), true);
  assert.equal(matcher.classifyPath('.env.example').pattern, '.env*');
});

test('gewöhnliche Projektdateien bleiben unauffällig', () => {
  for (const p of [
    'src/index.js',
    'identity.js',
    'package.json',
    'README.md',
    'docs/roadmap.md',
    'environment.md',
    'keys.md',
    'secretary.txt',
    'credential-service.js',
    'personality.md',
    '',
    '.',
  ]) {
    assert.equal(matcher.isSensitivePath(p), false, p);
  }
});

test('Verzeichnisse mit Zugangsdaten treffen den Ordner selbst und alles darunter', () => {
  assert.equal(matcher.isSensitivePath('.ssh'), true);
  assert.equal(matcher.isSensitivePath('.ssh/known_hosts'), true);
  assert.equal(matcher.isSensitivePath('backup/.aws/config'), true);
  assert.equal(matcher.isSensitivePath('.GnuPG/pubring.kbx'), true);
  assert.equal(matcher.isSensitivePath('.kube/config'), true);
  assert.equal(matcher.classifyPath('.ssh/id_rsa').source, 'directory');
  assert.equal(matcher.isSensitivePath('ssh/notes.md'), false);
});

test('Windows-Trenner und skill:-Präfix werden korrekt zerlegt', () => {
  assert.equal(matcher.isSensitivePath('keys\\server.key'), true);
  assert.equal(matcher.isSensitivePath('config\\.env'), true);
  assert.equal(matcher.isSensitivePath('skill:demo/references/x.md'), false);
  assert.equal(matcher.isSensitivePath('skill:demo/.ssh/known_hosts'), true);
  assert.equal(matcher.isSensitivePath('skill:demo/assets/.env'), true);
  // Der Skill-Name selbst ist kein Dateiname.
  assert.equal(matcher.isSensitivePath('skill:secrets-helper/SKILL.md'), false);
});

test('Nutzer-Muster ergänzen die Mindestmuster (z. B. personal/**) und treffen den Ordner selbst', () => {
  const custom = createSensitivePathMatcher({ userPatterns: ['personal/**', 'notes/*.private'] });
  assert.equal(custom.isSensitivePath('personal'), true);
  assert.equal(custom.isSensitivePath('personal/notes.md'), true);
  assert.equal(custom.isSensitivePath('Personal/Notes.md'), true, 'unabhängig von Schreibweise');
  assert.equal(custom.isSensitivePath('personality.md'), false);
  assert.equal(custom.isSensitivePath('notes/a.private'), true);
  assert.equal(custom.isSensitivePath('notes/sub/a.private'), false);
  assert.equal(custom.classifyPath('personal/x').source, 'user');
  assert.equal(custom.isSensitivePath('.env'), true, 'Standardmuster bleiben');
});
