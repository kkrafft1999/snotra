// The chat looks things up in Snotra's own manual (#947): in the real app the
// model gets search_manual and read_manual_page, both answer from the manual
// that ships with the app in the language of the interface, and the tool log
// names the step a look into the manual rather than a file read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

test('a question about Snotra is answered from the bundled manual', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-manual-tools-');
  const userDataDir = await makeTempDir('snotra-manual-tools-userdata-');
  const home = await makeTempDir('snotra-manual-tools-home-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'de' }), 'utf8');

  const snotra = await launchApp({ userDataDir, home });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;

  model.queueAnswer({ match: 'Netzwerkzugriff', toolCalls: [{ name: 'search_manual', arguments: { query: 'Sandbox Host' } }] });
  model.queueAnswer({ toolCalls: [{ name: 'read_manual_page', arguments: { slug: 'safety/sandbox' } }] });
  model.queueAnswer({ text: 'Siehe https://docs.snotra-ai.dev/de/safety/sandbox/' });
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
});
