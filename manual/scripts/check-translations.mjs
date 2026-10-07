// Fails when the manual is not complete in both languages.
//
// Starlight quietly falls back to the English page when a German one is
// missing. The project's language rule says a lagging German version is a
// defect (.claude/rules/language.md), so the build stops instead:
//
//   - every page under src/content/docs/ needs its counterpart under
//     src/content/docs/de/ at the same path, and the other way round;
//   - pages are plain Markdown (.md) only — no MDX, so the in-app help planned
//     in #777 can render the same files;
//   - the UI strings in src/content/i18n/ carry the same keys in both files.
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

if (problems.length > 0) {
  console.error(`Manual translation check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`Manual translation check passed: ${english.size} page(s) in English and German.`);
