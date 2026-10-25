// Look instead of trust (#1262): starts the real app with shell_execute on and
//  1. gives `gh` an allowance with a credential through Settings › Tools ›
//     Security — the dialog empty, with a new row, refusing a bad variable,
//     saved (masked) and while replacing — and photographs each state, light
//     and dark,
//  2. runs `gh api user` through the approval card and reports whether it
//     signed in with nothing but the allowance (domain, trustd, GH_TOKEN),
//  3. runs `gh auth token` and `env`, and reports whether the token shows up
//     in a tool result, the chat history, the policy file or the log,
//  4. removes the allowance and reports whether its secret is gone too.
// Not a test — a look. It needs a real token and the real `gh`; the token
// comes from SNOTRA_LOOK_TOKEN and is never printed. Run it outside the
// Claude Code sandbox, or the app's own sandbox cannot start (macOS does not
// nest them).
//
//   SNOTRA_LOOK_TOKEN=$(gh auth token) node e2e/manual-allowance-credentials.mjs [en|de]
//
// Result: out/mockup/credentials-<locale>-*.png

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const token = (process.env.SNOTRA_LOOK_TOKEN || '').trim();
if (token.length < 8) throw new Error('Set SNOTRA_LOOK_TOKEN to a real token, e.g. $(gh auth token).');
// Neither the token nor a token of the shell may reach the app by itself.
for (const name of ['SNOTRA_LOOK_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) delete process.env[name];

const SHOTS = path.resolve('out/mockup');
const RUN = 'Who am I on GitHub?';
const PRINT = 'Print the token please.';
const ENV = 'Show the environment please.';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-credentials-');
const userDataDir = await makeTempDir('snotra-credentials-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }),
  'utf8',
);
// `gh` runs for real, with the real home folder and its locked ~/.config/gh.
const snotra = await launchApp({ userDataDir, home: false });
const { app, page } = snotra;
const shot = (name) => path.join(SHOTS, `credentials-${locale}-${name}.png`);
const pause = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const leaks = (text) => String(text).includes(token);
// Whatever this script prints goes through here: a leak is reported, never shown.
const safe = (text) => (leaks(text) ? '[contains the token, not printed]' : text);

async function themed(name, take) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
      for (const animation of document.getAnimations()) {
        try { animation.finish(); } catch { /* an endless one (the spinner) keeps running */ }
      }
    }, theme);
    await pause();
    await take(shot(`${name}-${theme}`));
  }
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
}

// The credentials sit at the end of a body that scrolls: show its end.
const dialogShot = async (name) => {
  await page.evaluate(() => {
    const body = document.querySelector('#dialog-program-allowance .modal-dialog__body');
    body.scrollTop = body.scrollHeight;
  });
  await themed(name, (file) => page.locator('#dialog-program-allowance').screenshot({ path: file }));
};

async function type(selector, value) {
  await page.evaluate(({ selector: target, value: text }) => {
    const input = document.querySelector(target);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { selector, value });
}

const click = (selector) => page.evaluate((target) => document.querySelector(target).click(), selector);
const focused = () => page.evaluate(() => {
  const node = document.activeElement;
  return `${node?.tagName?.toLowerCase()}${node?.id ? `#${node.id}` : ''}[${node?.dataset?.field || node?.getAttribute('aria-label') || ''}]`;
});
const formError = () => page.evaluate(() => document.getElementById('allowance-credentials-error').textContent
  || `(form) ${document.getElementById('allowance-form-error').textContent}`);

function pendingCard() {
  return page.locator('#chat-messages .chat-approval-card[data-state="pending"]').last();
}

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 90_000 });
}

function lastToolResult() {
  return model.requests
    .filter((r) => !r.isTitleRequest)
    .flatMap((r) => r.body?.messages || [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .at(-1) || '';
}

async function run(question, command, cardShot = null) {
  model.queueAnswer({ match: question, toolCalls: [{ name: 'shell_execute', arguments: { command } }] });
  await sendChat(page, question);
  await poll(() => page.evaluate(() => !!document.querySelector('#chat-messages .chat-approval-card[data-state="pending"]')),
    { what: `card for ${command}`, timeoutMs: 30_000 });
  const card = await pendingCard().evaluate((el) => el.querySelector('.chat-approval-card__allowance')?.textContent?.replace(/\s+/g, ' ') || '(no allowance line)');
  if (cardShot) await themed(cardShot, (file) => pendingCard().screenshot({ path: file }));
  await pendingCard().evaluate((el) => el.querySelector('button[data-response="allow-once"]').click());
  try {
    await idle();
  } catch (error) {
    console.log('still running; the chat shows:', safe(await page.evaluate(() => document.getElementById('chat-messages').innerText.slice(-1500))));
    throw error;
  }
  const result = lastToolResult();
  let parsed = null;
  try { parsed = JSON.parse(result); } catch { /* reported raw */ }
  return { card, result, parsed };
}

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full));
    else out.push(full);
  }
  return out;
}

async function profileLeaks() {
  const found = [];
  for (const file of await filesUnder(userDataDir)) {
    const text = await readFile(file).then((b) => b.toString('latin1'), () => '');
    if (leaks(text)) found.push(path.relative(userDataDir, file));
  }
  return found;
}

try {
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (win, options) => {
      globalThis.__dialogs.push(options || win);
      return { response: 0 };
    };
  });
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  // 1. The dialog, from the shield: this workspace preselected.
  await poll(() => page.evaluate(() => !document.getElementById('btn-tree-sandbox').hidden), { what: 'the folder shield', timeoutMs: 30_000 });
  await page.click('#btn-tree-sandbox');
  await poll(() => page.evaluate(() => !!document.querySelector('#settings-sandbox-detail [data-action="add-program"]')),
    { what: 'add program' });
  await click('#settings-sandbox-detail [data-action="add-program"]');
  await poll(() => page.evaluate(() => !document.getElementById('program-allowance-overlay').classList.contains('hidden')),
    { what: 'allowance dialog' });
  await type('#allowance-field-program', 'gh');
  console.log('program field:', await poll(() => page.evaluate(() => {
    const text = document.getElementById('allowance-program-status').textContent;
    return /…|\.\.\./.test(text) ? null : text;
  }), { what: 'program looked up' }));
  await type('#allowance-field-domains', 'api.github.com');
  await page.evaluate(() => {
    const box = document.getElementById('allowance-field-trustd');
    if (!box.closest('[hidden]') && !box.checked) box.click();
  });
  await dialogShot('dialog-empty');

  await click('#btn-allowance-credential-add');
  await pause();
  console.log('new row:', await page.evaluate(() => document.querySelector('#allowance-credential-list [data-field="name"]').value),
    '| focus:', await focused());
  await dialogShot('dialog-new');

  // Refusals: the form says why, the field is marked and focused.
  for (const [name, value] of [['1GH', ''], ['', ''], ['PATH', ''], ['GH_TOKEN', ''], ['GH_TOKEN', 'short']]) {
    await type('#allowance-credential-list [data-field="name"]', name);
    await type('#allowance-credential-list [data-field="value"]', value);
    await click('#btn-program-allowance-save');
    await pause(150);
    console.log(`refused ${JSON.stringify(name)}/${value ? 'short' : 'empty'}:`, await formError(), '| focus:', await focused(),
      '| aria-invalid:', await page.evaluate(() => document.activeElement?.getAttribute('aria-invalid')));
    if (name === '1GH') await dialogShot('dialog-invalid');
  }
  await type('#allowance-credential-list [data-field="name"]', 'GH_TOKEN');
  await type('#allowance-credential-list [data-field="value"]', `  ${token}\n`);
  await click('#btn-program-allowance-save');
  await poll(() => page.evaluate(() => document.getElementById('program-allowance-overlay').classList.contains('hidden')),
    { what: 'saved allowance', timeoutMs: 20_000 });
  const confirm = await app.evaluate(() => globalThis.__dialogs.at(-1));
  console.log('native dialog:', safe(JSON.stringify({ message: confirm?.message, detail: confirm?.detail })));
  await pause(500);
  const row = page.locator('.allowance-row').first();
  console.log('row:', safe(await row.evaluate((el) => el.textContent.replace(/\s+/g, ' '))));
  await themed('row', (file) => row.screenshot({ path: file }));

  // Saved: masked, then replacing, then kept.
  await row.evaluate((el) => el.querySelector('button[data-focus^="program-edit"]').click());
  await poll(() => page.evaluate(() => !document.getElementById('program-allowance-overlay').classList.contains('hidden')),
    { what: 'edit dialog' });
  await pause();
  console.log('saved row value in the DOM:', leaks(await page.evaluate(() => document.getElementById('dialog-program-allowance').outerHTML)) ? 'TOKEN VISIBLE' : 'masked');
  await dialogShot('dialog-saved');
  await click('#allowance-credential-list [data-field="replace"]');
  await pause();
  console.log('replace → focus:', await focused());
  await dialogShot('dialog-replace');
  await click('#allowance-credential-list [data-field="keep"]');
  await pause();
  console.log('keep → focus:', await focused());
  await click('#btn-program-allowance-cancel');
  await page.evaluate(() => document.getElementById('btn-settings-close')?.click());
  await poll(() => page.evaluate(() => document.getElementById('modal-settings').classList.contains('hidden')), { what: 'settings closed' });

  const policy = await readFile(path.join(userDataDir, 'tool-policy.json'), 'utf8');
  console.log('policy file:', leaks(policy) ? 'TOKEN IN CLEAR' : 'no token in clear',
    '| secrets stored:', Object.keys(JSON.parse(policy).payload.allowanceSecrets || {}).length);

  // 2. The run that matters.
  const who = await run(RUN, 'gh api user --jq .login', 'approval');
  console.log('card:', safe(who.card));
  console.log('gh api user → exit', who.parsed?.exit_code, '| stdout:', safe(String(who.parsed?.stdout ?? '').trim()),
    '| stderr:', safe(String(who.parsed?.stderr ?? who.result).trim().slice(0, 400)));
  console.log('model read:', safe(JSON.stringify(who.parsed?.sandbox?.program_allowance)));

  // 3. Where the token could show up.
  const printed = await run(PRINT, 'gh auth token');
  console.log('gh auth token → stdout:', safe(JSON.stringify(String(printed.parsed?.stdout ?? printed.result).trim())), '| leaks:', leaks(printed.result));
  const env = await run(ENV, 'env');
  console.log('env (not gh) → GH_TOKEN set:', /^GH_TOKEN=/m.test(String(env.parsed?.stdout ?? '')), '| leaks:', leaks(env.result));
  console.log('tool output pane:', leaks(await page.evaluate(() => document.getElementById('chat-messages').innerText)) ? 'TOKEN VISIBLE' : 'clean');
  await pause(1500);
  console.log('profile files with the token:', JSON.stringify(await profileLeaks()));

  // 4. Removing the allowance removes its secret.
  await page.click('#btn-tree-sandbox');
  await poll(() => page.evaluate(() => !!document.querySelector('.allowance-row button[data-focus^="program-remove"]')),
    { what: 'remove button' });
  await click('.allowance-row button[data-focus^="program-remove"]');
  await poll(async () => {
    const after = JSON.parse(await readFile(path.join(userDataDir, 'tool-policy.json'), 'utf8')).payload;
    return Object.keys(after.allowanceSecrets || {}).length === 0 && Object.keys(after.workspaceProgramAllowances || {}).length === 0;
  }, { what: 'allowance and secret removed', timeoutMs: 10_000 });
  console.log('after removing: no allowance, no secret');
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
