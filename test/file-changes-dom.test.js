// "Show changes" in the renderer (#348), against the real markup: the rows of
// the diff, the view in the preview column with its states, the
// "Content | Changes" switch of the host, and the line of changed files under
// a message's tool log.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const item = (name) => ({ path: `/ws/${name}`, name, size: 10, modified: 1 });

const TEXT_RESULT = {
  ok: true,
  status: 'text',
  created: false,
  added: 2,
  removed: 1,
  changedSince: null,
  segments: [
    { op: 'equal', count: 10 },
    { op: 'delete', count: 1 },
    { op: 'insert', count: 2 },
    { op: 'equal', count: 10 },
  ],
  beforeLines: [...Array.from({ length: 10 }, (_, i) => `line ${i + 1}`), 'old', ...Array.from({ length: 10 }, (_, i) => `tail ${i + 1}`)],
  afterLines: [...Array.from({ length: 10 }, (_, i) => `line ${i + 1}`), 'new', 'newer', ...Array.from({ length: 10 }, (_, i) => `tail ${i + 1}`)],
};

test('the diff rows keep three lines of context and fold the rest into gaps', async () => {
  const { buildDiffRows } = await importRenderer('file-views', 'diff-model.js');
  const rows = buildDiffRows(TEXT_RESULT);
  const kinds = rows.map((row) => (row.kind === 'gap' ? `gap${row.lines.length}` : row.type));
  assert.deepEqual(kinds, [
    'gap7', 'equal', 'equal', 'equal', 'delete', 'insert', 'insert', 'equal', 'equal', 'equal', 'gap7',
  ]);
  const removed = rows.find((row) => row.type === 'delete');
  assert.deepEqual(removed, { kind: 'line', type: 'delete', oldNo: 11, newNo: null, text: 'old' });
  const added = rows.filter((row) => row.type === 'insert');
  assert.deepEqual(added.map((row) => [row.newNo, row.text]), [[11, 'new'], [12, 'newer']]);
  const lastContext = rows[rows.length - 2];
  assert.deepEqual([lastContext.oldNo, lastContext.newNo], [14, 15]);

  // A gap of one line is not worth a button.
  const short = buildDiffRows({
    segments: [{ op: 'equal', count: 4 }, { op: 'insert', count: 1 }],
    beforeLines: ['a', 'b', 'c', 'd'],
    afterLines: ['a', 'b', 'c', 'd', 'e'],
  });
  assert.equal(short.filter((row) => row.kind === 'gap').length, 0);
});

async function mountHost(t, { results = {}, changesFor = () => [], files = {} } = {}) {
  const dom = setupRendererDom();
  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const requests = [];
  const api = {
    readFile: async (path) => files[path] ?? { error: 'ENOENT' },
    getFileChanges: async (ids) => {
      requests.push(ids);
      const key = ids.join(',');
      const result = results[key];
      if (typeof result === 'function') return result();
      return result ?? { ok: false, reason: 'unknown' };
    },
  };
  const host = createFileViewHost({ api, changesFor });
  t.after(() => {
    host.dispose();
    dom.cleanup();
  });
  const el = (id) => document.getElementById(id);
  return { host, el, requests };
}

const textRows = (el) => [...el('preview-body').querySelectorAll('.diff-row')].map((row) => [
  row.querySelector('.diff-num--old').textContent,
  row.querySelector('.diff-num--new').textContent,
  row.querySelector('.diff-mark span[aria-hidden]').textContent,
  row.querySelector('.diff-text').textContent,
]);

test('the changes view shows the lines as text, signs and spoken kinds included', async (t) => {
  const { host, el } = await mountHost(t, { results: { 'ab-1': TEXT_RESULT } });
  assert.equal(await host.open(item('a.js'), { changes: { ids: ['ab-1'] } }), true);
  await flush();

  assert.equal(el('preview-filename').textContent, 'a.js');
  assert.equal(el('preview-meta').textContent, '+2 −1');
  const rows = textRows(el);
  assert.deepEqual(rows.slice(3, 6), [['11', '', '−', 'old'], ['', '11', '+', 'new'], ['', '12', '+', 'newer']]);
  const spoken = el('preview-body').querySelector('.diff-row--insert .diff-mark .sr-only').textContent;
  assert.equal(spoken, 'added');
  assert.equal(el('preview-body').querySelector('table').getAttribute('aria-label'), 'Changes to a.js');

  // Opening a gap shows its lines in place of the button.
  const gap = el('preview-body').querySelector('.diff-gap button');
  assert.equal(gap.textContent, 'Show 7 unchanged lines');
  gap.click();
  assert.equal(textRows(el)[0][3], 'line 1');
  assert.equal(el('preview-body').querySelectorAll('.diff-gap').length, 1);
});

test('a line with markup in it stays text', async (t) => {
  const result = {
    ...TEXT_RESULT,
    segments: [{ op: 'insert', count: 1 }],
    beforeLines: [],
    afterLines: ['<img src=x onerror="alert(1)">'],
    created: true,
    added: 1,
    removed: 0,
  };
  const { host, el } = await mountHost(t, { results: { 'ab-1': result } });
  await host.open(item('x.html'), { changes: { ids: ['ab-1'] } });
  await flush();
  assert.equal(el('preview-body').querySelector('img'), null);
  assert.equal(el('preview-body').querySelector('.diff-text').textContent, '<img src=x onerror="alert(1)">');
  assert.equal(el('preview-meta').textContent, 'New file · +1');
});

test('the states without lines say what happened instead of showing an empty table', async (t) => {
  const cases = [
    [{ ok: false, reason: 'restarted' }, 'Changes no longer available', /restarted/],
    [{ ok: false, reason: 'evicted' }, 'Changes no longer available', /save memory/],
    [{ ok: true, status: 'binary', beforeBytes: 2048, afterBytes: 4096 }, 'Not a text file', /2\.0 KB.*4\.0 KB/],
    [{ ok: true, status: 'too-large', reason: 'bytes', beforeBytes: 3 * 1024 * 1024, afterBytes: 10, limitBytes: 2 * 1024 * 1024 }, 'Too large to compare', /3\.0 MB.*2\.0 MB/],
    [{ ok: true, status: 'eol-only', lineCount: 52, eolChange: { from: 'crlf', to: 'lf' } }, 'Only line endings changed', /All 52 lines went from CRLF \(Windows\) to LF/],
    [{ ok: true, status: 'eol-only', finalNewline: 'added' }, 'Only line endings changed', /line break was added/],
    [{ ok: true, status: 'unchanged' }, 'No changes', /same as before/],
    [{ ok: true, status: 'text', created: true, added: 0, removed: 0, segments: [], beforeLines: [], afterLines: [] }, 'New, empty file', /without any content/],
  ];
  const results = Object.fromEntries(cases.map(([result], i) => [`ab-${i + 1}`, result]));
  const { host, el } = await mountHost(t, { results });
  for (let i = 0; i < cases.length; i += 1) {
    const [, title, detail] = cases[i];
    await host.open(item(`f${i}.txt`), { changes: { ids: [`ab-${i + 1}`] } });
    await flush();
    assert.equal(el('preview-body').querySelector('.changes-state-title')?.textContent, title, `case ${i}`);
    assert.match(el('preview-body').querySelector('.changes-state-detail').textContent, detail);
    assert.equal(el('preview-body').querySelector('table'), null);
  }
});

test('a file changed since, or rewritten as a whole, gets a note above the diff', async (t) => {
  const { host, el } = await mountHost(t, {
    results: { 'ab-1': { ...TEXT_RESULT, changedSince: 'changed', rewritten: true } },
  });
  await host.open(item('a.js'), { changes: { ids: ['ab-1'] } });
  await flush();
  const notes = [...el('preview-body').querySelectorAll('.changes-banner')].map((note) => note.textContent);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /has changed since/);
  assert.match(notes[1], /Every line changed/);
  assert.equal(el('preview-body').querySelector('.changes-banner').getAttribute('role'), 'note');
});

test('several changes get a picker: all of them, or one', async (t) => {
  const one = { ...TEXT_RESULT, added: 5, removed: 0 };
  const { host, el, requests } = await mountHost(t, {
    results: { 'ab-1,ab-2': TEXT_RESULT, 'ab-2': one },
  });
  await host.open(item('a.js'), { changes: { ids: ['ab-1', 'ab-2'] } });
  await flush();
  const select = el('preview-tools').querySelector('select.changes-select');
  assert.ok(select, 'the picker is in the header');
  assert.equal(select.getAttribute('aria-label'), 'Which change');
  assert.deepEqual([...select.options].map((option) => option.textContent), [
    'All changes (2)', 'Change 1 of 2', 'Change 2 of 2',
  ]);
  select.value = 'ab-2';
  select.dispatchEvent(new window.Event('change'));
  await flush();
  assert.deepEqual(requests.at(-1), ['ab-2']);
  assert.equal(el('preview-meta').textContent, '+5 −0');
});

test('a file the agent changed gets "Content | Changes"; switching keeps the file', async (t) => {
  const { host, el, requests } = await mountHost(t, {
    files: { '/ws/a.js': { content: 'line 1\n', size: 7, modified: 2 } },
    results: { 'ab-1': TEXT_RESULT },
    changesFor: (path) => (path === '/ws/a.js' ? ['ab-1'] : []),
  });
  await host.open(item('a.js'));
  const radios = () => [...el('preview-tools').querySelectorAll('input[type="radio"]')];
  assert.deepEqual(radios().map((radio) => [radio.value, radio.checked]), [['content', true], ['changes', false]]);
  assert.equal(el('preview-tools').querySelector('.file-view-mode-switch').getAttribute('aria-label'), 'Show');

  radios()[1].checked = true;
  radios()[1].dispatchEvent(new window.Event('change'));
  await flush();
  await flush();
  assert.equal(host.showsChanges(), true);
  assert.deepEqual(requests.at(-1), ['ab-1']);
  assert.deepEqual(radios().map((radio) => radio.checked), [false, true]);
  assert.equal(document.activeElement, radios()[1], 'the focus stays on the switch');

  radios()[0].checked = true;
  radios()[0].dispatchEvent(new window.Event('change'));
  await flush();
  await flush();
  assert.equal(host.showsChanges(), false);
  assert.equal(el('preview-body').querySelector('#preview-content').textContent, 'line 1\n');

  // A file without changes has no switch.
  await host.open(item('b.js'));
  assert.equal(radios().length, 0);
});

test('the host adds the switch when the file on show gets its first change', async (t) => {
  let ids = [];
  const { host, el } = await mountHost(t, {
    files: { '/ws/a.js': { content: 'x\n', size: 2, modified: 2 } },
    changesFor: () => ids,
  });
  await host.open(item('a.js'));
  assert.equal(el('preview-tools').querySelector('.file-view-mode-switch'), null);
  ids = ['ab-1'];
  host.syncChanges();
  assert.ok(el('preview-tools').querySelector('.file-view-mode-switch'));
});

// ── the line under the tool log ────────────────────────────────────────────

test('the changed files of a message become a line of buttons under its tool log', async () => {
  const dom = setupRendererDom();
  try {
    const view = await importRenderer('chat', 'toolLogView.js');
    const changes = await importRenderer('chat', 'fileChanges.js');
    const trace = [
      { line: 'Edited a.js', tool: 'edit_file', changes: [{ id: 'ab-1', relativePath: 'src/a.js', status: 'text', added: 3, removed: 2 }] },
      { line: 'Read b.js', tool: 'read_file_text' },
      { line: 'Edited a.js', tool: 'edit_file', changes: [{ id: 'ab-2', relativePath: 'src/a.js', status: 'text', added: 1, removed: 0 }] },
      { line: 'Wrote c.md', tool: 'write_file_text', changes: [{ id: 'cd-9', relativePath: 'c.md', status: 'text', created: true, added: 4, removed: 0 }] },
    ];
    changes.markChangesLive([{ id: 'ab-1' }, { id: 'ab-2' }]);
    const files = changes.changedFilesOf(trace);
    assert.deepEqual(files.map((file) => [file.relativePath, file.added, file.removed, file.changes.length]), [
      ['src/a.js', 4, 2, 2],
      ['c.md', 4, 0, 1],
    ]);

    const message = document.createElement('div');
    message.append(view.buildToolLog(trace, 'done'));
    const opened = [];
    view.syncChangesStrip(message, files, { isLive: changes.changesAreLive, onOpen: (file) => opened.push(file) });
    const strip = message.querySelector('.chat-tool-log + .chat-changes');
    assert.ok(strip, 'the line follows the tool log, outside it');
    assert.equal(strip.getAttribute('role'), 'group');

    const [live, gone] = strip.querySelectorAll('.chat-change-file');
    assert.equal(live.tagName, 'BUTTON');
    assert.equal(live.getAttribute('aria-label'), 'Show changes to src/a.js: 4 lines added, 2 lines removed');
    assert.equal(live.querySelector('.chat-change-name').textContent, 'a.js');
    live.click();
    assert.deepEqual(opened.map((file) => file.changes.map((change) => change.id)), [['ab-1', 'ab-2']]);

    // From before a restart: a record, not a button, and a note saying why.
    assert.equal(gone.tagName, 'SPAN');
    assert.match(strip.querySelector('.chat-changes-note').textContent, /no longer available/);

    // The rows carry the counts of their own call.
    const stats = [...message.querySelectorAll('.chat-tool-lines .chat-change-stat span[aria-hidden]')].map((s) => s.textContent);
    assert.deepEqual(stats, ['+3 −2', '+1 −0', '+4 −0']);

    // Synced again, the line is replaced, not doubled.
    view.syncChangesStrip(message, files, { isLive: changes.changesAreLive, onOpen: () => {} });
    assert.equal(message.querySelectorAll('.chat-changes').length, 1);
    view.syncChangesStrip(message, [], { isLive: changes.changesAreLive, onOpen: () => {} });
    assert.equal(message.querySelectorAll('.chat-changes').length, 0);
  } finally {
    dom.cleanup();
  }
});
