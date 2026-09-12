const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSkillDocument } = require('../src/shared/runtime/skill-frontmatter');

test('parses name, description and body of a SKILL.md', () => {
  const parsed = parseSkillDocument(
    ['---', 'name: demo-skill', 'description: Macht Demos', '---', '', '# Demo', '', 'Anweisung.', ''].join('\n')
  );

  assert.equal(parsed.frontmatter.name, 'demo-skill');
  assert.equal(parsed.frontmatter.description, 'Macht Demos');
  assert.equal(parsed.body, '# Demo\n\nAnweisung.');
});

test('accepts quoted values, comments and CRLF line endings', () => {
  const parsed = parseSkillDocument(
    ['---', '# ein Kommentar', 'name: "demo"', "description: 'Text mit: Doppelpunkt'", '---', 'Body'].join('\r\n')
  );

  assert.equal(parsed.frontmatter.name, 'demo');
  assert.equal(parsed.frontmatter.description, 'Text mit: Doppelpunkt');
  assert.equal(parsed.body, 'Body');
});

test('keeps a hash inside a quoted description', () => {
  const parsed = parseSkillDocument(['---', 'name: demo', 'description: "a # b"', '---', 'x'].join('\n'));
  assert.equal(parsed.frontmatter.description, 'a # b');
});

test('strips an unquoted trailing comment', () => {
  const parsed = parseSkillDocument(['---', 'name: demo # intern', 'description: d', '---', 'x'].join('\n'));
  assert.equal(parsed.frontmatter.name, 'demo');
});

test('reads block and inline lists without choking', () => {
  const parsed = parseSkillDocument(
    [
      '---',
      'name: demo',
      'description: d',
      'allowed-tools:',
      '  - Read',
      '  - Bash(git:*)',
      'compatibility: [claude-code, cursor]',
      '---',
      'x',
    ].join('\n')
  );

  assert.deepEqual(parsed.frontmatter['allowed-tools'], ['Read', 'Bash(git:*)']);
  assert.deepEqual(parsed.frontmatter.compatibility, ['claude-code', 'cursor']);
  assert.equal(parsed.frontmatter.name, 'demo');
});

test('survives nested maps such as metadata', () => {
  const parsed = parseSkillDocument(
    ['---', 'name: demo', 'description: d', 'metadata:', '  version: "1.2.3"', '---', 'Body'].join('\n')
  );

  assert.equal(parsed.frontmatter.name, 'demo');
  assert.equal(parsed.body, 'Body');
});

test('returns null without a closed frontmatter block', () => {
  assert.equal(parseSkillDocument('# Nur Markdown'), null);
  assert.equal(parseSkillDocument('---\nname: demo\nkein Ende'), null);
  assert.equal(parseSkillDocument(''), null);
  assert.equal(parseSkillDocument(undefined), null);
});

test('tolerates a BOM and leading blank lines', () => {
  const parsed = parseSkillDocument('﻿---\nname: demo\ndescription: d\n---\nBody');
  assert.equal(parsed.frontmatter.name, 'demo');
});

test('folds a block scalar description into one line', () => {
  const parsed = parseSkillDocument(
    [
      '---',
      'name: demo',
      'description: >-',
      '  Erste Zeile der Beschreibung,',
      '  zweite Zeile der Beschreibung.',
      'compatibility: cursor',
      '---',
      'Body',
    ].join('\n')
  );

  assert.equal(parsed.frontmatter.description, 'Erste Zeile der Beschreibung, zweite Zeile der Beschreibung.');
  // Der Schlüssel nach dem Block wird weiterhin gelesen.
  assert.equal(parsed.frontmatter.compatibility, 'cursor');
  assert.equal(parsed.body, 'Body');
});

test('keeps line breaks in a literal block scalar', () => {
  const parsed = parseSkillDocument(
    ['---', 'name: demo', 'description: |-', '  Zeile eins', '  Zeile zwei', '---', 'x'].join('\n')
  );

  assert.equal(parsed.frontmatter.description, 'Zeile eins\nZeile zwei');
});

test('honours the chomping indicator at the end of a block', () => {
  const block = (indicator) =>
    parseSkillDocument(['---', 'name: demo', `description: >${indicator}`, '  Text', '', '---', 'x'].join('\n'))
      .frontmatter.description;

  assert.equal(block('-'), 'Text');
  assert.equal(block(''), 'Text\n');
  assert.equal(block('+'), 'Text\n\n');
});

test('turns blank lines into breaks and leaves deeper indentation unfolded', () => {
  const parsed = parseSkillDocument(
    [
      '---',
      'name: demo',
      'description: >-',
      '  Absatz eins,',
      '  noch Absatz eins.',
      '',
      '  Absatz zwei.',
      '    Eingerückter Einschub.',
      '---',
      'x',
    ].join('\n')
  );

  assert.equal(
    parsed.frontmatter.description,
    'Absatz eins, noch Absatz eins.\nAbsatz zwei.\n  Eingerückter Einschub.'
  );
});

test('reads a block scalar that ends with the frontmatter and one with an explicit indent', () => {
  const trailing = parseSkillDocument(
    ['---', 'name: demo', 'description: >-', '  Letzte Angabe im Frontmatter.', '---', 'Body'].join('\n')
  );
  assert.equal(trailing.frontmatter.description, 'Letzte Angabe im Frontmatter.');
  assert.equal(trailing.body, 'Body');

  const explicit = parseSkillDocument(
    ['---', 'name: demo', 'description: |2-', '   Eine Spalte eingerückt.', '---', 'x'].join('\n')
  );
  assert.equal(explicit.frontmatter.description, ' Eine Spalte eingerückt.');
});

test('leaves an empty block scalar empty instead of keeping the indicator', () => {
  const parsed = parseSkillDocument(['---', 'name: demo', 'description: >-', 'compatibility: cursor', '---', 'x'].join('\n'));

  assert.equal(parsed.frontmatter.description, '');
  assert.equal(parsed.frontmatter.compatibility, 'cursor');
});

test('a nested block scalar neither overwrites a top-level key nor swallows what follows', () => {
  const parsed = parseSkillDocument(
    [
      '---',
      'name: demo',
      'description: Kurz und knapp',
      'metadata:',
      '  description: >-',
      '    Interner Text,',
      '    zweite Zeile.',
      '  version: "1.0.0"',
      '---',
      'x',
    ].join('\n')
  );

  assert.equal(parsed.frontmatter.description, 'Kurz und knapp');
  assert.equal(parsed.frontmatter.version, '1.0.0');
});

test('reads block scalars with CRLF line endings', () => {
  const parsed = parseSkillDocument(
    ['---', 'name: demo', 'description: >-', '  Erste Zeile,', '  zweite Zeile.', '---', 'Body'].join('\r\n')
  );

  assert.equal(parsed.frontmatter.description, 'Erste Zeile, zweite Zeile.');
});

test('continues a multi-line plain scalar instead of dropping the rest', () => {
  const parsed = parseSkillDocument(
    ['---', 'name: demo', 'description: Erste Zeile', '  zweite Zeile.', 'compatibility: cursor', '---', 'x'].join('\n')
  );

  assert.equal(parsed.frontmatter.description, 'Erste Zeile zweite Zeile.');
  assert.equal(parsed.frontmatter.compatibility, 'cursor');
});

test('a following line that looks like a key stays a key', () => {
  const parsed = parseSkillDocument(
    ['---', 'name: demo', 'description: Erste Zeile', '  tags: a, b', '---', 'x'].join('\n')
  );

  assert.equal(parsed.frontmatter.description, 'Erste Zeile');
  assert.equal(parsed.frontmatter.tags, 'a, b');
});
