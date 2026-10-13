// The renderer's errors reach main's log (#919).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRendererErrorForwarder } = require('../src/main/services/renderer-console');

test('only errors are forwarded, with a short source and the line', () => {
  const lines = [];
  const forward = createRendererErrorForwarder({ log: (line) => lines.push(line) });

  forward({ level: 'info', message: 'ready', sourceId: 'file:///x/src/renderer/app.js', lineNumber: 1 });
  forward({ level: 'warning', message: 'slow', sourceId: '', lineNumber: 0 });
  forward({
    level: 'error',
    message: 'Uncaught (in promise) TypeError: x is undefined',
    sourceId: 'file:///Users/k/snotra/src/renderer/components/ChatStream.js',
    lineNumber: 1412,
  });
  forward({ level: 'error', message: 'no source' });

  assert.deepEqual(lines, [
    '[renderer] Uncaught (in promise) TypeError: x is undefined (components/ChatStream.js:1412)',
    '[renderer] no source',
  ]);
});

test('a long message is cut', () => {
  const lines = [];
  const forward = createRendererErrorForwarder({ log: (line) => lines.push(line) });
  forward({ level: 'error', message: 'x'.repeat(5000) });
  assert.equal(lines[0].length, '[renderer] '.length + 2000);
  assert.ok(lines[0].endsWith('…'));
});
