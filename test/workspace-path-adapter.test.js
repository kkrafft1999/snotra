const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createNodeWorkspacePathAdapter } = require('../src/main/adapters/workspace-path-adapter');

const workspacePaths = createNodeWorkspacePathAdapter({ path });

test('resolveSelection anchors relative paths under workspace root', () => {
  const root = '/tmp/snotra-project';
  const selection = workspacePaths.resolveSelection(root, 'src/app.js', false);
  assert.deepEqual(selection, {
    relativePath: path.join('src', 'app.js'),
    isDirectory: false,
  });
});

test('resolveSelection accepts absolute paths inside workspace', () => {
  const root = '/tmp/snotra-project';
  const selection = workspacePaths.resolveSelection(root, '/tmp/snotra-project/docs/readme.md', false);
  assert.deepEqual(selection, {
    relativePath: path.join('docs', 'readme.md'),
    isDirectory: false,
  });
});

test('resolveSelection rejects traversal outside workspace root', () => {
  const root = '/tmp/snotra-project';
  assert.equal(workspacePaths.resolveSelection(root, '../outside.txt', false), null);
  assert.equal(workspacePaths.resolveSelection(root, '/etc/passwd', false), null);
  assert.equal(workspacePaths.resolveSelection(root, '../../etc/passwd', false), null);
});

test('resolveSelection treats workspace root selection as dot', () => {
  const root = '/tmp/snotra-project';
  const selection = workspacePaths.resolveSelection(root, '/tmp/snotra-project', true);
  assert.deepEqual(selection, { relativePath: '.', isDirectory: true });
});
