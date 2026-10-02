const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createFilesystemIpcAdapter } = require('../src/main/adapters/filesystem-ipc-adapter');
const { createFsService } = require('../src/main/services/fs-service');

// #650 item 6: the port documents what the adapter provides — not 3 of 9.

const PORT_FILE = path.join(__dirname, '..', 'src', 'main', 'ports', 'filesystem-port.js');

function typedefProperties(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\*\s*@property\s+\{.*\}\s+([A-Za-z_$][\w$]*)\s*$/))
    .filter(Boolean)
    .map((match) => match[1]);
}

test('the FilesystemPort typedef lists exactly the members of the adapter (#650)', () => {
  const documented = typedefProperties(fs.readFileSync(PORT_FILE, 'utf8'));
  const adapter = createFilesystemIpcAdapter({ fsService: {}, getActiveWorkspaceRoot: () => null });

  assert.deepEqual([...documented].sort(), Object.keys(adapter).sort());
  assert.equal(new Set(documented).size, documented.length, 'no member is documented twice');
});

test('the adapter\'s checked path and fs-service\'s lexical one no longer share a name (#650)', () => {
  const adapter = createFilesystemIpcAdapter({ fsService: {}, getActiveWorkspaceRoot: () => null });
  const service = createFsService({ fs: require('fs/promises'), path, maxReadFileBytes: 1024 });

  assert.equal(typeof adapter.resolveCheckedWorkspacePath, 'function');
  assert.equal(adapter.resolveWorkspacePath, undefined);
  assert.equal(typeof service.resolveWorkspacePath, 'function');
  assert.equal(service.resolveCheckedWorkspacePath, undefined);
});
