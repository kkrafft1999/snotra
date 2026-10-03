// Look instead of trust (#348): starts the real app, lets the fake model change
// files in every way the diff view has a state for, and photographs the line
// of changed files under the answer and the diff in the preview column — light
// and dark. Not a test — a look.
//
//   node e2e/manual-file-changes.mjs [en|de]
//
// Result: out/mockup/file-changes-<locale>-<state>-{light,dark}.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-changes-look-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-changes-look-userdata-'));
await mkdir(SHOTS, { recursive: true });

const formatJs = [
  "import { formatMinutes } from './time.js';",
  '',
  '// Formats durations for the run footer.',
  ...Array.from({ length: 8 }, (_, i) => `// note ${i + 1}`),
  'export function formatDuration(ms) {',
  '  if (ms < 1000) {',
  "    return ms + ' ms';",
  '  }',
  '  const seconds = Math.round(ms / 1000);',
  '  return formatMinutes(seconds);',
  '}',
  '',
  ...Array.from({ length: 12 }, (_, i) => `export const LIMIT_${i + 1} = ${i + 1};`),
].join('\n') + '\n';

const files = {
  'src/format.js': formatJs,
  'config.json': '{\n  "theme": "auto",\n  "timeout": 30,\n  "retries": 3\n}\n',
  'notes.txt': 'Draft notes from Monday\n- call vendor\n- check the offer\n',
  'build.bat': Array.from({ length: 52 }, (_, i) => `echo step ${i + 1}`).join('\r\n') + '\r\n',
  'min.js': `!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};${'return e[r].call(o.exports,o,o.exports,n);'.repeat(6)}}}([]);\n`,
  'data/export.csv': `id,value\n${'1,2\n'.repeat(700000)}`,
  'assets/logo.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]),
};
for (const [rel, content] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
  await writeFile(path.join(workspace, rel), content);
}

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(state, selector) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(250);
    const target = path.join(SHOTS, `file-changes-${locale}-${state}-${theme}.png`);
    if (selector) await page.locator(selector).screenshot({ path: target });
    else await page.screenshot({ path: target });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

/** The tool log and the line of changed files under it, nothing else. */
async function shootMessage(state) {
  await page.evaluate(() => document.querySelector('.chat-tool-log').scrollIntoView({ block: 'start' }));
  await pause(200);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(250);
    const clip = await page.evaluate(() => {
      const log = document.querySelector('.chat-tool-log').getBoundingClientRect();
      const strip = document.querySelector('.chat-changes').getBoundingClientRect();
      const message = document.querySelector('.chat-tool-log').parentElement.getBoundingClientRect();
      return { x: message.x - 12, y: log.y - 12, width: message.width + 24, height: strip.bottom - log.y + 24 };
    });
    await page.screenshot({ path: path.join(SHOTS, `file-changes-${locale}-${state}-${theme}.png`), clip });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

async function openChip(name) {
  await page.evaluate((label) => {
    const chip = [...document.querySelectorAll('.chat-changes button.chat-change-file')]
      .find((button) => button.querySelector('.chat-change-name').textContent === label);
    if (!chip) throw new Error(`no chip for ${label}`);
    chip.click();
  }, name);
  await poll(() => page.evaluate(() => {
    const view = document.querySelector('#preview-body .changes-view');
    return Boolean(view && (view.querySelector('table, .changes-state')));
  }), { what: `diff of ${name}` });
  await pause(200);
}

const describePreview = () => page.evaluate(() => ({
  name: document.getElementById('preview-filename').textContent,
  meta: document.getElementById('preview-meta').textContent,
  banners: [...document.querySelectorAll('.changes-banner')].map((b) => b.textContent),
  state: document.querySelector('.changes-state')?.textContent ?? null,
  rows: document.querySelectorAll('.diff-row').length,
  tools: [...document.querySelectorAll('#preview-tools label, #preview-tools option')].map((n) => n.textContent),
}));

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });

  model.queueAnswer({
    match: 'Tidy up',
    toolCalls: [
      { name: 'edit_file', arguments: { relative_path: 'src/format.js', old_string: "return ms + ' ms';", new_string: 'return `${ms} ms`;' } },
      { name: 'edit_file', arguments: { relative_path: 'config.json', old_string: '"timeout": 30', new_string: '"timeout": 60' } },
      { name: 'write_file_text', arguments: { relative_path: 'docs/durations.md', content: '# Durations\n\nUnder a minute: one decimal.\nFrom a minute on: m:ss.\n' } },
      { name: 'write_file_text', arguments: { relative_path: 'notes.txt', content: 'Meeting notes, 2 October\n- vendor called, offer pending\n- next call on Friday\n- send the summary\n' } },
      { name: 'write_file_text', arguments: { relative_path: 'build.bat', content: files['build.bat'].replaceAll('\r\n', '\n') } },
      { name: 'edit_file', arguments: { relative_path: 'min.js', old_string: 'l:!1', new_string: 'l:!0' } },
      { name: 'write_file_text', arguments: { relative_path: 'data/export.csv', content: 'id,value\n1,2\n' } },
      { name: 'write_file_text', arguments: { relative_path: 'assets/logo.bin', content: 'not an image any more\n' } },
    ],
  });
  model.queueAnswer({
    toolCalls: [
      { name: 'edit_file', arguments: { relative_path: 'src/format.js', old_string: '  const seconds = Math.round(ms / 1000);', new_string: '  const seconds = Math.round(ms / 100) / 10;\n  if (seconds < 60) return `${seconds} s`;' } },
    ],
  });
  model.queueAnswer({ text: 'Durations under a minute now show one decimal, e.g. 12.4 s. I also tidied up the notes and the build script.' });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Tidy up the project: one decimal for short durations.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });

  // Approve every write as it asks, until the run is through.
  await poll(async () => {
    await page.evaluate(() => {
      document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])')?.click();
    });
    return page.evaluate(() =>
      !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
      && document.querySelectorAll('.chat-changes .chat-change-file').length >= 8);
  }, { what: 'run through with changes', timeoutMs: 45000 });
  await page.mouse.move(0, 0);
  await pause(300);
  console.log('strip', await page.evaluate(() => document.querySelector('.chat-changes')?.textContent));
  await shootMessage('chat');

  // The tool log unfolded: every row carries its own counts.
  await page.evaluate(() => { document.querySelector('.chat-tool-log').open = true; });
  await pause(200);
  await shootMessage('chat-log');
  await page.evaluate(() => { document.querySelector('.chat-tool-log').open = false; });

  await openChip('format.js');
  console.log('format.js', JSON.stringify(await describePreview()));
  await shoot('format', null);

  // Every state the view has, one file each.
  for (const [name, state] of [
    ['config.json', 'one-line'],
    ['durations.md', 'created'],
    ['notes.txt', 'rewritten'],
    ['build.bat', 'eol'],
    ['min.js', 'long-lines'],
    ['export.csv', 'too-large'],
    ['logo.bin', 'binary'],
  ]) {
    await openChip(name);
    console.log(name, JSON.stringify(await describePreview()));
    await shoot(state, '#file-preview');
  }

  // Changed by hand afterwards: the diff says so.
  await writeFile(path.join(workspace, 'config.json'), '{ "edited": "by hand" }\n');
  await pause(600);
  await openChip('config.json');
  console.log('changed since', JSON.stringify(await describePreview()));
  await shoot('changed-since', '#file-preview');

  // "Content | Changes": back to the file itself.
  await page.click('#preview-tools input[value="content"]', { force: true });
  await poll(() => page.evaluate(() => Boolean(document.getElementById('preview-content'))), { what: 'content view' });
  await pause(200);
  await shoot('content', '#file-preview');
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
