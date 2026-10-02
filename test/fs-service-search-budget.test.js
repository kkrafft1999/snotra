const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');

// SEARCH_MAX_OUTPUT_CHARS in fs-service.js.
const OUTPUT_BUDGET = 64000;

function makeService(extra = {}) {
  return createFsService({ fs, path, maxReadFileBytes: 2 * 1024 * 1024, ...extra });
}

async function makeRoot(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, 'utf8');
  }
  return root;
}

// A sensitivity check that lets the test act at the first hit, and never
// leaves one out.
function onFirstHit(fn) {
  let fired = false;
  return {
    isSensitivePath: () => false,
    isSensitiveLine: () => {
      if (!fired) {
        fired = true;
        fn();
      }
      return false;
    },
  };
}

test('search_in_files stops at its character budget and says why (#644)', async (t) => {
  // A minified bundle: 2,000 lines of 500 characters, every one a hit. With
  // ten context lines and 200 results this used to return 1.7 million characters.
  const line = 'x'.repeat(500);
  const root = await makeRoot(t, { 'bundle.log': Array.from({ length: 2000 }, () => line).join('\n') });
  const out = await makeService().runSearchInFilesTool({ query: 'x', context_lines: 10, max_results: 200 }, root);
  const result = JSON.parse(out);

  assert.ok(out.length < OUTPUT_BUDGET + 2000, `output has ${out.length} characters`);
  assert.ok(JSON.stringify(result.matches).length <= OUTPUT_BUDGET);
  assert.ok(result.matches.length > 0 && result.matches.length < 200);
  assert.equal(result.truncated, true);
  assert.match(result.truncated_reason, /size limit of 64000 characters/);
  assert.match(result.truncated_reason, /context_lines/);
});

test('search_in_files below the budget carries no truncated_reason (#644)', async (t) => {
  const root = await makeRoot(t, { 'a.txt': 'hit\nmiss\nhit\n' });
  const result = JSON.parse(await makeService().runSearchInFilesTool({ query: 'hit' }, root));
  assert.equal(result.matches.length, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.truncated_reason, undefined);
});

test('an aborted literal search returns after the first file (#644)', async (t) => {
  const files = {};
  for (let i = 0; i < 20; i++) files[`f${String(i).padStart(2, '0')}.txt`] = 'hit\n';
  const root = await makeRoot(t, files);
  const controller = new AbortController();
  const result = JSON.parse(
    await makeService().runSearchInFilesTool({ query: 'hit' }, root, {
      abortSignal: controller.signal,
      sensitivity: onFirstHit(() => controller.abort()),
    })
  );
  assert.equal(result.aborted, true);
  assert.match(result.error, /cancelled/);
  assert.equal(result.files_scanned, 1);
});

test('an aborted regex search terminates its worker instead of waiting for the time budget (#644)', async (t) => {
  // b.txt keeps the worker busy for far longer than the test may take; only
  // terminating it on abort ends the call early.
  const root = await makeRoot(t, { 'a.txt': 'harmlos!', 'b.txt': `${'a'.repeat(400)}\n` });
  const controller = new AbortController();
  const svc = makeService({ regexSearchTimeBudgetMs: 30000 });
  const started = Date.now();
  const result = JSON.parse(
    await svc.runSearchInFilesTool({ query: 'a*a*a*a*!', is_regex: true }, root, {
      abortSignal: controller.signal,
      sensitivity: onFirstHit(() => setTimeout(() => controller.abort(), 100)),
    })
  );
  const elapsed = Date.now() - started;
  assert.equal(result.aborted, true);
  assert.match(result.error, /cancelled/);
  assert.equal(result.files_scanned, 2);
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
});

test('the registry hands the run abort signal to search_in_files and find_files (#644)', async (t) => {
  const root = await makeRoot(t, { 'a.txt': 'hit\n' });
  const registry = createWorkspaceToolRegistry({ fsService: makeService() });
  const controller = new AbortController();
  controller.abort();
  const context = { workspaceRoot: root, approved: true, abortSignal: controller.signal };

  const searched = JSON.parse(await registry.execute('search_in_files', { query: 'hit' }, context));
  assert.equal(searched.aborted, true);
  assert.deepEqual(searched.matches, []);

  const found = JSON.parse(await registry.execute('find_files', { pattern: '*' }, context));
  assert.equal(found.aborted, true);
  assert.deepEqual(found.results, []);
});
