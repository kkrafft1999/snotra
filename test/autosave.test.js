const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { importRenderer } = require('./helpers/dom.js');

// #863: the autosave of the preview's text editor, without a single node.

const sha256 = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

async function setup({ base = 'base', results = [] } = {}) {
  const { createAutosave, SAVE_STATES } = await importRenderer('file-views', 'autosave.js');
  let text = base;
  let timer = null;
  const writes = [];
  const states = [];
  const autosave = createAutosave({
    base,
    getText: () => text,
    write: async (next, options) => {
      writes.push({ text: next, ...options });
      const result = results.length ? results.shift() : { ok: true, size: next.length, modified: 1 };
      return typeof result === 'function' ? result() : result;
    },
    onState: (state) => states.push(state.status),
    setTimer: (fn) => {
      timer = fn;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
  });
  return {
    autosave,
    SAVE_STATES,
    writes,
    states,
    type: (next) => {
      text = next;
      autosave.changed();
    },
    setText: (next) => {
      text = next;
    },
    fireTimer: async () => {
      const fn = timer;
      timer = null;
      fn?.();
      // The hash runs on the thread pool: wait until the save has come
      // back, by the clock rather than by ticks — a slow runner needs more.
      const until = Date.now() + 5000;
      while (autosave.state.status === SAVE_STATES.SAVING && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },
    hasTimer: () => timer !== null,
  };
}

test('sha256Hex hashes the UTF-8 bytes the way main does', async () => {
  const { sha256Hex } = await importRenderer('file-views', 'autosave.js');
  for (const text of ['', 'abc', 'Grüße\r\n', '﻿bom', '😀']) {
    assert.equal(await sha256Hex(text), sha256(text));
  }
});

test('typing saves once the typing pauses, with the hash of what was on disk', async () => {
  const { autosave, SAVE_STATES, writes, type, fireTimer } = await setup({ base: 'old' });

  type('ne');
  type('new');
  assert.equal(autosave.state.status, SAVE_STATES.PENDING);
  assert.equal(writes.length, 0);
  await fireTimer();

  assert.deepEqual(writes, [{ text: 'new', baseHash: sha256('old'), force: false }]);
  assert.equal(autosave.state.status, SAVE_STATES.SAVED);
  assert.equal(autosave.isDirty(), false);

  // The next save compares against what this one wrote.
  type('newer');
  await fireTimer();
  assert.equal(writes[1].baseHash, sha256('new'));
});

test('a flush with nothing changed writes nothing', async () => {
  const { autosave, writes } = await setup();

  assert.equal(await autosave.flush(), true);
  assert.equal(writes.length, 0);
});

test('typing on while a save runs is saved next', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { autosave, SAVE_STATES, writes, type, setText, hasTimer } = await setup({
    base: 'a',
    results: [async () => { await gate; return { ok: true }; }],
  });

  type('ab');
  const saving = autosave.flush();
  setText('abc');
  autosave.changed();
  release();
  assert.equal(await saving, true);

  assert.equal(writes.length, 1);
  assert.equal(autosave.state.status, SAVE_STATES.PENDING);
  assert.equal(hasTimer(), true);
  assert.equal(await autosave.flush(), true);
  assert.equal(writes[1].text, 'abc');
  assert.equal(writes[1].baseHash, sha256('ab'));
});

test('a conflict from main stops the autosave until the user chooses', async () => {
  const { autosave, SAVE_STATES, writes, type, fireTimer, hasTimer } = await setup({
    base: 'disk',
    results: [{ conflict: 'changed' }],
  });

  type('mine');
  await fireTimer();
  assert.equal(autosave.state.status, SAVE_STATES.CONFLICT);
  assert.equal(autosave.state.conflict, 'changed');

  type('mine, more');
  assert.equal(hasTimer(), false, 'no save is scheduled over a conflict');
  assert.equal(await autosave.flush(), false);
  assert.equal(writes.length, 1);

  assert.equal(await autosave.keepMine(), true);
  assert.deepEqual(writes[1], { text: 'mine, more', baseHash: sha256('disk'), force: true });
  assert.equal(autosave.state.status, SAVE_STATES.SAVED);
});

test('a failed save says why, and typing tries again', async () => {
  const { autosave, SAVE_STATES, writes, type, fireTimer } = await setup({
    results: [{ error: 'EACCES', reason: 'permission' }],
  });

  type('x');
  await fireTimer();
  assert.equal(autosave.state.status, SAVE_STATES.FAILED);
  assert.equal(autosave.state.reason, 'permission');
  assert.equal(autosave.isDirty(), true);

  type('xy');
  await fireTimer();
  assert.equal(writes.length, 2);
  assert.equal(autosave.state.status, SAVE_STATES.SAVED);
});

test('a write that throws is a failed save, not a lost one', async () => {
  const { autosave, SAVE_STATES, type } = await setup({ results: [() => { throw new Error('IPC gone'); }] });

  type('x');
  assert.equal(await autosave.flush(), false);
  assert.equal(autosave.state.status, SAVE_STATES.FAILED);
  assert.equal(autosave.state.reason, 'failed');
  assert.equal(autosave.isDirty(), true);
});

test('a change on disk is taken when nothing of the user is lost, else a conflict', async () => {
  const { autosave, SAVE_STATES } = await setup({ base: 'one' });

  assert.equal(autosave.external('one'), 'ignore');
  assert.equal(autosave.external('two'), 'replace');
  assert.equal(autosave.isDirty(), true, 'the caller still has to put the text into the editor');

  const second = await setup({ base: 'one' });
  second.type('one, edited');
  assert.equal(second.autosave.external('two'), 'conflict');
  assert.equal(second.autosave.state.status, SAVE_STATES.CONFLICT);
  assert.equal(second.autosave.state.conflict, 'changed');
});

test('the watcher reporting the editor’s own text is no conflict', async () => {
  const { autosave, SAVE_STATES, type } = await setup({ base: 'one' });

  type('two');
  assert.equal(autosave.external('two'), 'ignore');
  assert.equal(autosave.state.status, SAVE_STATES.SAVED);
  assert.equal(autosave.isDirty(), false);
});

test('adopting the version on disk ends the conflict', async () => {
  const { autosave, SAVE_STATES, writes, type, setText, fireTimer } = await setup({ base: 'one' });

  type('mine');
  autosave.external('theirs');
  setText('theirs');
  autosave.adopt('theirs');
  assert.equal(autosave.state.status, SAVE_STATES.IDLE);
  assert.equal(autosave.isDirty(), false);

  type('theirs, edited');
  await fireTimer();
  assert.equal(writes[0].baseHash, sha256('theirs'));
});

test('nothing is written after dispose', async () => {
  const { autosave, writes, type, fireTimer } = await setup();

  type('x');
  autosave.dispose();
  await fireTimer();
  assert.equal(writes.length, 0);
  assert.equal(await autosave.flush(), false);
});
