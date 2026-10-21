'use strict';

// The catalogue is complete (#1194, docs/remote-interface.md §10): every IPC
// channel the window uses is classified in §8.3 — mapped onto the remote
// protocol, waiting for a prerequisite, or staying on the desktop with a
// reason. A new channel is a decision about the remote surface, not
// something that slips past it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { REQUEST_CHANNELS, PUSH_CHANNELS } = require('../src/shared/ipc-channels');

const DOC = path.join(__dirname, '..', 'docs', 'remote-interface.md');

/**
 * The channel names §8.3 classifies. A row lists names in backticks; a name
 * without a prefix takes the one before it (`toolPermissions:setMode`,
 * `addRule`), and `prefix:*` stands for every channel of that prefix.
 */
function classified() {
  const text = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
  const section = text.slice(text.indexOf('### 8.3'), text.indexOf('## 9.'));
  const names = new Set();
  const prefixes = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| IPC channels') || line.startsWith('| ---')) continue;
    const cell = line.split('|')[1];
    let prefix = null;
    for (const [, token] of cell.matchAll(/`([^`]+)`/g)) {
      const at = token.indexOf(':');
      if (at < 0) {
        if (prefix) names.add(`${prefix}:${token}`);
        continue;
      }
      prefix = token.slice(0, at);
      if (token.endsWith(':*')) prefixes.add(prefix);
      else names.add(token);
    }
    // "all `manual:*` channels", "all eleven `ui:*` pushes": the wildcard above covers them.
  }
  return { names, prefixes };
}

test('every IPC channel is classified in remote-interface.md §8.3', () => {
  const { names, prefixes } = classified();
  const all = [...new Set([...Object.values(REQUEST_CHANNELS), ...Object.values(PUSH_CHANNELS)])];
  const missing = all.filter((channel) => !names.has(channel) && !prefixes.has(channel.slice(0, channel.indexOf(':'))));
  assert.deepEqual(missing.sort(), [], 'classify these in §8.3: mapped, after a prerequisite, or desktop with a reason');
});

test('§8.3 names no channel that does not exist', () => {
  const { names } = classified();
  const all = new Set([...Object.values(REQUEST_CHANNELS), ...Object.values(PUSH_CHANNELS)]);
  assert.deepEqual([...names].filter((name) => !all.has(name)).sort(), []);
});
