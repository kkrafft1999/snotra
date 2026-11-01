// Look instead of trust: starts the real app with earlier chats in two
// folders, lets the model call search_chats, and shows the line it leaves in
// the chat, the tool's switch in the settings and the notice when a local chat
// is switched to a cloud model (#1315). Light and dark. Not a test — a look.
//
//   node e2e/manual-search-chats.mjs [en|de]
//
// The fake model listens on 127.0.0.1, so the chat is local and finds every
// chat of its folder. A second entry points at a host on the network and is
// never called: choosing it only brings up the notice.
//
// Result: out/mockup/search-chats-<locale>-*.png

import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat, waitForFolderChat } from './helpers/app.mjs';

const locale = process.argv.includes('de') ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const shot = (name) => path.join(SHOTS, `search-chats-${locale}-${name}.png`);

const TEXT = {
  en: {
    earlier: [
      ['Release 1.28.1', 'The manual marker was wrong after the release. We moved the release marker to the top of the notes.'],
      ['Crop rotation for next year', 'Beans after potatoes, then cabbage.'],
    ],
    other: ['Customer project kick-off', 'The release marker of the customer project stays private.'],
    question: 'What did we decide about the release marker?',
    answer: 'In “Release 1.28.1” you moved the release marker to the top of the notes.',
  },
  de: {
    earlier: [
      ['Release 1.28.1', 'Der Handbuch-Marker war nach dem Release falsch. Wir haben den Release-Marker an den Anfang der Notes gesetzt.'],
      ['Fruchtfolge fürs nächste Jahr', 'Bohnen nach Kartoffeln, dann Kohl.'],
    ],
    other: ['Kick-off Kundenprojekt', 'Der Release-Marker des Kundenprojekts bleibt vertraulich.'],
    question: 'Was haben wir zum Release-Marker entschieden?',
    answer: 'In „Release 1.28.1“ habt ihr den Release-Marker an den Anfang der Notes gesetzt.',
  },
}[locale];
const QUERY = locale === 'de' ? 'Release-Marker' : 'release marker';

const turn = (question, answer = 'Done.') => [{ role: 'user', content: question }, { role: 'assistant', content: answer }];

const model = await startFakeModel();
const workspace = await realpath(await makeTempDir('snotra-search-chats-'));
const otherFolder = await realpath(await makeTempDir('snotra-search-chats-other-'));
const userDataDir = await makeTempDir('snotra-search-chats-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
// A second entry on a host that is not this computer: a cloud model as far as
// Snotra can tell. It is chosen, never called.
const configFile = path.join(userDataDir, 'llm-config.json');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const localPresetId = config.activePresetId;
config.presets.push({
  id: randomUUID(),
  providerId: 'openai-compatible',
  model: 'gateway-model',
  menuVisible: true,
  connection: {
    displayName: 'Cloud Gateway', baseUrl: 'https://gateway.example.com/v1', apiStyle: 'chat',
    sendTools: true, supportsImages: false, insecureTls: false,
  },
});
await writeFile(configFile, JSON.stringify(config), 'utf8');

const now = Date.now();
const sessions = [
  { id: 'current', workspaceRoot: workspace, title: locale === 'de' ? 'Release-Fragen' : 'Release questions', updatedAt: now - 60_000, messages: turn('Hi', 'Hello.'), modelPresetId: localPresetId },
  ...TEXT.earlier.map(([title, body], i) => ({
    id: `earlier-${i}`, workspaceRoot: workspace, title, updatedAt: now - (i + 2) * 86_400_000, messages: turn(body), modelPresetId: localPresetId,
  })),
  { id: 'other-folder', workspaceRoot: otherFolder, title: TEXT.other[0], updatedAt: now - 3_600_000, messages: turn(TEXT.other[1]), modelPresetId: localPresetId },
];
await writeFile(path.join(userDataDir, 'chat-history.json'),
  JSON.stringify({ version: 2, activeByWorkspace: { [workspace]: 'current' }, sessions }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;
const chat = page.locator('#chat-panel');

async function theme(value) {
  await page.evaluate((v) => { document.documentElement.dataset.theme = v; }, value);
  await page.waitForTimeout(300);
}

try {
  await waitForFolderChat(page);

  // 1. The model searches the earlier chats, then answers.
  model.queueAnswer({ match: TEXT.question, toolCalls: [{ name: 'search_chats', arguments: { query: QUERY } }] });
  model.queueAnswer({ match: '"tool"', text: TEXT.answer });
  await sendChat(page, TEXT.question);
  await poll(() => page.evaluate((answer) => document.getElementById('chat-messages').textContent.includes(answer), TEXT.answer),
    { what: 'the answer', explain: () => model.describeRequests().join('\n') });
  await page.waitForTimeout(400);
  const toolResult = JSON.stringify(model.requests.filter((r) => !r.isTitleRequest).flatMap((r) => r.body?.messages ?? []).filter((m) => m.role === 'tool'));
  console.log('tool result:', toolResult.slice(0, 600));
  console.log('found earlier chat:', toolResult.includes('earlier-0'), '| other folder leaked:', toolResult.includes('other-folder'),
    '| current chat leaked:', toolResult.includes('"chat":"current"'));
  console.log('trace lines:', await page.evaluate(() => [...document.querySelectorAll('.tool-log, .chat-tool-log, [class*="tool-line"]')]
    .map((el) => el.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 4)));
  // The collapsed log says "1 search"; open it to show the line itself.
  await page.click('#chat-messages details.chat-tool-log');
  await page.waitForTimeout(200);
  console.log('opened log:', await page.evaluate(() => document.querySelector('#chat-messages .chat-tool-lines').textContent.trim()));
  await page.mouse.move(0, 0);
  await chat.screenshot({ path: shot('trace-light') });
  await theme('dark');
  await chat.screenshot({ path: shot('trace-dark') });
  await theme('light');

  // 2. Its switch under Settings › Tools › Autonomy.
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Settings|Einstellungen)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')), { what: 'settings' });
  await page.click('#tab-settings-security');
  await poll(() => page.evaluate(() => !!document.querySelector('.settings-security-row__toggle[data-risk-class="read"]')), { what: 'the read row' });
  await page.evaluate(() => {
    const toggle = document.querySelector('.settings-security-row__toggle[data-risk-class="read"]');
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  });
  const toggle = page.locator('[data-tool-switch="search_chats"]');
  await poll(async () => (await toggle.count()) > 0, { what: 'the switch of search_chats' });
  await toggle.scrollIntoViewIfNeeded();
  console.log('switch row:', await toggle.evaluate((input) => input.closest('li')?.textContent.trim().replace(/\s+/g, ' ')),
    '| checked:', await toggle.isChecked());
  await page.evaluate(() => document.querySelector('[data-tool-switch="search_chats"]').scrollIntoView({ block: 'center' }));
  await page.mouse.move(0, 0);
  await page.screenshot({ path: shot('switch-light') });
  await theme('dark');
  await page.screenshot({ path: shot('switch-dark') });
  await theme('light');
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => document.getElementById('modal-settings').classList.contains('hidden')), { what: 'settings closed' });

  // 3. The local chat switched to the cloud entry: the notice, once.
  await page.evaluate(() => document.getElementById('btn-chat-model-picker').click());
  await poll(() => page.evaluate(() => !document.getElementById('chat-model-menu').classList.contains('hidden')), { what: 'model menu' });
  await page.evaluate(() => [...document.querySelectorAll('.chat-model-menu-option')]
    .find((b) => b.textContent.includes('Cloud Gateway') || b.textContent.includes('gateway-model'))?.click());
  await poll(() => page.evaluate(() => document.querySelectorAll('#app-notices .app-notice').length === 1), { what: 'the notice' });
  console.log('notice:', await page.evaluate(() => document.querySelector('#app-notices .app-notice').textContent.trim().replace(/\s+/g, ' ')));
  const notices = page.locator('#app-notices');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: shot('notice-window-light') });
  await notices.screenshot({ path: shot('notice-light') });
  await theme('dark');
  await notices.screenshot({ path: shot('notice-dark') });
  await page.screenshot({ path: shot('notice-window-dark') });
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
