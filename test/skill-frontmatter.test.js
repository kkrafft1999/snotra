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
