'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWatcherWarning, WATCHER_WARNING_INTERVAL_MS } = require('../src/main/services/watcher-warning');

function setup() {
  const lines = [];
  let clock = 1_000;
  const warn = createWatcherWarning('skills-watcher', {
    log: { warn: (line) => lines.push(line) },
    now: () => clock,
  });
  return { warn, lines, advance: (ms) => { clock += ms; } };
}

test('a failing watch is logged with the watcher, the folder and the reason (#648)', () => {
  const { warn, lines } = setup();
  warn(Object.assign(new Error('too many open files'), { code: 'EMFILE' }), '/w/a');
  assert.deepEqual(lines, ['[skills-watcher] cannot watch /w/a: EMFILE too many open files']);
});

test('within a minute further failures are held back and counted in the next line', () => {
  const { warn, lines, advance } = setup();
  warn({ code: 'ENOSPC' }, '/w/a');
  advance(1_000);
  warn({ code: 'ENOSPC' }, '/w/b');
  warn({ code: 'ENOSPC' }, '/w/c');
  assert.equal(lines.length, 1);

  advance(WATCHER_WARNING_INTERVAL_MS);
  warn({ code: 'ENOSPC' }, '/w/d');
  assert.deepEqual(lines.slice(1), ['[skills-watcher] cannot watch /w/d: ENOSPC (2 more since the last warning)']);

  advance(WATCHER_WARNING_INTERVAL_MS);
  warn(null, '/w/e');
  assert.equal(lines[2], '[skills-watcher] cannot watch /w/e: ', 'the count starts over, and no error is no reason');
});

test('each watcher has a budget of its own', () => {
  const lines = [];
  const log = { warn: (line) => lines.push(line) };
  const skills = createWatcherWarning('skills-watcher', { log, now: () => 0 });
  const tree = createWatcherWarning('workspace-watcher', { log, now: () => 0 });
  skills({ code: 'EMFILE' }, '/a');
  tree({ code: 'EMFILE' }, '/b');
  assert.equal(lines.length, 2);
});
