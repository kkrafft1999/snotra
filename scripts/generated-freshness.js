'use strict';

/**
 * Whether the files `sync-renderer-vendor.js` generates are as new as their
 * sources (#919).
 *
 * The preload bundles and the renderer's copies of `src/shared/` are built,
 * not tracked. `npm test` and `npm run test:e2e` rebuild them in their pre-
 * hooks; `node --test` on a single file does not. After a pull or an edit in
 * `src/shared/`, such a run tests yesterday's contracts against today's code —
 * a missing key shows up as its raw name, a missing export as a send that
 * throws. The test helpers call `assertGeneratedFresh()` once per process and
 * stop with the remedy instead.
 *
 * Plain mtimes: esbuild writes its output on every build, and git gives a
 * file it changes on checkout the time of the checkout.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Built from the source folders below. */
const BUILT = [
  'src/preload/bundle.js',
  'src/preload/manual-bundle.js',
  'src/renderer/generated/contracts.js',
  'src/renderer/generated/i18n.js',
  'src/renderer/generated/skill-frontmatter.js',
];
const SOURCE_DIRS = ['src/preload', 'src/shared'];
/** Copied from node_modules — only missing in a worktree that never synced. */
const COPIED = ['src/renderer/vendor/marked.umd.js', 'src/renderer/vendor/purify.min.js'];

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function newestSource(root) {
  const built = new Set(BUILT.map((rel) => path.join(root, rel)));
  let newest = { file: null, mtimeMs: 0 };
  for (const dir of SOURCE_DIRS) {
    const base = path.join(root, dir);
    for (const rel of fs.readdirSync(base, { recursive: true })) {
      const file = path.join(base, String(rel));
      if (!file.endsWith('.js') || built.has(file)) continue;
      const mtimeMs = mtimeOf(file);
      if (mtimeMs !== null && mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
    }
  }
  return newest;
}

/** What is missing or older than its sources, as sentences; empty when all is fresh. */
function staleGenerated(root = ROOT) {
  const problems = [];
  for (const rel of COPIED) {
    if (mtimeOf(path.join(root, rel)) === null) problems.push(`${rel} is missing`);
  }
  const newest = newestSource(root);
  for (const rel of BUILT) {
    const mtimeMs = mtimeOf(path.join(root, rel));
    if (mtimeMs === null) problems.push(`${rel} is missing`);
    else if (mtimeMs < newest.mtimeMs) {
      problems.push(`${rel} is older than ${path.relative(root, newest.file).split(path.sep).join('/')}`);
    }
  }
  return problems;
}

let checked = false;

/** Throws with the remedy when a generated file is stale; checks once per process. */
function assertGeneratedFresh(root = ROOT) {
  if (checked) return;
  const problems = staleGenerated(root);
  if (problems.length > 0) {
    throw new Error([
      'The generated preload and renderer files do not match their sources:',
      ...problems.map((problem) => `  - ${problem}`),
      'Run `npm run sync-vendor` first. `npm test` and `npm run test:e2e` do that by',
      'themselves; `node --test` on a single file does not.',
    ].join('\n'));
  }
  checked = true;
}

module.exports = { staleGenerated, assertGeneratedFresh };
