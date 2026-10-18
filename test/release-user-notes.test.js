const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSection, applySection, parseArgs } = require('../scripts/release-user-notes');
const { importRenderer } = require('./helpers/dom.js');

// #1072: the release skill puts a section for the user on top of the release,
// and the update dialog shows only that section.

const GENERATED = [
  "## What's Changed",
  '* Measure the performance budgets (#984) by @kkrafft1999 in https://github.com/kkrafft1999/snotra/pull/1052',
  '',
  '**Full Changelog**: https://github.com/kkrafft1999/snotra/compare/v1.24.0...v1.24.1',
].join('\r\n');

const TEXTS = {
  en: '- **Edit text files in the preview.** Changes are saved as you type.\r\n',
  de: '- **Textdateien in der Vorschau bearbeiten.** Änderungen werden beim Tippen gespeichert.',
};

test('the section goes on top of the generated notes', () => {
  const body = applySection(GENERATED, buildSection(TEXTS));
  assert.equal(body, [
    '<!-- snotra:notes en -->',
    '- **Edit text files in the preview.** Changes are saved as you type.',
    '<!-- snotra:notes de -->',
    '- **Textdateien in der Vorschau bearbeiten.** Änderungen werden beim Tippen gespeichert.',
    '<!-- snotra:notes end -->',
    '',
    "## What's Changed",
    '* Measure the performance budgets (#984) by @kkrafft1999 in https://github.com/kkrafft1999/snotra/pull/1052',
    '',
    '**Full Changelog**: https://github.com/kkrafft1999/snotra/compare/v1.24.0...v1.24.1',
    '',
  ].join('\n'));
});

test('running it again replaces the section instead of stacking a second one', () => {
  const once = applySection(GENERATED, buildSection(TEXTS));
  const twice = applySection(once, buildSection({ en: '- Corrected', de: '- Korrigiert' }));
  assert.equal((twice.match(/snotra:notes en -->/g) || []).length, 1);
  assert.match(twice, /^<!-- snotra:notes en -->\n- Corrected\n/);
  assert.equal(twice.includes('Edit text files'), false);
  assert.match(twice, /## What's Changed/);
});

test('both languages are required, and the texts may not carry markers', () => {
  assert.throws(() => buildSection({ en: '- Something', de: '  ' }), /de text is empty/);
  assert.throws(() => buildSection({ en: '<!-- snotra:notes end -->', de: '- x' }), /contains a snotra:notes marker/);
});

test('arguments: a tag and one file per language', () => {
  assert.deepEqual(parseArgs(['v1.25.0', '--en', 'a.md', '--de', 'b.md', '--dry-run']),
    { tag: 'v1.25.0', files: { en: 'a.md', de: 'b.md' }, dryRun: true });
  assert.throws(() => parseArgs(['1.25.0', '--en', 'a.md', '--de', 'b.md']), /release tag/);
  assert.throws(() => parseArgs(['v1.25.0', '--en', 'a.md']), /--de/);
});

test('what the script writes is what the update dialog reads', async () => {
  const { userReleaseNotes } = await importRenderer('components', 'UpdateDialog.js');
  const body = applySection(GENERATED, buildSection(TEXTS));
  assert.equal(userReleaseNotes(body, 'en'), '- **Edit text files in the preview.** Changes are saved as you type.');
  assert.equal(userReleaseNotes(body, 'de'), TEXTS.de);
});
