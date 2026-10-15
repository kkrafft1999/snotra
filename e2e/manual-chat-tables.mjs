// Look instead of trust: starts the real app with an answer that holds three
// tables — numbers to align, a column set by the Markdown, one too wide for
// the column — and takes screenshots of the chat in both themes (#961).
// Not a test — a look.
//
//   node e2e/manual-chat-tables.mjs
//
// Result: out/mockup/chat-tables-{wide,narrow}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const QUESTION = 'Which files in src/renderer are the largest?';
const ANSWER = [
  'These are the three largest files in `src/renderer`:',
  '',
  '| File | Lines | Last changed | Purpose |',
  '|---|---|---|---|',
  '| `styles.css` | 7 412 | 14.10.2026 | Every style of the interface, including chat, tree and dialogs |',
  '| `components/ChatStream.js` | 1 288 | 12.10.2026 | Renders messages and tool calls |',
  '| `file-views/markdown-view.js` | 604 | 09.10.2026 | Markdown preview in the file pane |',
  '',
  'Releases, with the alignment set in the Markdown:',
  '',
  '| Version | Date | Issues |',
  '|:---|:---:|---:|',
  '| 1.22.0 | 2026-10-15 | 4 |',
  '| 1.21.1 | 2026-10-12 | 1 |',
  '',
  'And a wide one that has to scroll:',
  '',
  '| Provider | Model | Context | Input € / 1M | Output € / 1M | Tools | Images | Reasoning | Region | Notes |',
  '|---|---|---|---|---|---|---|---|---|---|',
  '| OpenAI | gpt-5.2 | 400 000 | 1,25 | 10,00 | yes | yes | yes | EU | default in Snotra |',
  '| Local | mlx-lm | 32 768 | 0 | 0 | yes | no | no | this machine | needs Apple Silicon |',
  '',
  '`styles.css` is by far the largest.',
].join('\n');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-chat-tables-');
const userDataDir = await makeTempDir('snotra-chat-tables-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

try {
  await poll(() => page.evaluate(() => !!document.getElementById('chat-input')), { what: 'chat ready' });
  model.queueAnswer({ match: QUESTION, text: ANSWER });
  await sendChat(page, QUESTION);
  await poll(() => page.evaluate(() => document.querySelectorAll('#chat-messages .chat-table-frame').length === 3),
    { what: 'three framed tables' });
  await page.waitForTimeout(300);

  for (const [width, height] of [[1440, 1300], [900, 1300]]) {
    const size = width > 1000 ? 'wide' : 'narrow';
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
    await page.waitForTimeout(400);
    const facts = await page.evaluate(() => [...document.querySelectorAll('#chat-messages .chat-table-frame')]
      .map((frame) => ({
        align: [...frame.querySelectorAll('thead th')].map((th) => getComputedStyle(th).textAlign),
        scrolls: frame.scrollWidth > frame.clientWidth,
      })));
    console.log(size, JSON.stringify(facts));

    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
      }, theme);
      await page.evaluate(() => document.querySelector('#chat-messages .chat-msg.assistant:last-of-type')
        .scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(SHOTS, `chat-tables-${size}-${theme}.png`) });
    }
  }
} finally {
  await snotra.stop();
  await model.close();
}
