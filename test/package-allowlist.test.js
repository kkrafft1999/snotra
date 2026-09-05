const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const { findViolations, loadIgnorePatterns } = require('../scripts/check-asar-contents');

// Issue #72: Das App-Paket darf nur Laufzeitdateien enthalten. Die Allowlist
// steht als Negativ-Regex in package.json (packagerConfig.ignore); hier wird
// sie gegen typische Pfade geprueft, wie electron-packager sie testet (mit
// fuehrendem "/", relativ zum Projektordner).

const patterns = loadIgnorePatterns(pkg);
const isIgnored = (p) => patterns.some((re) => re.test(p));

test('allowlist keeps runtime files', () => {
  for (const kept of [
    '/src',
    '/src/main/index.js',
    '/src/renderer/vendor/marked.min.js',
    '/src/renderer/generated/contracts.js',
    '/src/preload/bundle.js',
    '/system-skills',
    '/system-skills/snotra-capabilities/SKILL.md',
    '/node_modules',
    '/node_modules/electron-squirrel-startup/index.js',
    '/package.json',
    '/LICENSE',
  ]) {
    assert.equal(isIgnored(kept), false, `${kept} muss im Paket bleiben`);
  }
});

test('allowlist drops development, documentation and local files', () => {
  for (const dropped of [
    '/.claude',
    '/.claude/settings.local.json',
    '/.claude/rules/task-management.md',
    '/.github/ISSUE_TEMPLATE/bug_report.yml',
    '/.git/HEAD',
    '/.gitignore',
    '/.nvmrc',
    '/.env',
    '/.env.local',
    '/.venv/bin/python',
    '/docs/roadmap.md',
    '/test/fs-service.test.js',
    '/scripts/check-asar-contents.js',
    '/out/Snotra AI-darwin-arm64/app.asar',
    '/README.md',
    '/package-lock.json',
    '/icon.icns',
    '/icon.ico',
    '/assets/icon/icon-macos.svg',
    '/.DS_Store',
    '/src/.DS_Store',
    '/src/renderer/.DS_Store',
    '/srcfoo/x.js',
    '/package.json.bak',
  ]) {
    assert.equal(isIgnored(dropped), true, `${dropped} darf nicht ins Paket`);
  }
});

test('findViolations accepts a clean archive listing', () => {
  const result = findViolations(
    ['/package.json', '/src', '/src/main', '/src/main/index.js', '/system-skills', '/node_modules/foo/index.js', '/LICENSE'],
    patterns
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.topLevel, ['LICENSE', 'node_modules', 'package.json', 'src', 'system-skills']);
});

test('findViolations reports forbidden entries and missing required files', () => {
  const result = findViolations(
    ['/package.json', '/src/main/index.js', '/.claude/settings.local.json', '/docs/roadmap.md', '/test/x.test.js'],
    patterns
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.ignored, ['/.claude/settings.local.json', '/docs/roadmap.md', '/test/x.test.js']);
  assert.deepEqual(result.missing, ['/system-skills']);
});

test('findViolations flags forbidden top-level folders even if the allowlist were loosened', () => {
  const result = findViolations(['/package.json', '/src/main/index.js', '/system-skills', '/docs/x.md'], [/^$/]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.ignored, ['/docs/x.md']);
});
