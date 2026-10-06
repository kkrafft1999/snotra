// The generate_image tool (#85): the image service is a stub, the workspace a
// real temporary folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { createFileChangeRecorder } = require('../src/main/services/file-change-recorder');
const { summarizeToolCall } = require('../src/shared/presentation/tool-display');
const { buildPreview } = require('../src/main/tools/tool-call-planner');
const { IMAGE_GENERATION_ERROR_CODES: CODES } = require('../src/application/ports/image-generation-port');

// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeImageService({ configured = true, generate } = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: () => configured,
    getModel: () => 'gpt-image-2.5-flare',
    async generate(request) {
      calls.push(request);
      if (generate) return generate(request);
      return { ok: true, bytes: PNG, mime: 'image/png', model: 'gpt-image-2.5-flare' };
    },
  };
}

async function makeWorkspace(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-image-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function makeRegistry(imageGeneration) {
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
  const registry = createWorkspaceToolRegistry({ fsService, imageGeneration });
  return {
    registry,
    run: (args, context = {}) => registry.execute('generate_image', args, { approved: true, ...context }),
  };
}

test('generate_image is offered only with an image service that has a key', () => {
  const without = createWorkspaceToolRegistry({ fsService: {} });
  assert.equal(without.getTools().some((tool) => tool.function.name === 'generate_image'), false);
  const unconfigured = createWorkspaceToolRegistry({ fsService: {}, imageGeneration: makeImageService({ configured: false }) });
  assert.equal(unconfigured.getTools().some((tool) => tool.function.name === 'generate_image'), false);
  const ready = createWorkspaceToolRegistry({ fsService: {}, imageGeneration: makeImageService() });
  const tool = ready.getTools().find((entry) => entry.function.name === 'generate_image');
  assert.ok(tool);
  assert.deepEqual(tool.function.parameters.required, ['prompt', 'relative_path']);
  assert.deepEqual(tool.function.parameters.properties.size.enum, ['1024x1024', '1536x1024', '1024x1536']);
});

test('a call without a configured service points to Settings › Tool setup', async () => {
  const registry = createWorkspaceToolRegistry({ fsService: {}, imageGeneration: makeImageService({ configured: false }) });
  const output = await registry.execute('generate_image', { prompt: 'x', relative_path: 'a.png' }, { approved: true, locale: 'en' });
  assert.match(JSON.parse(output).error, /Settings › Tool setup/);
});

test('the image lands in the workspace; the model gets path and size, never the bytes', async (t) => {
  const root = await makeWorkspace(t);
  const service = makeImageService();
  const { run } = makeRegistry(service);

  const output = await run({ prompt: 'a red fox', relative_path: 'docs/img/fox.png', quality: 'low' }, { workspaceRoot: root });
  const result = JSON.parse(output);

  assert.deepEqual(await fs.readFile(path.join(root, 'docs/img/fox.png')), PNG);
  assert.equal(result.relative_path, 'docs/img/fox.png');
  assert.equal(result.created, true);
  assert.equal(result.format, 'png');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.bytes_written, PNG.length);
  assert.equal(result.model, 'gpt-image-2.5-flare');
  assert.doesNotMatch(output, new RegExp(PNG.toString('base64').slice(0, 24)));
  assert.deepEqual(service.calls[0], {
    prompt: 'a red fox',
    size: '1024x1024',
    quality: 'low',
    format: 'png',
    background: 'auto',
    abortSignal: undefined,
  });
});

test('the extension decides the format, and an unknown one draws nothing', async (t) => {
  const root = await makeWorkspace(t);
  const service = makeImageService({
    generate: (request) => ({ ok: true, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mime: 'image/jpeg', model: 'm', request }),
  });
  const { run } = makeRegistry(service);
  const jpeg = JSON.parse(await run({ prompt: 'x', relative_path: 'photo.JPG' }, { workspaceRoot: root }));
  assert.equal(jpeg.format, 'jpeg');
  assert.equal(service.calls[0].format, 'jpeg');

  const refused = JSON.parse(await run({ prompt: 'x', relative_path: 'drawing.svg' }, { workspaceRoot: root }));
  assert.match(refused.error, /\.png, \.jpg, \.jpeg, \.webp/);
  assert.equal(service.calls.length, 1);
});

test('a target outside the workspace is refused before anything is drawn', async (t) => {
  const root = await makeWorkspace(t);
  const service = makeImageService();
  const { run } = makeRegistry(service);
  const result = JSON.parse(await run({ prompt: 'x', relative_path: '../escape.png' }, { workspaceRoot: root }));
  assert.ok(result.error);
  await assert.rejects(fs.access(path.join(path.dirname(root), 'escape.png')));
});

test('a service error reaches the model as an error, and nothing is written', async (t) => {
  const root = await makeWorkspace(t);
  const service = makeImageService({
    generate: () => ({ ok: false, code: CODES.REFUSED, error: 'OpenAI refused to draw this prompt.' }),
  });
  const { run } = makeRegistry(service);
  const result = JSON.parse(await run({ prompt: 'x', relative_path: 'a.png' }, { workspaceRoot: root }));
  assert.deepEqual(result, { error: 'OpenAI refused to draw this prompt.', code: CODES.REFUSED });
  await assert.rejects(fs.access(path.join(root, 'a.png')));
});

test('one turn makes at most four images; a request that never left counts for nothing', async (t) => {
  const root = await makeWorkspace(t);
  let invalid = true;
  const service = makeImageService({
    generate: () => (invalid
      ? { ok: false, code: CODES.INVALID_REQUEST, error: 'bad' }
      : { ok: true, bytes: PNG, mime: 'image/png', model: 'm' }),
  });
  const { run } = makeRegistry(service);
  const turn = new AbortController().signal;
  await run({ prompt: 'x', relative_path: 'bad.png' }, { workspaceRoot: root, abortSignal: turn });
  invalid = false;
  const left = [];
  for (let i = 1; i <= 4; i += 1) {
    const result = JSON.parse(await run({ prompt: `x${i}`, relative_path: `img${i}.png` }, { workspaceRoot: root, abortSignal: turn }));
    left.push(result.images_left_this_turn);
  }
  assert.deepEqual(left, [3, 2, 1, 0]);
  const fifth = JSON.parse(await run({ prompt: 'x5', relative_path: 'img5.png' }, { workspaceRoot: root, abortSignal: turn }));
  assert.equal(fifth.code, 'image_limit_reached');
  assert.equal(service.calls.length, 5);

  // The next turn has its own budget.
  const next = JSON.parse(await run({ prompt: 'x6', relative_path: 'img6.png' }, { workspaceRoot: root, abortSignal: new AbortController().signal }));
  assert.equal(next.images_left_this_turn, 3);
});

test('overwriting keeps a recovery copy; a failed copy keeps the drawn image for the second approval', async (t) => {
  const root = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'logo.png'), 'old');
  const service = makeImageService();
  const { run } = makeRegistry(service);
  const trashed = [];

  const replaced = JSON.parse(await run(
    { prompt: 'logo', relative_path: 'logo.png' },
    { workspaceRoot: root, recovery: { trashItem: async (p) => { trashed.push(p); await fs.rm(p); } } },
  ));
  assert.equal(replaced.overwritten, true);
  assert.match(replaced.recovery_copy_in_trash, /^logo\.png\.snotra-backup-/);
  assert.equal(trashed.length, 1);

  await fs.writeFile(path.join(root, 'logo.png'), 'old again');
  const failed = JSON.parse(await run(
    { prompt: 'logo v2', relative_path: 'logo.png' },
    { workspaceRoot: root, recovery: { trashItem: async () => { throw new Error('no trash'); } } },
  ));
  assert.equal(failed.code, 'recovery_failed');
  assert.equal(await fs.readFile(path.join(root, 'logo.png'), 'utf8'), 'old again');
  assert.equal(service.calls.length, 2);

  // Approved again as `delete`: the same image is written, nothing new is drawn.
  const second = JSON.parse(await run(
    { prompt: 'logo v2', relative_path: 'logo.png' },
    { workspaceRoot: root, recovery: { trashItem: null, allowUnrecoverable: true } },
  ));
  assert.equal(second.overwritten, true);
  assert.equal(service.calls.length, 2);
  assert.deepEqual(await fs.readFile(path.join(root, 'logo.png')), PNG);
});

test('through the adapter the image is recorded as a binary change and marked in the tree', async (t) => {
  const root = await makeWorkspace(t);
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
  const toolRegistry = createWorkspaceToolRegistry({ fsService, imageGeneration: makeImageService() });
  const recorder = createFileChangeRecorder({ fs, bootId: 'ab12' });
  const adapter = createWorkspaceToolAdapter(toolRegistry, { fileChangeRecorder: recorder, trashItem: (p) => fs.rm(p, { force: true }) });
  const result = await adapter.execute(
    'generate_image',
    { prompt: 'x', relative_path: 'art/a.png' },
    { workspaceRoot: root, approved: true, riskClasses: ['write', 'external'] },
  );
  assert.equal(result.fileChanges.length, 1);
  assert.equal(result.fileChanges[0].relativePath, 'art/a.png');
  assert.equal(result.fileChanges[0].status, 'binary');
  // The written event clears the image cache and marks the tree.
  assert.equal(result.progressEvents.length, 1);
  assert.equal(result.progressEvents[0].relativePath, 'art/a.png');
  assert.equal(result.progressEvents[0].change.id, result.fileChanges[0].id);
});

test('the tool line names the image', () => {
  assert.equal(summarizeToolCall('generate_image', { relative_path: 'docs/hero.png' }, 'start', 'en'), 'Generating image docs/hero.png …');
  assert.equal(summarizeToolCall('generate_image', { relative_path: 'docs/hero.png' }, 'done', 'de'), 'Bild docs/hero.png erzeugt');
  assert.equal(summarizeToolCall('generate_image', {}, 'done', 'en'), 'Image generated');
});

test('the target is one file that may be replaced', () => {
  const registry = createWorkspaceToolRegistry({ fsService: {}, imageGeneration: makeImageService() });
  assert.deepEqual(registry.getDefinition('generate_image').targets({ relative_path: 'a.png' }), [
    { path: 'a.png', kind: 'file', access: 'write', overwrite: true },
  ]);
  assert.equal(buildPreview('generate_image', { prompt: 'a red fox', relative_path: 'a.png' }, { locale: 'en' }).text, 'a red fox');
});
