#!/usr/bin/env node
'use strict';

// Lists the pull requests since the last release that changed what a user can
// see without touching the user manual (#780). Run by the release skill before
// it tags; it reports and never blocks — whether a change needs a manual page
// is a judgement, and the report only makes sure it was made.
//
//   node scripts/manual-upkeep-report.js [<since-ref>]
//
// Without an argument it starts at the last release tag (vX.Y.Z, release
// candidates left out). Every squash commit on main is one pull request. A
// pull request counts as covered when it touched manual/, or when its
// description ticks "User manual not affected" from
// .github/pull_request_template.md. The description is read with `gh`; without
// it the report says so instead of guessing.

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Paths whose changes can reach a user: the app itself and its system skills. */
const USER_FACING = ['src/', 'system-skills/'];
/** Changes here change what the screenshots show. */
const UI = ['src/renderer/'];
const MANUAL = 'manual/';

/** The ticked checkbox from the pull request template. */
const NOT_AFFECTED = /^\s*[-*]\s*\[[xX]\]\s*User manual not affected/m;

function pullRequestNumber(subject) {
  const match = /\(#(\d+)\)\s*$/.exec(subject);
  return match ? Number(match[1]) : null;
}

/**
 * Sorts one pull request. `body` is its description, or null when it could not
 * be read.
 * @returns {'internal' | 'covered' | 'declared' | 'unknown' | 'missing'}
 */
function classify({ files, body }) {
  const userFacing = files.some((file) => USER_FACING.some((prefix) => file.startsWith(prefix)));
  if (!userFacing) return 'internal';
  if (files.some((file) => file.startsWith(MANUAL))) return 'covered';
  if (body == null) return 'unknown';
  return NOT_AFFECTED.test(body) ? 'declared' : 'missing';
}

function touchesUi(files) {
  return files.some((file) => UI.some((prefix) => file.startsWith(prefix)));
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function lastReleaseTag() {
  return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', '--exclude', '*-*');
}

function readBody(number) {
  if (number == null) return null;
  try {
    return execFileSync('gh', ['pr', 'view', String(number), '--json', 'body', '--jq', '.body'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function collect(since) {
  const log = git('log', '--first-parent', '--format=%H%x09%s', `${since}..HEAD`);
  if (!log) return [];
  return log.split('\n').map((line) => {
    const [sha, subject] = line.split('\t');
    const files = git('show', '--name-only', '--format=', sha).split('\n').filter(Boolean);
    const number = pullRequestNumber(subject);
    const status = classify({ files, body: null });
    const body = status === 'unknown' ? readBody(number) : null;
    return {
      sha: sha.slice(0, 7),
      subject,
      number,
      status: status === 'unknown' ? classify({ files, body }) : status,
      ui: touchesUi(files),
    };
  });
}

function main() {
  const since = process.argv[2] || lastReleaseTag();
  const entries = collect(since);
  const label = (entry) => `  ${entry.number ? `#${entry.number}` : entry.sha}  ${entry.subject}`;
  const section = (title, list) => {
    if (list.length === 0) return;
    console.log(`\n${title}`);
    for (const entry of list) console.log(label(entry));
  };

  console.log(`User manual since ${since}: ${entries.length} change(s) on this branch.`);
  section('Changed user-visible code, manual not touched and not declared unaffected:',
    entries.filter((e) => e.status === 'missing'));
  section('Description could not be read (no gh?), check by hand:',
    entries.filter((e) => e.status === 'unknown'));
  section('Declared "User manual not affected":', entries.filter((e) => e.status === 'declared'));
  section('Updated the manual:', entries.filter((e) => e.status === 'covered'));
  section('Changed the UI — regenerate the screenshots (cd manual && npm run screenshots):',
    entries.filter((e) => e.ui));
  if (!entries.some((e) => e.status === 'missing' || e.status === 'unknown')) {
    console.log('\nNothing left open for the manual.');
  }
}

module.exports = { classify, pullRequestNumber, touchesUi, NOT_AFFECTED };

if (require.main === module) main();
