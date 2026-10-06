// Generated images under the line of changed files (#85), on a real DOM.
// How the card looks is left to the look script
// (e2e/manual-generate-image.mjs); here the structure counts.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function withDom(fn) {
  const dom = setupRendererDom();
  try {
    const view = await importRenderer('chat', 'generatedImages.js');
    const images = await importRenderer('chat', 'workspaceImages.js');
    images.clearWorkspaceImageCache();
    await fn(view, dom);
  } finally {
    dom.cleanup();
  }
}

function trace(...entries) {
  return entries.map(([tool, relativePath, id]) => ({
    line: `${tool} ${relativePath}`,
    tool,
    changes: [{ id, relativePath, status: 'binary', created: true, added: 0, removed: 0 }],
  }));
}

function message() {
  const li = document.createElement('li');
  const log = document.createElement('details');
  log.className = 'chat-tool-log';
  const changes = document.createElement('div');
  changes.className = 'chat-changes';
  const answer = document.createElement('div');
  answer.className = 'chat-md';
  li.append(log, changes, answer);
  document.body.append(li);
  return li;
}

function makeApi(missing = new Set()) {
  const reads = [];
  return {
    reads,
    async readWorkspaceImage(src) {
      reads.push(src);
      if (missing.has(src)) return { ok: false, reason: 'not-found' };
      return { ok: true, mime: 'image/png', base64: PNG_B64 };
    },
  };
}

test('only images the image tool made are shown, once per path, in order', async () => {
  await withDom(({ generatedImagesOf }) => {
    const images = generatedImagesOf([
      ...trace(['generate_image', 'a.png', 'ab12-1'], ['write_file_text', 'notes.md', 'ab12-2']),
      ...trace(['generate_image', 'b.webp', 'ab12-3'], ['generate_image', 'a.png', 'ab12-4']),
      { line: 'old string entry' },
    ]);
    assert.deepEqual(images, [
      { relativePath: 'a.png', changeIds: ['ab12-1', 'ab12-4'] },
      { relativePath: 'b.webp', changeIds: ['ab12-3'] },
    ]);
  });
});

test('the card stands under the line of changed files and opens the file on click', async () => {
  await withDom(async ({ generatedImagesOf, syncGeneratedImages }) => {
    const li = message();
    const api = makeApi();
    const opened = [];
    await syncGeneratedImages(li, generatedImagesOf(trace(['generate_image', 'assets/header.png', 'ab12-1'])), {
      api,
      workspaceRoot: '/ws',
      onOpen: (path) => opened.push(path),
    });
    const box = li.querySelector('.chat-images');
    assert.equal(li.querySelector('.chat-changes').nextElementSibling, box);
    assert.equal(box.getAttribute('role'), 'group');
    assert.equal(box.getAttribute('aria-label'), 'Generated images');
    assert.equal(box.classList.contains('chat-images--grid'), false);

    const button = box.querySelector('button.chat-image-open');
    assert.equal(button.getAttribute('aria-label'), 'Open assets/header.png in the preview');
    assert.equal(button.classList.contains('chat-image-open--loading'), false);
    const img = button.querySelector('img');
    assert.ok(img.classList.contains('chat-md-image-img'));
    assert.match(img.getAttribute('src'), /^data:image\/png;base64,/);
    assert.equal(img.alt, 'header.png');
    assert.equal(box.querySelector('.chat-image-path').textContent, 'assets/header.png');
    assert.equal(box.querySelector('.chat-image-meta').textContent, '1 × 1 · PNG');
    assert.deepEqual(api.reads, ['assets/header.png']);

    button.click();
    assert.deepEqual(opened, ['assets/header.png']);
  });
});

test('a redraw with the same images keeps them; a new write of the same path draws again', async () => {
  await withDom(async ({ generatedImagesOf, syncGeneratedImages }) => {
    const li = message();
    const api = makeApi();
    const first = trace(['generate_image', 'a.png', 'ab12-1']);
    await syncGeneratedImages(li, generatedImagesOf(first), { api, workspaceRoot: '/ws' });
    const box = li.querySelector('.chat-images');

    // The line of changed files is redrawn: the images move along, unloaded.
    const strip = document.createElement('div');
    strip.className = 'chat-changes';
    li.querySelector('.chat-changes').replaceWith(strip);
    await syncGeneratedImages(li, generatedImagesOf(first), { api, workspaceRoot: '/ws' });
    assert.equal(li.querySelector('.chat-images'), box);
    assert.equal(strip.nextElementSibling, box);

    await syncGeneratedImages(li, generatedImagesOf([...first, ...trace(['generate_image', 'a.png', 'ab12-2'])]), {
      api,
      workspaceRoot: '/ws',
    });
    assert.notEqual(li.querySelector('.chat-images'), box);
    assert.equal(li.querySelectorAll('.chat-images').length, 1);
  });
});

test('several images make a grid; a missing file is a placeholder, not a button', async () => {
  await withDom(async ({ generatedImagesOf, syncGeneratedImages }) => {
    const li = message();
    const api = makeApi(new Set(['gone.png']));
    await syncGeneratedImages(li, generatedImagesOf(trace(
      ['generate_image', 'here.png', 'ab12-1'],
      ['generate_image', 'gone.png', 'ab12-2'],
    )), { api, workspaceRoot: '/ws' });
    const box = li.querySelector('.chat-images');
    assert.ok(box.classList.contains('chat-images--grid'));
    const [here, gone] = box.querySelectorAll('.chat-image');
    assert.ok(here.querySelector('button.chat-image-open img.chat-md-image-img'));
    assert.equal(gone.querySelector('button'), null);
    const placeholder = gone.querySelector('.chat-image-missing .chat-md-image--placeholder');
    assert.ok(placeholder, 'the placeholder says why');
    assert.match(placeholder.getAttribute('aria-label'), /^gone\.png: /);
  });
});

test('no image, or no tool log, means no card', async () => {
  await withDom(async ({ generatedImagesOf, syncGeneratedImages }) => {
    const li = message();
    const api = makeApi();
    await syncGeneratedImages(li, generatedImagesOf(trace(['generate_image', 'a.png', 'ab12-1'])), { api, workspaceRoot: '/ws' });
    assert.ok(li.querySelector('.chat-images'));
    await syncGeneratedImages(li, [], { api, workspaceRoot: '/ws' });
    assert.equal(li.querySelector('.chat-images'), null);

    const bare = document.createElement('li');
    await syncGeneratedImages(bare, generatedImagesOf(trace(['generate_image', 'a.png', 'ab12-1'])), { api, workspaceRoot: '/ws' });
    assert.equal(bare.querySelector('.chat-images'), null);
  });
});
