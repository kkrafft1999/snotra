'use strict';

// Catch discipline: a `catch` rethrows, reports, logs, or says why it may stay
// quiet (#1000, AR-25, scenario ROB-1).
//
// The architecture review (#752) counted 673 catch sites in `src/`, 310 of them
// quiet without a word about why, and 149 `void fn()` calls in the renderer
// that throw their rejection away. Many are harmless cleanup or neutral probes —
// but nothing told those apart from a swallowed error. This guard makes the
// difference visible and stops it from growing.
//
// What it does
//
//  - Scans every file under `src/` and classifies each catch site:
//      rethrow     the block contains a `throw`
//      log         it calls `console.*`, `logger.*` or `log.*`
//      report      it reads the error it caught (passes it on, returns its
//                  message, checks its `code`) — or, for `.catch(handler)`, the
//                  handler is a function reference rather than an inline body
//      commented   a comment sits inside the block, or inside the `.catch(...)`
//      quiet       none of the above — `catch {}`, `catch { return null; }`,
//                  `.catch(() => {})`
//  - Counts the quiet ones per file and compares with
//    `test/catch-discipline-baseline.json`. A file may have no more quiet sites
//    than the baseline lists for it; a file the baseline does not list may have
//    none.
//  - Does the same for `void <call>;` in `src/renderer/` that is not followed
//    by `.catch(...)` — the renderer's fire-and-forget calls.
//
// The baseline may only shrink. The test also fails when the baseline lists
// MORE than the scan finds, so a fixed site has to be taken off the list in the
// same change; that is what keeps the number going down instead of sitting
// there as a tolerated mass.
//
// When it fails
//
//  - "new quiet catch": make the catch say something. Rethrow, report the error
//    to the user (`notices`), log it — or, if swallowing really is right (a
//    best-effort cleanup, a probe whose failure is an answer), write a comment
//    inside the catch that says WHY. Do not add to the baseline.
//  - "baseline too large": you fixed a site, good. Take the number down:
//        CATCH_BASELINE_UPDATE=1 node --test test/catch-discipline.test.js
//    That rewrites the baseline with the current counts and refuses to raise a
//    single one. Code that moved to another file shows up as a new entry on
//    purpose: that is a real change and gets judged, not carried over.
//  - `CATCH_BASELINE_UPDATE=init` writes the baseline from scratch, raises
//    included. It is for creating the file, not for getting a failing build
//    green; the diff in review shows every number that went up.
//
// Limits of the heuristic (there is no parser in the dependency set, and this
// guard adds none):
//
//  - Keyed per file and count, not per line, so moving code inside a file does
//    not break it. The flip side: swapping one quiet catch for another in the
//    same file goes unnoticed.
//  - "report" is lenient: reading the caught error at all counts, including
//    `if (error.code !== 'ENOENT') ...` that then does nothing with the rest.
//    It looks at the error, which is the discipline this guard asks for; whether
//    the handling is the right one is a review question.
//  - `.catch(handler)` is only seen when the argument is on a `.catch(` call;
//    `.then(ok, fail)` with a swallowing `fail` is not.
//  - `void` is treated as "fire and forget a promise". `void 0` is skipped.
//    Whether the callee is async is not resolved — a `void` on a call that
//    handles its own errors inside still counts, and is a candidate for the
//    comment this guard asks for.
//  - Strings, templates and regular expressions are blanked by a small lexer;
//    a regex literal after `)` or an identifier would be read as division. The
//    source has none, and the self-tests below pin the cases that matter.
//  - Generated files (`preload/*bundle.js`, `renderer/vendor`) are skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SRC_DIR, collectSourceFiles } = require('../scripts/source-files.js');

const BASELINE_FILE = path.join(__dirname, 'catch-discipline-baseline.json');
const GENERATED_FILES = new Set(['preload/bundle.js', 'preload/manual-bundle.js']);

// ---------------------------------------------------------------------------
// Lexer: the source with comments and literal contents blanked
// ---------------------------------------------------------------------------

/**
 * `masked` has the same length and line breaks as the source, with comments and
 * the contents of strings, templates and regular expressions replaced by
 * spaces — so an index into one is an index into the other. `comments` lists
 * the comment ranges. The `${…}` of a template stays code.
 */
function lex(source) {
  const n = source.length;
  const masked = source.split('');
  const comments = [];
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (masked[k] !== '\n' && masked[k] !== '\r') masked[k] = ' ';
  };
  const previousToken = () => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(masked[k])) k -= 1;
    return k < 0 ? '' : masked.slice(Math.max(0, k - 8), k + 1).join('');
  };
  // Whether a `/` here starts a regular expression rather than a division.
  const regexAllowed = () => {
    const before = previousToken();
    return before === '' || /([=(,:;!&|?{}[]|=>|\breturn|\btypeof|\bcase)$/.test(before);
  };

  function template() {
    // `i` is on the opening backtick; returns the index of the closing one.
    let k = i + 1;
    while (k < n && source[k] !== '`') {
      if (source[k] === '\\') {
        blank(k, k + 2);
        k += 2;
      } else if (source[k] === '$' && source[k + 1] === '{') {
        i = k + 2;
        code(true);
        k = i + 1; // `i` stopped on the brace that closes the expression
      } else {
        blank(k, k + 1);
        k += 1;
      }
    }
    return k;
  }

  /** Lexes code from `i`; with `untilBrace`, stops on the `}` that closes a `${`. */
  function code(untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = source[i];
      const next = source[i + 1];
      if (c === '/' && next === '/') {
        let end = i;
        while (end < n && source[end] !== '\n') end += 1;
        comments.push([i, end]);
        blank(i, end);
        i = end;
      } else if (c === '/' && next === '*') {
        const close = source.indexOf('*/', i + 2);
        const end = close === -1 ? n : close + 2;
        comments.push([i, end]);
        blank(i, end);
        i = end;
      } else if (c === '\'' || c === '"') {
        let k = i + 1;
        while (k < n && source[k] !== c && source[k] !== '\n') k += source[k] === '\\' ? 2 : 1;
        blank(i + 1, k);
        i = k + 1;
      } else if (c === '`') {
        const end = template();
        i = end + 1;
      } else if (c === '/' && regexAllowed()) {
        let k = i + 1;
        let inClass = false;
        while (k < n && source[k] !== '\n' && (inClass || source[k] !== '/')) {
          if (source[k] === '\\') k += 1;
          else if (source[k] === '[') inClass = true;
          else if (source[k] === ']') inClass = false;
          k += 1;
        }
        blank(i + 1, k);
        i = k + 1;
      } else {
        if (untilBrace) {
          if (c === '{') depth += 1;
          else if (c === '}') {
            if (depth === 0) return;
            depth -= 1;
          }
        }
        i += 1;
      }
    }
  }

  code(false);
  return { masked: masked.join(''), comments };
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const squash = (text) => text.replace(/\s+/g, ' ').trim();

/** Index just after the bracket that closes the one at `open`, or the end of text. */
function closing(masked, open) {
  const pair = { '(': ')', '{': '}', '[': ']' }[masked[open]];
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === masked[open]) depth += 1;
    else if (masked[i] === pair) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return masked.length;
}

const hasComment = (comments, from, to) => comments.some(([start, end]) => start < to && end > from);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LOGS = /\bconsole\.(log|warn|error|info|debug)\b|\b(logger|log)\.\w+\s*\(/;

/**
 * The class of one catch site. `names` are the identifiers the catch binds,
 * `from`/`to` its extent (for the comment check), `body` the masked code inside.
 */
function classify({ names, body, from, to, comments }) {
  if (/\bthrow\b/.test(body)) return 'rethrow';
  if (LOGS.test(body)) return 'log';
  if (names.some((name) => new RegExp(`(?<![.\\w$])${escapeRegExp(name)}(?![\\w$])`).test(body))) return 'report';
  if (hasComment(comments, from, to)) return 'commented';
  return 'quiet';
}

/** Every catch site in `source`: `try … catch` blocks and `.catch(handler)` calls. */
function findCatches(source) {
  const { masked, comments } = lex(source);
  const sites = [];

  for (const match of masked.matchAll(/(?<![.\w$])catch\s*(?:\(([^)]*)\))?\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    const end = closing(masked, open);
    // A comment trailing the closing brace on its own line belongs to the catch too.
    const lineEnd = masked.indexOf('\n', end);
    const to = lineEnd === -1 ? masked.length : lineEnd;
    sites.push({
      kind: 'try/catch',
      line: lineOf(masked, match.index),
      class: classify({
        names: (match[1] || '').match(/[\w$]+/g) || [],
        body: masked.slice(open + 1, end - 1),
        from: match.index,
        to: hasComment(comments, end, to) ? to : end,
        comments,
      }),
    });
  }

  for (const match of masked.matchAll(/\.catch\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const end = closing(masked, open);
    const args = masked.slice(open + 1, end - 1);
    const handler = args.trim();
    let cls;
    if (handler === '') cls = hasComment(comments, open, end) ? 'commented' : 'quiet';
    else if (/^[\w$.]+$/.test(handler)) cls = 'report'; // handled by a function that has a name
    else {
      const params = handler.match(/^(?:async\s*)?(?:function\s*[\w$]*\s*)?\(([^)]*)\)|^(?:async\s+)?([\w$]+)\s*=>/);
      const names = ((params && (params[1] ?? params[2])) || '').match(/[\w$]+/g) || [];
      const bodyStart = handler.search(/=>|\{/);
      cls = classify({ names, body: bodyStart === -1 ? handler : handler.slice(bodyStart), from: open, to: end, comments });
    }
    sites.push({ kind: '.catch()', line: lineOf(masked, match.index), class: cls });
  }
  return sites.sort((a, b) => a.line - b.line);
}

/**
 * `void <call>` statements and arrows (`() => void fn()`) without a `.catch` on
 * the call. `void 0` and `void` of anything that is not a call are skipped.
 */
function findVoidCalls(source) {
  const { masked } = lex(source);
  const sites = [];
  for (const match of masked.matchAll(/(?<![.\w$])void\s+(?!0\b)/g)) {
    const start = match.index + match[0].length;
    let depth = 0;
    let end = start;
    for (; end < masked.length; end += 1) {
      const c = masked[end];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && (c === ';' || c === ',')) break;
      else if (depth === 0 && c === '\n' && !/^\s*(\.|\?\.)/.test(masked.slice(end + 1, end + 40))) break;
    }
    const expression = masked.slice(start, end).trim();
    if (!/\)$/.test(expression)) continue; // not a call
    if (/\.catch\s*\([\s\S]*\)$/.test(expression)) continue;
    sites.push({ kind: 'void', line: lineOf(masked, match.index), text: squash(expression).slice(0, 70) });
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Census and baseline
// ---------------------------------------------------------------------------

const isRenderer = (file) => file.startsWith('renderer/');

function census() {
  const quiet = {};
  const voids = {};
  const classes = {};
  for (const file of collectSourceFiles()) {
    if (GENERATED_FILES.has(file)) continue;
    const source = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    const catches = findCatches(source);
    for (const site of catches) classes[site.class] = (classes[site.class] || 0) + 1;
    const quietSites = catches.filter((site) => site.class === 'quiet');
    if (quietSites.length) quiet[file] = quietSites;
    if (isRenderer(file)) {
      const found = findVoidCalls(source);
      if (found.length) voids[file] = found;
    }
  }
  return { quiet, voids, classes };
}

const counts = (byFile) => Object.fromEntries(
  Object.entries(byFile).map(([file, sites]) => [file, sites.length]).sort(([a], [b]) => a.localeCompare(b)),
);

function readBaseline() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    return { quietCatch: parsed.quietCatch || {}, voidCall: parsed.voidCall || {} };
  } catch {
    return { quietCatch: {}, voidCall: {} };
  }
}

/** Where the baseline holds more than the scan finds (shrunk) and where less (grown). */
function compare(found, baseline) {
  const grown = [];
  const shrunk = [];
  for (const file of new Set([...Object.keys(found), ...Object.keys(baseline)])) {
    const now = found[file] || 0;
    const allowed = baseline[file] || 0;
    if (now > allowed) grown.push({ file, now, allowed });
    else if (now < allowed) shrunk.push({ file, now, allowed });
  }
  return { grown, shrunk };
}

const describeSites = (sites, file, extra) => (sites[file] || [])
  .map((site) => `    ${file}:${site.line}  ${extra(site)}`).join('\n');

function writeBaseline(current, mode) {
  const old = readBaseline();
  const next = { quietCatch: counts(current.quiet), voidCall: counts(current.voids) };
  if (mode !== 'init') {
    for (const section of ['quietCatch', 'voidCall']) {
      for (const [file, count] of Object.entries(next[section])) {
        assert.ok(count <= (old[section][file] || 0), `Refusing to raise the baseline: ${file} has ${count} (${section}), the baseline ${old[section][file] || 0}. Fix the new site instead.`);
      }
    }
  }
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

const current = census();
if (process.env.CATCH_BASELINE_UPDATE) writeBaseline(current, process.env.CATCH_BASELINE_UPDATE);
const baseline = readBaseline();

function guard(name, section, found, sitesText) {
  const { grown, shrunk } = compare(counts(found), baseline[section]);
  test(`no new ${name} (#1000)`, () => {
    assert.deepEqual(
      grown,
      [],
      `New ${name} — more than the baseline in test/catch-discipline-baseline.json allows:\n`
        + `${grown.map(({ file, now, allowed }) => `  ${file}: ${now} found, ${allowed} allowed\n${describeSites(found, file, sitesText)}`).join('\n')}\n`
        + 'Make it say something (see the head of this test) — do not raise the baseline.',
    );
  });
  test(`the ${name} baseline lists nothing that is gone (#1000)`, () => {
    assert.deepEqual(
      shrunk,
      [],
      `The baseline lists more ${name} than there are:\n`
        + `${shrunk.map(({ file, now, allowed }) => `  ${file}: ${now} found, ${allowed} listed`).join('\n')}\n`
        + 'Tighten it: CATCH_BASELINE_UPDATE=1 node --test test/catch-discipline.test.js',
    );
  });
}

guard('quiet catch', 'quietCatch', current.quiet, (site) => site.kind);
guard('un-caught void call in the renderer', 'voidCall', current.voids, (site) => `void ${site.text}`);

// ---------------------------------------------------------------------------
// The scanner itself
// ---------------------------------------------------------------------------

const classesOf = (source) => findCatches(source).map((site) => site.class);

test('the scanner classifies try/catch blocks', () => {
  assert.deepEqual(classesOf('try { a(); } catch { }'), ['quiet']);
  assert.deepEqual(classesOf('try { a(); } catch (e) { return null; }'), ['quiet']);
  assert.deepEqual(classesOf('try { a(); } catch (e) { throw wrap(e); }'), ['rethrow']);
  assert.deepEqual(classesOf('try { a(); } catch (e) { console.warn("x"); }'), ['log']);
  assert.deepEqual(classesOf('try { a(); } catch (err) { logger.warn(1); }'), ['log']);
  assert.deepEqual(classesOf('try { a(); } catch (e) { return { ok: false, error: e.message }; }'), ['report']);
  assert.deepEqual(classesOf('try { a(); } catch ({ message }) { notices.post(message); }'), ['report']);
  assert.deepEqual(classesOf('try { a(); } catch { /* best effort: the window is gone */ }'), ['commented']);
  assert.deepEqual(classesOf('try { a(); } catch {\n  // why it is fine\n  return null;\n}'), ['commented']);
  assert.deepEqual(classesOf('try { a(); } catch { return null; } // best effort'), ['commented']);
  // A comment in the try body or above it explains the try, not the catch.
  assert.deepEqual(classesOf('// best effort\ntry { a(); // x\n} catch { return null; }'), ['quiet']);
});

test('the scanner classifies .catch() handlers', () => {
  assert.deepEqual(classesOf('p.catch(() => {});'), ['quiet']);
  assert.deepEqual(classesOf('p.catch(() => null);'), ['quiet']);
  assert.deepEqual(classesOf('p.catch(() => { /* gone */ });'), ['commented']);
  assert.deepEqual(classesOf('p.catch((e) => notices.post(e.message));'), ['report']);
  assert.deepEqual(classesOf('p.catch(function (e) { console.error(e); });'), ['log']);
  assert.deepEqual(classesOf('p.catch(handleError);'), ['report']);
  assert.deepEqual(classesOf('p.catch(console.error);'), ['report']);
  assert.deepEqual(classesOf('p.catch(e => { throw e; });'), ['rethrow']);
  assert.deepEqual(classesOf('p.catch(\n  () => {},\n);'), ['quiet']);
});

test('the scanner is not fooled by strings, templates, regular expressions and comments', () => {
  assert.deepEqual(classesOf('const s = "catch { }"; const t = `try { } catch { } ${x}`; const r = /catch\\s*{/;'), []);
  assert.deepEqual(classesOf('// } catch { }\n/* catch (e) { } */\nx();'), []);
  assert.deepEqual(classesOf('const t = `a ${f(() => { try { x(); } catch { } })} b`; try { y(); } catch { }'), ['quiet', 'quiet']);
  assert.deepEqual(classesOf("const r = /[/']/; try { y(); } catch { }"), ['quiet']);
  assert.deepEqual(classesOf('const k = a / b; try { y(); } catch { } const m = c / d;'), ['quiet']);
  assert.deepEqual(classesOf('try { y(); } catch (e) { const q = "}"; if (e) {} }'), ['report']);
});

test('the scanner finds void calls without a catch', () => {
  const texts = (source) => findVoidCalls(source).map((site) => site.text);
  assert.deepEqual(texts('void refresh();'), ['refresh()']);
  assert.deepEqual(texts('button.onclick = () => void save(a, b);'), ['save(a, b)']);
  assert.deepEqual(texts('void (async () => { await x(); })();'), ['(async () => { await x(); })()']);
  assert.deepEqual(texts('void api.load()\n  .then(render);'), ['api.load() .then(render)']);
  assert.deepEqual(texts('void refresh().catch(() => {});'), []);
  assert.deepEqual(texts('void api.load()\n  .catch(report);'), []);
  assert.deepEqual(texts('const x = void 0; if (a === void 0) y();'), []);
  assert.deepEqual(texts('// void ignored()\nconst s = "void nope()";'), []);
});

test('the lexer reads every source file to a balanced end', () => {
  // A literal it mistook for code (or the other way round) leaves a bracket
  // open or closed too often; this is the cheapest way to notice.
  const unbalanced = [];
  for (const file of collectSourceFiles()) {
    if (GENERATED_FILES.has(file)) continue;
    const { masked } = lex(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'));
    const open = { '{': 0, '(': 0, '[': 0 };
    const partner = { '}': '{', ')': '(', ']': '[' };
    for (const c of masked) {
      if (c in open) open[c] += 1;
      else if (c in partner) open[partner[c]] -= 1;
    }
    if (Object.values(open).some((count) => count !== 0)) unbalanced.push(file);
  }
  assert.deepEqual(unbalanced, []);
});

test('every census counts something', () => {
  // A scanner that stopped matching would turn the guard green for the wrong reason.
  const found = Object.values(current.quiet).flat().length;
  assert.ok(found > 0 && current.classes.rethrow > 0 && current.classes.log > 0 && current.classes.report > 0 && current.classes.commented > 0,
    `Expected every class to occur in src/, got ${JSON.stringify(current.classes)} and ${found} quiet.`);
});
