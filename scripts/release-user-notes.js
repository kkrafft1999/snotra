#!/usr/bin/env node
'use strict';

// Writes the section for the user on top of a published release (#1072).
//
// GitHub generates the release notes from the pull request titles — written
// for developers, and most of them about tests, CI and documentation. The
// update dialog shows none of that: it shows only the section between these
// markers, in the interface language (src/renderer/components/UpdateDialog.js,
// userReleaseNotes()). The markers are HTML comments, so the release page on
// GitHub shows both languages above the generated list and no markers.
//
//   node scripts/release-user-notes.js vX.Y.Z --en <file> --de <file> [--dry-run]
//
// Both files are plain Markdown. A section that is already there is replaced,
// so the script can run again after a correction. --dry-run prints the new
// body instead of editing the release.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = (name) => `<!-- snotra:notes ${name} -->`;
const LANGUAGES = ['en', 'de'];
/** An earlier section, from the first marker to the end marker and the blank lines after it. */
const EXISTING = /<!--\s*snotra:notes\s+[a-z]+\s*-->[^]*?<!--\s*snotra:notes\s+end\s*-->\s*/i;

/** The marked section for `texts` ({ en, de }), ending in the end marker. */
function buildSection(texts) {
  const parts = [];
  for (const lang of LANGUAGES) {
    const text = String(texts[lang] ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new Error(`The ${lang} text is empty — the dialog needs both languages.`);
    if (/<!--\s*snotra:notes/i.test(text)) throw new Error(`The ${lang} text contains a snotra:notes marker.`);
    parts.push(MARKER(lang), text);
  }
  parts.push(MARKER('end'));
  return parts.join('\n');
}

/** `body` with `section` on top, in place of an earlier one. */
function applySection(body, section) {
  const rest = String(body ?? '').replace(/\r\n?/g, '\n').replace(EXISTING, '').trim();
  return rest ? `${section}\n\n${rest}\n` : `${section}\n`;
}

function parseArgs(argv) {
  const args = { tag: null, files: {}, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--en' || arg === '--de') args.files[arg.slice(2)] = argv[++i];
    else if (!args.tag) args.tag = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.tag || !/^v\d+\.\d+\.\d+/.test(args.tag)) throw new Error('Name the release tag, e.g. v1.25.0.');
  for (const lang of LANGUAGES) {
    if (!args.files[lang]) throw new Error(`Missing --${lang} <file>.`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const texts = {};
  for (const lang of LANGUAGES) texts[lang] = fs.readFileSync(args.files[lang], 'utf8');
  const section = buildSection(texts);

  const body = execFileSync('gh', ['release', 'view', args.tag, '--json', 'body', '--jq', '.body'], { encoding: 'utf8' });
  const next = applySection(body, section);
  if (args.dryRun) {
    process.stdout.write(next);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-release-notes-'));
  const file = path.join(dir, 'body.md');
  try {
    fs.writeFileSync(file, next, 'utf8');
    execFileSync('gh', ['release', 'edit', args.tag, '--notes-file', file], { stdio: 'inherit' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`User notes written to ${args.tag}.`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { buildSection, applySection, parseArgs };
