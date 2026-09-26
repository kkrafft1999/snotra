// Look instead of trust: Markdown in the file preview (#344), every state in
// the real app, light and dark. Not a test — the smoke test checks what must
// hold; this one produces the pictures for the pull request and prints what
// cannot be seen in a picture (requests, header heights, focus).
//
//   node e2e/manual-markdown-view.mjs [label]
//
// Result: out/mockup/markdown-<label>-<state>-<theme>.png, label defaults to
// "current".

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const label = process.argv[2] || 'current';
const SHOTS = path.resolve('out/mockup');

/** A real PNG: a light frame with three boxes and two arrows, like a flow. */
function makeFlowPng(width = 640, height = 140) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  const boxes = [[40, 180], [240, 380], [440, 580]];
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      let rgb = [247, 243, 236];
      const inBand = y >= 45 && y <= 95;
      const box = boxes.find(([a, b]) => x >= a && x <= b);
      if (inBand && box) {
        const edge = y === 45 || y === 95 || x === box[0] || x === box[1];
        rgb = edge ? [0, 117, 158] : [255, 252, 245];
      } else if (y >= 69 && y <= 71 && !box && x > 180 && x < 440) {
        rgb = [0, 117, 158];
      }
      raw.set(rgb, row + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SKILL = [
  '---',
  'name: release',
  'description: >',
  '  Publishes a new release of Snotra AI: bumps the version through a pull',
  '  request, then tags it and lets the pipeline build the artifacts.',
  'license: MIT',
  'metadata:',
  '  owner: kkrafft1999',
  '  since: "1.4.0"',
  '---',
  '',
  '# Release',
  '',
  'Publishes a new release. The version bump goes through a pull request, the',
  'tag starts [the release pipeline](https://github.com/kkrafft1999/snotra/actions)',
  'on GitHub Actions. See [the steps](#steps) and [CONTRIBUTING](../../CONTRIBUTING.md).',
  '',
  '![Build status](https://img.shields.io/github/actions/workflow/status/kkrafft1999/snotra/ci.yml)',
  '',
  '## Steps',
  '',
  '1. Confirm the target version, e.g. `1.11.0`.',
  '2. Open the bump pull request and wait for the checks.',
  '3. Tag and push: `git push origin v1.11.0`',
  '',
  '![Release flow](../../docs/flow.png)',
  '',
  '| Platform | Artifact | Signed |',
  '|---|---|---|',
  '| macOS | `.dmg`, `.zip` | yes |',
  '| Windows | `.exe` (Squirrel) | no |',
  '| Linux | `.deb`, `.rpm` | no |',
  '',
  '> Never push to `main` directly — the version commit goes through a pull',
  '> request as well.',
  '',
  '```sh',
  'gh pr create --title "v1.11.0" --body "Release"',
  '```',
  '',
  '- [x] Changelog written',
  '- [ ] Tag pushed',
  '',
  'Broken on purpose: [a missing file](./missing.md) and ![a missing picture](./nowhere.png).',
  '',
].join('\n');

const WIDE = [
  '# Wide table and long code',
  '',
  `| ${Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`).join(' | ')} |`,
  `|${' --- |'.repeat(12)}`,
  `| ${Array.from({ length: 12 }, (_, i) => `value-${i + 1}-with-some-length`).join(' | ')} |`,
  '',
  '```js',
  `const veryLongLine = ${JSON.stringify('x'.repeat(260))};`,
  '```',
  '',
].join('\n');

const LONG = ['# A long document', '', ...Array.from({ length: 60 }, (_, i) =>
  `## Section ${i + 1}\n\nParagraph ${i + 1}, hard-wrapped at seventy-two columns the way\nmost repository documents are, so single line breaks must read as spaces.\n`)].join('\n');

const XSS = [
  '# Hostile',
  '',
  '<script>globalThis.__pwned = "script"</script>',
  '<img src=x onerror="globalThis.__pwned = \'onerror\'">',
  '[click](javascript:globalThis.__pwned=1)',
  '<iframe src="https://example.com"></iframe>',
  '<a href="tel:+4912345">phone</a>',
  '',
].join('\n');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-markdown-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-markdown-userdata-'));
await mkdir(SHOTS, { recursive: true });

const files = {
  'CONTRIBUTING.md': '# Contributing\n\nFork, branch, pull request.\n',
  'docs/flow.png': makeFlowPng(),
  'skills/release/SKILL.md': SKILL,
  'empty.md': '',
  'front-matter-only.md': '---\nname: only-a-head\ndescription: Nothing below the head.\n---\n',
  'wide.md': WIDE,
  'long.md': LONG,
  'big.md': 'y'.repeat(1024 * 1024 + 1),
  'hostile.md': XSS,
  'notes.txt': 'Plain text, for the height of the header without a switch.\n',
  'a-rather-long-file-name-that-has-to-share-the-header-with-the-switch.md': SKILL,
};
for (const [name, content] of Object.entries(files)) {
  const file = path.join(workspace, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

// Everything the window asks for that is neither the app itself nor a data URI.
const requests = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith('data:') && !url.startsWith('file:') && !url.startsWith('devtools:')) requests.push(url);
});

const pane = () =>
  page.evaluate(() => ({
    preview: !document.getElementById('file-preview').classList.contains('hidden'),
    info: !document.getElementById('file-info').classList.contains('hidden'),
    name: document.getElementById('preview-filename').textContent,
    view: document.querySelector('#preview-body > .file-view')?.dataset.view ?? null,
    doc: document.querySelector('.md-doc')?.textContent ?? null,
    images: document.querySelectorAll('.md-doc img.md-image[src^="data:"]').length,
    placeholders: document.querySelectorAll('.md-doc .chat-md-image').length,
  }));

async function expandAndOpen(...names) {
  for (const name of names) {
    await page.evaluate((fileName) => {
      [...document.querySelectorAll('#tree-container .tree-item')]
        .find((el) => el.querySelector('.label')?.textContent === fileName)
        ?.click();
    }, name);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function shoot(state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 150));
    await page.locator('#content').screenshot({ path: path.join(SHOTS, `markdown-${label}-${state}-${theme}.png`) });
  }
}

try {
  await poll(
    async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'tree' }
  );
  await page.setViewportSize?.({ width: 1440, height: 900 });

  await expandAndOpen('skills', 'release', 'SKILL.md');
  await poll(async () => {
    const s = await pane();
    return s.view === 'markdown' && s.images === 1 && s.placeholders === 2;
  }, { what: 'SKILL.md rendered with its images' });
  await shoot('skill');

  console.log('header heights:', await page.evaluate(() => Object.fromEntries(
    ['#preview-header', '#tree-header', '#chat-header']
      .map((sel) => [sel, document.querySelector(sel)?.getBoundingClientRect().height ?? null])
  )));

  // Scroll down to the table and the placeholders.
  await page.evaluate(() => { document.querySelector('.md-view').scrollTop = 560; });
  await new Promise((r) => setTimeout(r, 200));
  await shoot('skill-scrolled');

  // Source: by keyboard — focus the checked radio, arrow to the right.
  await page.focus('.md-mode-switch input:checked');
  await page.keyboard.press('ArrowRight');
  await poll(async () => page.evaluate(() => {
    const pre = document.getElementById('preview-content');
    return Boolean(pre && pre.offsetParent && pre.textContent.startsWith('---\nname: release'));
  }), { what: 'source view' });
  await shoot('skill-source');
  console.log('focus after arrow:', await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName, value: el?.value, outline: getComputedStyle(el.closest('label')).outlineStyle };
  }));
  await page.keyboard.press('ArrowLeft');
  await poll(async () => (await page.evaluate(() => !document.querySelector('.md-view').hidden)), { what: 'back to preview' });

  // A relative link: opens CONTRIBUTING.md and selects it in the tree.
  await page.evaluate(() => {
    [...document.querySelectorAll('.md-doc a')].find((a) => a.textContent === 'a missing file').click();
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => { document.querySelector('.md-view').scrollTop = 99999; });
  await shoot('link-missing');
  await page.evaluate(() => {
    [...document.querySelectorAll('.md-doc a')].find((a) => a.textContent === 'CONTRIBUTING').click();
  });
  await poll(async () => (await pane()).name === 'CONTRIBUTING.md', { what: 'CONTRIBUTING.md via link' });
  console.log('tree selection after link:', await page.evaluate(() =>
    document.querySelector('#tree-container .tree-item.active .label')?.textContent));

  for (const [name, state] of [
    ['empty.md', 'empty'],
    ['front-matter-only.md', 'front-matter-only'],
    ['wide.md', 'wide'],
    ['long.md', 'long'],
    ['hostile.md', 'hostile'],
  ]) {
    await expandAndOpen(name);
    await poll(async () => (await pane()).name === name, { what: name });
    await new Promise((r) => setTimeout(r, 200));
    await shoot(state);
  }
  console.log('pwned:', await page.evaluate(() => globalThis.__pwned ?? null));
  console.log('hostile links:', await page.evaluate(() =>
    [...document.querySelectorAll('.md-doc a')].map((a) => ({ text: a.textContent, href: a.getAttribute('href') }))));

  // A narrow middle column with a long name: the name gives way, not the switch.
  await expandAndOpen('a-rather-long-file-name-that-has-to-share-the-header-with-the-switch.md');
  await poll(async () => (await pane()).view === 'markdown', { what: 'long name' });
  await page.evaluate(() => {
    const content = document.getElementById('content');
    content.style.flex = '0 0 380px';
    content.style.maxWidth = '380px';
  });
  await new Promise((r) => setTimeout(r, 300));
  await shoot('narrow');
  await page.evaluate(() => {
    const content = document.getElementById('content');
    content.style.flex = '';
    content.style.maxWidth = '';
  });

  await expandAndOpen('notes.txt');
  await poll(async () => (await pane()).name === 'notes.txt', { what: 'notes.txt' });
  console.log('header height, plain text:', await page.evaluate(() =>
    document.getElementById('preview-header').getBoundingClientRect().height));

  await expandAndOpen('big.md');
  await poll(async () => (await pane()).info, { what: 'big.md on the info card' });
  await shoot('too-large');

  console.log('requests outside file:/data::', requests);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
