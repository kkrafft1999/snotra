'use strict';

/**
 * A third language needs a catalogue and nothing else (AR-32, #1007).
 *
 * The code does not name a language: lists come from `LOCALES`, plural rules
 * from `Intl.PluralRules`, the speech language from the registry
 * (`src/shared/i18n/locales.js`). This test keeps it that way — it reads the
 * source and fails on a `'de'` / `'en'` string, on an object key `de:` / `en:`
 * and on a member access `.de` / `.en`, outside the registration points.
 *
 * What the test does NOT look at: variables that happen to be called `de`,
 * words inside longer strings (`"de" or "en"` in a sentence), comments, and
 * regular expressions.
 *
 * If it fails after you added a literal: use `APP_LOCALES.EN` / `DEFAULT_LOCALE`
 * / `LOCALES` / `speechLanguageFor()` from `src/shared/i18n`, whichever says
 * what you mean. Only a new *registration* belongs on the lists below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCANNED = ['src', 'scripts', path.join('manual', 'scripts')];
const SOURCE_FILE = /\.(?:js|mjs|cjs)$/;
// Built or third-party code: the bundles `sync-vendor` writes and the manual that
// `bundle-manual` copies into the app.
const SKIPPED_DIRECTORIES = new Set(['src/renderer/generated', 'src/renderer/vendor', 'src/manual']);

/**
 * Where a language is named by definition — the registration points. Anything
 * under a listed directory counts.
 */
const REGISTRATION_POINTS = [
  { path: 'src/shared/contracts/enums.js', why: 'APP_LOCALES: the codes of the languages' },
  { path: 'src/shared/i18n/locales.js', why: 'the registry: names, speech languages, catalogues' },
  { path: 'src/shared/i18n/messages/', why: 'the catalogues, with `lang="…"` in their markup' },
  {
    path: 'src/renderer/manual/settings-help-links.js',
    why: "the manual's own headings, quoted per language — test/settings-help.test.js checks each against the bundle",
  },
];

/**
 * What stays named on purpose. Each entry says how many literals the file may
 * keep — a new one in the same file fails as well, and so does a file that no
 * longer needs its entry (`'any'` for demo content that grows with the manual).
 * Keep this list short.
 */
const ALLOWED = [
  {
    path: 'manual/scripts/screenshots.mjs',
    count: 'any',
    why: 'demo content per language (the sowing calendar, the memory entries, the folder name); the list of languages is derived',
  },
  {
    path: 'manual/scripts/check-content.mjs',
    count: 3,
    why: 'the manual is its own package with its own language list (manual/astro.config.mjs); this checks its pages',
  },
  {
    path: 'src/main/services/update-installer.js',
    count: 1,
    why: 'English text for the helper script, which has no language setting (#1067 is rewriting this file)',
  },
];

const LOCALE_CODES = new Set(['de', 'en']);

/**
 * Finds the literals in JavaScript source: strings equal to a language code,
 * and `de` / `en` as an object key or member. A small scanner rather than a
 * regular expression, so that comments and prose inside strings stay out.
 */
function findLocaleLiterals(source) {
  const hits = [];
  let line = 1;
  let i = 0;
  let previous = '';
  // Each open template literal is a frame; `depth` counts braces of the code
  // inside its `${ … }` so the closing one is told from an ordinary `}`.
  const templates = [];
  const regexAllowedAfter = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof']);

  const next = () => source[i + 1];
  const isIdentifierStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentifierPart = (c) => /[\w$]/.test(c);

  function scanString(quote) {
    let text = '';
    i += 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') { text += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
      if (source[i] === '\n') line += 1;
      text += source[i];
      i += 1;
    }
    i += 1;
    return text;
  }

  // Reads template text up to the closing backtick or the next `${`.
  function scanTemplateText() {
    let text = '';
    let hasExpression = false;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { text += c + (source[i + 1] ?? ''); i += 2; continue; }
      if (c === '`') { i += 1; return { text, hasExpression, open: false }; }
      if (c === '$' && next() === '{') { i += 2; hasExpression = true; return { text, hasExpression, open: true }; }
      if (c === '\n') line += 1;
      text += c;
      i += 1;
    }
    return { text, hasExpression, open: false };
  }

  function scanRegex() {
    i += 1;
    let inClass = false;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i += 1; break; }
      i += 1;
    }
    while (i < source.length && isIdentifierPart(source[i])) i += 1;
  }

  while (i < source.length) {
    const c = source[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '/' && next() === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (c === '/' && next() === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let k = i; k < stop; k += 1) if (source[k] === '\n') line += 1;
      i = stop;
      continue;
    }
    if (c === '\'' || c === '"') {
      const startLine = line;
      const text = scanString(c);
      if (LOCALE_CODES.has(text)) hits.push({ line: startLine, text: `${c}${text}${c}` });
      previous = 'string';
      continue;
    }
    if (c === '`') {
      i += 1;
      const startLine = line;
      const result = scanTemplateText();
      if (!result.hasExpression && LOCALE_CODES.has(result.text)) hits.push({ line: startLine, text: `\`${result.text}\`` });
      if (result.open) templates.push({ depth: 0 });
      previous = 'string';
      continue;
    }
    if (c === '{' && templates.length) { templates[templates.length - 1].depth += 1; previous = '{'; i += 1; continue; }
    if (c === '}' && templates.length) {
      const frame = templates[templates.length - 1];
      if (frame.depth === 0) {
        templates.pop();
        i += 1;
        const result = scanTemplateText();
        if (result.open) templates.push({ depth: 0 });
        previous = 'string';
        continue;
      }
      frame.depth -= 1;
      previous = '}';
      i += 1;
      continue;
    }
    if (c === '/' && regexAllowedAfter.has(previous)) { scanRegex(); previous = 'regex'; continue; }
    if (isIdentifierStart(c)) {
      const start = i;
      while (i < source.length && isIdentifierPart(source[i])) i += 1;
      const word = source.slice(start, i);
      if (LOCALE_CODES.has(word)) {
        const rest = source.slice(i).match(/^\s*(:)?/)[1];
        const isMember = previous === '.';
        const isKey = rest === ':' && (previous === '{' || previous === ',');
        if (isMember || isKey) hits.push({ line, text: isMember ? `.${word}` : `${word}:` });
      }
      previous = word === 'return' || word === 'typeof' ? word : 'identifier';
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < source.length && /[\w.]/.test(source[i])) i += 1;
      previous = 'number';
      continue;
    }
    previous = c;
    i += 1;
  }
  return hits;
}

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function listSources(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(relative(full))) found.push(...listSources(full));
    } else if (SOURCE_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

test('the scanner finds literals and leaves prose and comments alone', () => {
  const source = [
    "const a = 'de';",
    'const b = "en";',
    'const c = `de`;',
    "const d = { en: 1, de: 2 };",
    'const e = table.de;',
    "const f = 'say \"de\" or \"en\"';",
    '// \'de\' in a comment',
    '/* "en" in a block comment */',
    "const g = /['\"]de['\"]/.test(x);",
    'const de = locale === a; const h = de ? x : y;',
    'const i = `${a}-de`;',
    "const j = `${ { k: 'en' }.k }`;",
  ].join('\n');
  assert.deepEqual(
    findLocaleLiterals(source).map((hit) => `${hit.line}:${hit.text}`),
    ["1:'de'", '2:"en"', '3:`de`', '4:en:', '4:de:', '5:.de', "12:'en'"]
  );
});

test('no language is named outside the registration points', () => {
  const allowed = new Map(ALLOWED.map((entry) => [entry.path, entry]));
  const files = SCANNED.flatMap((directory) => {
    const full = path.join(ROOT, directory);
    return fs.existsSync(full) ? listSources(full) : [];
  });
  const stray = [];
  const counts = new Map();

  for (const file of files) {
    const name = relative(file);
    if (REGISTRATION_POINTS.some((point) => (point.path.endsWith('/') ? name.startsWith(point.path) : name === point.path))) {
      continue;
    }
    const hits = findLocaleLiterals(fs.readFileSync(file, 'utf8'));
    if (!hits.length) continue;
    if (allowed.has(name)) { counts.set(name, hits.length); continue; }
    for (const hit of hits) stray.push(`${name}:${hit.line}  ${hit.text}`);
  }

  assert.deepEqual(
    stray,
    [],
    'a language is named in the code. A third language would need this changed — derive it instead: ' +
      '`APP_LOCALES.EN` for "English on purpose", `DEFAULT_LOCALE` for the fallback, `LOCALES` for a list, ' +
      '`speechLanguageFor()` / `manualPathPrefix()` / `localeName()` for what a language knows about itself ' +
      '(src/shared/i18n). A new registration belongs in src/shared/i18n/locales.js, not on the allow-list of this test.'
  );

  for (const entry of ALLOWED) {
    if (entry.count === 'any') continue;
    assert.equal(
      counts.get(entry.path) ?? 0,
      entry.count,
      `${entry.path} is allowed ${entry.count} literal(s) (${entry.why}) but has ${counts.get(entry.path) ?? 0} — ` +
        'update the entry in test/locale-literals.test.js, or remove it once the literals are gone.'
    );
  }
});

test('the allow-list names files that exist', () => {
  for (const entry of [...REGISTRATION_POINTS, ...ALLOWED]) {
    assert.ok(fs.existsSync(path.join(ROOT, entry.path)), `${entry.path} is on a list of test/locale-literals.test.js but does not exist`);
  }
});

test('every registered language has a catalogue, a name and a speech language', () => {
  const { LOCALES, LOCALE_INFO, MESSAGES } = require('../src/shared/i18n');
  assert.deepEqual(LOCALE_INFO.map((info) => info.code), [...LOCALES]);
  for (const info of LOCALE_INFO) {
    assert.ok(MESSAGES[info.code] && Object.keys(MESSAGES[info.code]).length > 0, `${info.code}: no catalogue`);
    assert.match(info.name, /\S/, `${info.code}: no name`);
    assert.match(info.speechLanguage, /^[a-z]{2,3}$/, `${info.code}: no speech language`);
  }
});

test('every registered language has words in the memory file tables', () => {
  const { LOCALES } = require('../src/shared/i18n');
  const { MEMORY_FILE_HEADINGS, SELF_ORIGIN_MARKERS } = require('../src/shared/contracts/memory');
  for (const locale of LOCALES) {
    assert.ok(MEMORY_FILE_HEADINGS[locale], `${locale}: no memory file headings in src/shared/contracts/memory.js`);
    assert.ok(SELF_ORIGIN_MARKERS[locale], `${locale}: no self-origin marker in src/shared/contracts/memory.js`);
  }
});
