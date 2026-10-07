// Fails when the manual is not complete: in both languages, and with every
// screenshot it shows.
//
// Starlight quietly falls back to the English page when a German one is
// missing. The project's language rule says a lagging German version is a
// defect (.claude/rules/language.md), so the build stops instead:
//
//   - every page under src/content/docs/ needs its counterpart under
//     src/content/docs/de/ at the same path, and the other way round;
//   - pages are plain Markdown (.md) only — no MDX, so the in-app help planned
//     in #777 can render the same files;
//   - the UI strings in src/content/i18n/ carry the same keys in both files;
//   - every screenshot a page shows, `![Alt](screenshots/<motif>.webp)`, exists
//     in all four variants under public/screenshots/ (#779). The remark plugin
//     throws on a missing one as well, but Astro only logs that and builds the
//     page empty, so the check has to come first.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/content/', import.meta.url));
const docsDir = join(root, 'docs');
const secondary = 'de';

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

const problems = [];
const english = new Set();
const german = new Set();

for (const file of listFiles(docsDir)) {
  const rel = relative(docsDir, file).split(sep).join('/');
  if (rel.split('/').some((part) => part.startsWith('_') || part.startsWith('.'))) continue;
  if (!rel.endsWith('.md')) {
    problems.push(`${rel}: only plain Markdown (.md) is allowed in the manual`);
    continue;
  }
  if (rel.startsWith(`${secondary}/`)) german.add(rel.slice(secondary.length + 1));
  else english.add(rel);
}

for (const page of english) {
  if (!german.has(page)) problems.push(`${page}: German translation missing (expected ${secondary}/${page})`);
}
for (const page of german) {
  if (!english.has(page)) problems.push(`${secondary}/${page}: English source missing (expected ${page})`);
}

const keysOf = (lang) => Object.keys(JSON.parse(readFileSync(join(root, 'i18n', `${lang}.json`), 'utf8')));
const enKeys = new Set(keysOf('en'));
const deKeys = new Set(keysOf(secondary));
for (const key of enKeys) if (!deKeys.has(key)) problems.push(`i18n/${secondary}.json: key "${key}" missing`);
for (const key of deKeys) if (!enKeys.has(key)) problems.push(`i18n/en.json: key "${key}" missing`);

const screenshotDir = fileURLToPath(new URL('../public/screenshots/', import.meta.url));
const motifs = new Set();
for (const file of listFiles(docsDir).filter((f) => f.endsWith('.md'))) {
  for (const [, motif] of readFileSync(file, 'utf8').matchAll(/\]\((?:\.\/)?screenshots\/([a-z0-9-]+)\.webp\)/g)) {
    motifs.add(motif);
  }
}
for (const motif of motifs) {
  for (const lang of ['en', secondary]) {
    for (const theme of ['light', 'dark']) {
      const name = `${motif}.${lang}.${theme}.webp`;
      if (!existsSync(join(screenshotDir, name))) {
        problems.push(`screenshot public/screenshots/${name} missing — run \`npm run screenshots -- ${motif}\``);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Manual content check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Manual content check passed: ${english.size} page(s) in English and German, ${motifs.size} screenshot motif(s).`);
