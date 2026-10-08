// Look instead of trust (#792): starts the real app with shell_execute
// switched on and the real sandbox, lets the fake model run one command that
// writes outside the workspace, reads a protected location and connects to a
// host it may not reach, and photographs what the chat shows under the tool
// log — light and dark, with the raw lines folded and unfolded. Then it starts
// the app again and checks that the box comes back from the history.
// Not a test — a look.
//
//   node e2e/manual-sandbox-blocked.mjs [en|de]
//
// macOS does not nest sandboxes: run it outside of one (a Claude Code session
// needs the sandbox bypass for it).
//
// Result: out/mockup/sandbox-blocked-<locale>-{closed,raw}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const ASK = 'Install the requirements please.';
const COMMAND = 'mkdir -p "$HOME/Library/Caches/snotra-look/http-v2/a" '
  + '; for i in 1 2 3; do echo x > "$HOME/Library/Caches/snotra-look/http-v2/a/f$i"; done'
  + '; cat "$HOME/.ssh/config" > /dev/null'
  + '; curl -sS -m 10 -o /dev/null https://example.com; echo done';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-sandbox-blocked-');
const userDataDir = await makeTempDir('snotra-sandbox-blocked-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'requirements.txt'), 'requests\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }),
  'utf8',
);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTree(page) {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
}

async function shoot(page, state) {
  const box = page.locator('#chat-messages .chat-msg.assistant').last();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    await box.screenshot({ path: path.join(SHOTS, `sandbox-blocked-${locale}-${state}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const describeBox = (page) => page.evaluate(() => {
  const el = document.querySelector('#chat-messages .chat-sandbox-blocked');
  if (!el) return null;
  return {
    title: el.querySelector('.chat-sandbox-blocked-title')?.textContent.replace(/\s+/g, ' ').trim(),
    entries: [...el.querySelectorAll('.chat-sandbox-blocked-entry')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
    order: [...el.parentElement.children].map((c) => c.className.split(' ')[0]),
  };
});

let snotra = await launchApp({ userDataDir });
try {
  let { page } = snotra;
  await waitForTree(page);

  model.queueAnswer({ match: ASK, toolCalls: [{ name: 'shell_execute', arguments: { command: COMMAND } }] });
  await page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, ASK);
  await poll(() => page.evaluate(() => {
    const once = document.querySelector('#chat-messages .chat-approval-card[data-state="pending"] button[data-response="allow-once"]');
    if (!once || once.disabled) return false;
    once.click();
    return true;
  }), { what: 'approval card', timeoutMs: 30_000 });
  const live = await poll(() => describeBox(page), { what: 'sandbox box', timeoutMs: 60_000 });
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });
  console.log('live:', JSON.stringify(live, null, 2));
  const toolResult = model.requests.map((r) => r.body?.messages?.findLast?.((m) => m.role === 'tool')?.content)
    .filter(Boolean).at(-1) || '{}';
  console.log('model reads:', JSON.parse(toolResult).stderr);

  await shoot(page, 'closed');
  await page.evaluate(() => { document.querySelector('#chat-messages .chat-sandbox-blocked-raw').open = true; });
  await shoot(page, 'raw');

  // From the history: the same box after a restart.
  await snotra.stop();
  snotra = await launchApp({ userDataDir });
  page = snotra.page;
  await waitForTree(page);
  const restored = await poll(() => describeBox(page), { what: 'sandbox box from the history', timeoutMs: 30_000 });
  console.log('after restart:', JSON.stringify(restored) === JSON.stringify(live) ? 'same box' : JSON.stringify(restored, null, 2));
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
