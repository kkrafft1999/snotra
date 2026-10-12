// The model proposes to switch a skill or tool for one chat (#774), in the
// real app: the card, accepting and the run going on with the tool, declining
// and the repeated proposal that is not shown again, an unknown name that
// never reaches a card — and the change surviving a chat switch while a new
// chat starts without it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

async function writeSkill(dir, name, description) {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nPDF steps.\n`, 'utf8');
}

const toolNames = (request) => (request?.body.tools || []).map((tool) => tool.function?.name);

test('a proposal card switches for this chat only — accept, decline, unknown, chat switch', { timeout: 240000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-proposal-');
  const userDataDir = await makeTempDir('snotra-proposal-userdata-');
  const home = await makeTempDir('snotra-proposal-home-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await writeSkill(path.join(home, '.snotra', 'skills'), 'pdf-export', 'Turns Markdown into a PDF.');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({
    appLocale: 'en',
    disabledTools: ['fetch_url'],
  }), 'utf8');

  const snotra = await launchApp({ userDataDir, home });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;
  const explain = async () => `chat: ${await page.evaluate(() => document.getElementById("chat-messages")?.innerText.slice(-600))}\nanswers left: ${JSON.stringify(model.pendingAnswers?.() ?? null)}\n${JSON.stringify(model.describeRequests(), null, 1)}\nmain:\n${snotra.mainOutput()}`;
  const configCards = () => page.evaluate(() => [...document.querySelectorAll('.chat-approval-card--config')].map((card) => ({
    id: card.dataset.requestId,
    state: card.dataset.state,
    title: card.querySelector('.chat-approval-card__title')?.textContent || '',
    headline: card.querySelector('.chat-approval-card__headline')?.textContent || '',
    meta: card.querySelector('.chat-approval-card__meta')?.textContent || '',
    reason: card.querySelector('.chat-approval-card__why-text')?.textContent || '',
  })));
  const toolLines = () => page.evaluate(() => [...document.querySelectorAll('#chat-messages .chat-tool-line')].map((row) => row.textContent.trim()));
  const lastAnswer = () => page.evaluate(() => {
    const bubbles = document.querySelectorAll('#chat-messages .chat-msg.assistant');
    return bubbles[bubbles.length - 1]?.textContent || '';
  });
  const click = (response) => page.evaluate((value) => {
    document.querySelector(`.chat-approval-card--config[data-state="pending"] button[data-response="${value}"]`)?.click();
  }, response);

  // The app is ready once the pill has counted the chat's skills.
  await poll(() => page.evaluate(() => /skill/.test(document.getElementById('chat-config-label')?.textContent || '')),
    { what: 'the pill counting skills', explain });

  // 1. Accept: the card names the catalogue's facts; the run goes on with the tool.
  model.queueAnswer({
    match: 'MARK-A',
    toolCalls: [{ name: 'propose_config_change', arguments: { kind: 'tool', name: 'fetch_url', enable: true, reason: 'To read the page you linked.' } }],
  });
  model.queueAnswer({ match: 'is on for this chat now', text: 'Done with the page.' });
  await sendChat(page, 'Read the page MARK-A', { explain, t });
  const [card] = await poll(async () => {
    const cards = await configCards();
    return cards.length === 1 && cards[0].state === 'pending' ? cards : null;
  }, { what: 'the proposal card', explain });
  assert.equal(card.title, 'Switch on for this chat');
  assert.match(card.headline, /^fetch_url \S/);
  assert.match(card.meta, /External services/);
  assert.match(card.meta, /this chat only/);
  assert.equal(card.reason, 'To read the page you linked.');
  const asked = model.requestFor('MARK-A');
  assert.equal(toolNames(asked).includes('fetch_url'), false, 'off before the card');
  assert.equal(toolNames(asked).includes('propose_config_change'), true);

  await click('allow-once');
  await poll(async () => (await lastAnswer()).includes('Done with the page.'), { what: 'the run going on after Accept', explain });
  const after = model.requestFor('is on for this chat now');
  assert.equal(toolNames(after).includes('fetch_url'), true, 'on from the next round');
  assert.ok((await toolLines()).some((line) => line.includes('Switched on fetch_url for this chat')), JSON.stringify(await toolLines()));
  assert.equal((await configCards())[0].state, 'allowed');

  // The pill's popover marks it as this chat's.
  await page.click('#btn-chat-config');
  await poll(() => page.evaluate(() => [...document.querySelectorAll('#chat-config-popup .chat-config-row--tool')]
    .some((row) => row.textContent.includes('fetch_url') && row.querySelector('.chat-config-tag')?.textContent === 'this chat only')),
  { what: 'fetch_url marked "this chat only" in the popover', explain });
  await page.keyboard.press('Escape');

  // 2. Decline, then the same proposal again: no second card.
  model.queueAnswer({
    match: 'MARK-B',
    toolCalls: [{ name: 'propose_config_change', arguments: { kind: 'skill', name: 'pdf-export', enable: true, reason: 'You asked for a PDF.' } }],
  });
  model.queueAnswer({
    match: 'The user declined',
    toolCalls: [{ name: 'propose_config_change', arguments: { kind: 'skill', name: 'pdf-export', enable: true, reason: 'Really.' } }],
  });
  model.queueAnswer({ match: 'declined this change earlier', text: 'Fine, without the skill.' });
  await sendChat(page, 'Make a PDF MARK-B', { explain, t });
  await poll(async () => (await configCards()).some((c) => c.state === 'pending' && c.headline.startsWith('pdf-export')),
    { what: 'the skill proposal card', explain });
  const skillCard = (await configCards()).find((c) => c.state === 'pending');
  assert.match(skillCard.headline, /From the skill’s author: “Turns Markdown into a PDF\.”/);
  await click('deny');
  await poll(async () => (await lastAnswer()).includes('Fine, without the skill.'), { what: 'the run after the repeated proposal', explain });
  assert.equal((await configCards()).filter((c) => c.headline.startsWith('pdf-export')).length, 1, 'one card for pdf-export');
  const lines = await toolLines();
  assert.ok(lines.some((line) => line.includes('Declined: switching on pdf-export')), JSON.stringify(lines));
  assert.ok(lines.some((line) => line.includes('Suggestion for pdf-export not shown — declined earlier in this chat')), JSON.stringify(lines));

  // 3. An unknown name never reaches a card.
  model.queueAnswer({
    match: 'MARK-C',
    toolCalls: [{ name: 'propose_config_change', arguments: { kind: 'tool', name: 'nope_tool', enable: true, reason: 'x' } }],
  });
  model.queueAnswer({ match: 'no tool named', text: 'That tool does not exist.' });
  await sendChat(page, 'Something MARK-C', { explain, t });
  await poll(async () => (await lastAnswer()).includes('That tool does not exist.'), { what: 'the answer after an unknown name', explain });
  assert.equal((await configCards()).length, 2, 'no card for an unknown name');

  // 4. A new chat starts without the change; back in the first chat it is there.
  const firstChatId = await poll(() => page.evaluate(() => {
    if (document.getElementById('app').classList.contains('app--no-history')) document.getElementById('btn-toggle-chat-history').click();
    return document.querySelector('.chat-history-row--current[data-chat-id]')?.dataset.chatId || null;
  }), { what: 'the first chat in the history', explain });
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  await poll(() => page.evaluate((id) => {
    const row = document.querySelector(`.chat-history-row[data-chat-id="${id}"]`);
    return Boolean(row) && !row.classList.contains('chat-history-row--current');
  }, firstChatId), { what: 'a new chat on screen', explain });
  model.queueAnswer({ match: 'MARK-D', text: 'New chat answer.' });
  await sendChat(page, 'Fresh start MARK-D', { explain, t });
  await poll(async () => (await lastAnswer()).includes('New chat answer.'), { what: 'the answer in the new chat', explain });
  assert.equal(toolNames(model.requestFor('MARK-D')).includes('fetch_url'), false, 'a new chat keeps the settings');

  await page.evaluate((id) => document.querySelector(`.chat-history-row[data-chat-id="${id}"]`)?.click(), firstChatId);
  await poll(() => page.evaluate((id) => Boolean(document.querySelector(`.chat-history-row--current[data-chat-id="${id}"]`))
    && [...document.querySelectorAll('#chat-messages .chat-msg.user')].some((b) => b.textContent.includes('MARK-A')), firstChatId),
  { what: 'back in the first chat', explain });
  model.queueAnswer({ match: 'MARK-E', text: 'Still on here.' });
  await sendChat(page, 'Once more MARK-E', { explain, t });
  await poll(async () => (await lastAnswer()).includes('Still on here.'), { what: 'the answer back in the first chat', explain });
  assert.equal(toolNames(model.requestFor('MARK-E')).includes('fetch_url'), true, 'the change survives the chat switch');
});
