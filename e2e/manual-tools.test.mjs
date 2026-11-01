// The chat looks things up in Snotra's own manual (#947): in the real app the
// model gets search_manual and read_manual_page, both answer from the manual
// that ships with the app in the language of the interface, and the tool log
// names the step a look into the manual rather than a file read. A link to the
// manual in the answer opens the bundled page in the help window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat, waitForFolderChat } from './helpers/app.mjs';

test('a question about Snotra is answered from the bundled manual', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-manual-tools-');
  const userDataDir = await makeTempDir('snotra-manual-tools-userdata-');
  const home = await makeTempDir('snotra-manual-tools-home-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  // The fake model listens on 127.0.0.1 and so gets the narrow local budget
  // (40,000 characters). A manual page fills most of it, and every tool
  // schema added since takes from the rest, until the search result is
  // shortened before the model reads it (#1315). Room as for a cloud model:
  // this test is about the manual tools, not about the local budget.
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'de', historyCharLimit: 200_000 }), 'utf8');

  const snotra = await launchApp({ userDataDir, home });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page, app } = snotra;
  // The folder's chat is drawn a round trip after the page and empties the
  // composer then; a question typed before it is wiped and looks sent (#869).
  await waitForFolderChat(page, { explain: async () => snotra.mainOutput() });

  model.queueAnswer({ match: 'Netzwerkzugriff', toolCalls: [{ name: 'search_manual', arguments: { query: 'Sandbox Host' } }] });
  model.queueAnswer({ toolCalls: [{ name: 'read_manual_page', arguments: { slug: 'safety/sandbox' } }] });
  model.queueAnswer({ text: 'Siehe [Befehle in der Sandbox ausführen](https://docs.snotra-ai.dev/de/safety/sandbox/#was-du-brauchst).' });
  await sendChat(page, 'Wie gebe ich einen Netzwerkzugriff frei?');

  const toolResults = () => {
    const last = [...model.requests].reverse().find((r) => !r.isTitleRequest && r.body.messages?.some((m) => m.role === 'tool'));
    return last ? last.body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content)) : [];
  };
  await poll(() => toolResults().length === 2, {
    what: 'both manual results sent back to the model',
    timeoutMs: 30000,
    explain: async () => `${JSON.stringify(model.describeRequests(), null, 1)}\nmain:\n${snotra.mainOutput()}`,
  });

  // The model is offered both tools, without an approval card in between.
  const asked = model.requests.find((r) => !r.isTitleRequest
    && r.body.messages?.some((m) => m.role === 'user' && String(m.content).includes('Netzwerkzugriff')));
  const offered = asked.body.tools.map((tool) => tool.function.name);
  assert.ok(offered.includes('search_manual'), offered.join(', '));
  assert.ok(offered.includes('read_manual_page'), offered.join(', '));

  const [search, read] = toolResults();
  // The language of the interface, the manual that ships with the app.
  assert.equal(search.locale, 'de');
  assert.ok(search.results.length > 0, JSON.stringify(search));
  assert.ok(search.results.every((hit) => hit.url.startsWith('https://docs.snotra-ai.dev/de/')), JSON.stringify(search));
  assert.equal(read.locale, 'de');
  assert.equal(read.slug, 'safety/sandbox');
  assert.equal(read.url, 'https://docs.snotra-ai.dev/de/safety/sandbox/');
  assert.match(read.markdown, /Sandbox/);
  assert.doesNotMatch(read.markdown, /screenshots\//);

  // The log: one line per look, folded into "2 Blicke ins Handbuch".
  const toolLog = () => page.evaluate(() => ({
    lines: [...document.querySelectorAll('.chat-tool-lines .chat-tool-line')]
      .map((line) => (line.querySelector('.chat-tool-line-text')?.textContent ?? line.textContent).trim()),
    summary: document.querySelector('.chat-tool-summary')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
  }));
  await poll(async () => (await toolLog()).summary?.includes('2 Blicke ins Handbuch'), {
    what: 'the folded log counting two looks into the manual',
    timeoutMs: 30000,
    explain: async () => JSON.stringify(await toolLog(), null, 1),
  });
  const { lines } = await toolLog();
  assert.ok(lines.includes('Im Handbuch nach „Sandbox Host“ gesucht'), JSON.stringify(lines));
  assert.ok(lines.includes('Handbuchseite safety/sandbox gelesen'), JSON.stringify(lines));

  // An overview question goes through the skill to the overview page (#952):
  // the skill only says where to look, the facts come from the manual.
  model.queueAnswer({ match: 'Was kannst du', toolCalls: [{ name: 'load_skill', arguments: { name: 'snotra-capabilities' } }] });
  model.queueAnswer({ toolCalls: [{ name: 'read_manual_page', arguments: { slug: 'reference/capabilities' } }] });
  model.queueAnswer({ text: 'Einiges.' });
  await sendChat(page, 'Was kannst du eigentlich alles?');
  const overview = await poll(() => {
    const results = toolResults();
    const skill = results.find((result) => result.skill === 'snotra-capabilities');
    const read = results.find((result) => result.slug === 'reference/capabilities');
    return skill && read ? { skill, read } : null;
  }, {
    what: 'the skill and the overview page sent back to the model',
    timeoutMs: 30000,
    explain: async () => `${JSON.stringify(model.describeRequests(), null, 1)}\nmain:\n${snotra.mainOutput()}`,
  });
  assert.match(JSON.stringify(overview.skill), /reference\/capabilities/);
  assert.equal(overview.read.locale, 'de');
  assert.match(overview.read.markdown, /Was es nicht kann/);

  // The link in the answer opens the help window on that page, not the browser.
  const opened = app.waitForEvent('window');
  await page.evaluate(() => document.querySelector('#chat-messages a[href^="https://docs.snotra-ai.dev/"]').click());
  const help = await opened;
  await poll(() => help.evaluate(() => document.querySelector('.manual-nav [aria-current="page"]')?.dataset.page === 'safety/sandbox'), {
    what: 'the help window on the sandbox page',
    explain: async () => help.evaluate(() => document.querySelector('.manual-nav [aria-current="page"]')?.dataset.page ?? 'none'),
  });
});
