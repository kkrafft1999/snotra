// Distilling a chat on request (#1316): a chat with one fact, one rule and one
// episode; the user asks what to take away from it. The model loads
// snotra-memory, proposes the fact and the rule one at a time through
// `remember`, each on its own card with kind and reader, and nothing for the
// episode. The proposals are `requested`, so they go through with unprompted
// remembering switched off.
//
// The fake model scripts what a real one would decide; what is tested is the
// wiring around it — the trigger in the catalog, the guidance that reaches the
// model, one card per proposal, and the writes past the switch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const FACT = 'The garden planner measures beds in centimetres.';
const RULE = 'When you tag a release, check the manual marker first.';
const EPISODE = 'Today the south bed test is failing.';
const ASK = 'What do we take away from this chat?';
const CLOSING = 'That is all that lasts; the failing test was only today.';

test('distilling a chat proposes the fact and the rule, one card each, and not the episode', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-distil-');
  const userDataDir = await makeTempDir('snotra-distil-userdata-');
  await writeFile(path.join(workspace, 'AGENTS.md'), '# Garden planner\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'),
    JSON.stringify({ appLocale: 'en', memorySelfEnabled: false }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;
  const evidence = async () => [
    `model requests: ${JSON.stringify(model.describeRequests(), null, 1)}`,
    `answers not taken: ${JSON.stringify(model.pendingAnswers())}`,
    `main:\n${snotra.mainOutput()}`,
  ].join('\n');
  const PENDING = '#chat-messages .chat-approval-card[data-state="pending"]';

  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });

  // The chat to distil: a fact, a rule, an episode. Unqueued, the fake model
  // answers each with a short default.
  for (const line of [FACT, RULE, EPISODE]) await sendChat(page, line, { explain: evidence, t });
  // The answers below would otherwise be taken by the last of these turns.
  await poll(async () => model.requests.filter((r) => !r.isTitleRequest && r.finished).length === 3
    && page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'the three turns answered', timeoutMs: 30000, explain: evidence });

  model.queueAnswer({ match: ASK, toolCalls: [{ name: 'load_skill', arguments: { name: 'snotra-memory' } }] });
  model.queueAnswer({
    // Only the loaded skill body says this; the raw request escapes its quotes.
    match: 'Never an episode',
    toolCalls: [{ name: 'remember', arguments: { kind: 'fact', scope: 'team', text: FACT, origin: 'requested' } }],
  });
  model.queueAnswer({
    match: FACT,
    toolCalls: [{ name: 'remember', arguments: {
      kind: 'rule', scope: 'workspace', topic: 'releases', description: 'When you tag a release',
      text: RULE, origin: 'requested',
    } }],
  });
  model.queueAnswer({ match: RULE, text: CLOSING });
  await sendChat(page, ASK, { explain: evidence, t });

  // One card at a time: the second proposal only comes after the first answer.
  const cards = [];
  for (const expected of [{ kind: 'fact', scope: 'team', text: FACT }, { kind: 'rule', scope: 'workspace', text: RULE }]) {
    const card = await poll(() => page.evaluate((selector) => {
      const pending = [...document.querySelectorAll(selector)];
      const last = pending.at(-1);
      if (!last?.querySelector('.chat-approval-card__pills')) return null;
      return {
        pending: pending.length,
        kind: last.querySelector('input[name$="remember-kind"]:checked')?.value ?? null,
        scope: last.querySelector('input[name$="remember-reader"]:checked')?.value ?? null,
        text: last.textContent.replace(/\s+/g, ' '),
      };
    }, PENDING), { what: `remember card for the ${expected.kind}`, timeoutMs: 30000, explain: evidence });
    assert.equal(card.pending, 1, 'one card at a time');
    assert.equal(card.kind, expected.kind, `${card.text}\n${await evidence()}`);
    assert.equal(card.scope, expected.scope);
    assert.ok(card.text.includes(expected.text), card.text);
    cards.push(card);
    await page.evaluate((selector) =>
      document.querySelector(`${selector} button[data-response="allow-once"]`).click(), PENDING);
  }

  await poll(() => page.evaluate((closing) =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
    && document.querySelector('#chat-messages > li:last-child')?.textContent.includes(closing), CLOSING),
  { what: 'run through', timeoutMs: 60000, explain: evidence });

  // The trigger stands in the catalog the model sees, and the skill it loads
  // carries the distilling guidance.
  const distilRequest = model.requests.find((r) => !r.isTitleRequest && JSON.stringify(r.body).includes(ASK));
  assert.match(JSON.stringify(distilRequest.body), /distil this chat/, 'the trigger reaches the model');
  const skillText = model.requests
    .flatMap((r) => r.body?.messages ?? [])
    .find((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('"skill":"snotra-memory"'))?.content;
  assert.ok(skillText, `snotra-memory never reached the model\n${await evidence()}`);
  assert.match(skillText, /Distil/);
  assert.match(skillText, /Never an episode/);
  assert.match(skillText, /one item at a time/);

  // Exactly two cards, and nothing about the episode on either.
  const allCards = await page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .chat-approval-card')].map((c) => c.textContent.replace(/\s+/g, ' ')));
  assert.equal(allCards.length, 2, JSON.stringify(allCards));
  assert.ok(allCards.every((text) => !text.includes(EPISODE)), JSON.stringify(allCards));

  // Both written although unprompted remembering is off: they were requested.
  const agents = await poll(async () => {
    const text = await readFile(path.join(workspace, 'AGENTS.md'), 'utf8');
    return text.includes(FACT) ? text : null;
  }, { what: 'fact at the end of AGENTS.md', explain: evidence });
  assert.equal(agents.includes(EPISODE), false);
  const rules = await poll(() => readFile(path.join(workspace, '.agents', 'rules', 'releases.md'), 'utf8').catch(() => null),
    { what: 'rule in .agents/rules/releases.md', explain: evidence });
  assert.ok(rules.includes(RULE), rules);
  const toolResults = model.requests.flatMap((r) => r.body?.messages ?? [])
    .filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.equal(toolResults.some((content) => /switched off/.test(content)), false, toolResults.join('\n'));
});
