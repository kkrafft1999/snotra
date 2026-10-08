// Image generation in the running app (#85): without an OpenAI key the model
// is not offered the tool; with one, an approved call sends the prompt to the
// Images API — answered inside the app, nothing reaches OpenAI — and the image
// lands in the workspace. A refused prompt writes nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, rendererToolEvents } from './helpers/app.mjs';
import { routeOpenAiImages, landscapePng } from './helpers/fake-images.mjs';

const toolNamesOf = (request) => (request?.body?.tools || []).map((tool) => tool.function?.name);

async function send(page, text) {
  await page.evaluate((value) => {
    const input = document.getElementById('chat-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, text);
}

/**
 * Approves every card as it asks, until the run is through. An idle send button
 * alone does not prove that: right after send() the run may not have started
 * yet (#801), so the run only counts as through once the model has received
 * the request of its last turn.
 */
async function approveUntilDone(page, what, evidence, lastTurn) {
  await poll(async () => {
    await page.evaluate(() => {
      document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])')?.click();
    });
    if (!lastTurn()) return false;
    return page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop'));
  }, { what, timeoutMs: 45000, explain: evidence });
}

test('generate_image draws through the Images API into the workspace', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-image-');
  const userDataDir = await makeTempDir('snotra-image-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Site\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  const configPath = path.join(userDataDir, 'llm-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  // An OpenAI key is stored with an OpenAI entry; the fake model stays active.
  config.presets.push({ id: 'gpt5', providerId: 'openai', model: 'gpt-5-mini', menuVisible: true });
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page, app } = snotra;
  const evidence = async () => [
    `model requests: ${JSON.stringify(model.describeRequests(), null, 1)}`,
    `answers not taken: ${JSON.stringify(model.pendingAnswers())}`,
    `renderer tool events: ${await rendererToolEvents(page)}`,
    `main:\n${snotra.mainOutput()}`,
  ].join('\n');

  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });

  // Without a key the tool is not offered at all.
  model.queueAnswer({ match: 'Without a key', text: 'No image tool here.' });
  await send(page, 'Without a key: can you draw?');
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'first answer', explain: evidence });
  assert.equal(toolNamesOf(model.requestFor('Without a key')).includes('generate_image'), false);

  const { encryptionAvailable } = await page.evaluate(() => window.electronAPI.getLLMState());
  if (!encryptionAvailable) {
    t.skip('no encrypted storage here (a Linux runner without a keyring): no OpenAI key to draw with');
    return;
  }
  const saved = await page.evaluate(({ rows, active }) => window.electronAPI.commitSettings({
    presets: rows,
    activePresetId: active,
    providerPatches: { openai: { apiKey: 'sk-e2e-never-sent' } },
  }), { rows: config.presets, active: config.presets[0].id });
  assert.equal(saved?.ok, true, `settings saved: ${JSON.stringify(saved)}`);
  const state = await page.evaluate(() => window.electronAPI.getImageGenerationState());
  assert.equal(state.hasApiKey, true);
  assert.equal(state.model, 'gpt-image-2.5-flare');

  const image = landscapePng(96, 64);
  const images = await routeOpenAiImages(app, { image });

  model.queueAnswer({
    match: 'Draw a header',
    toolCalls: [{
      name: 'generate_image',
      arguments: { prompt: 'A calm landscape at dusk.', relative_path: 'assets/header.png', size: '1536x1024', quality: 'low' },
    }],
  });
  model.queueAnswer({ match: 'bytes_written', text: 'The image is at assets/header.png.' });
  await send(page, 'Draw a header image.');
  await approveUntilDone(page, 'image run through', evidence, () => model.requestFor('bytes_written'));

  assert.ok(toolNamesOf(model.requestFor('Draw a header')).includes('generate_image'), 'offered with a key');
  const sent = await images.requests();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].auth, 'Bearer sk-e2e-never-sent');
  assert.deepEqual(sent[0].body, {
    model: 'gpt-image-2.5-flare',
    prompt: 'A calm landscape at dusk.',
    n: 1,
    size: '1536x1024',
    quality: 'low',
    output_format: 'png',
  });
  assert.deepEqual(await readFile(path.join(workspace, 'assets/header.png')), image);

  // What went back to the model: the path and the size, not the image.
  const followUp = JSON.stringify(model.requestFor('bytes_written')?.body ?? {});
  assert.match(followUp, /\\"width\\":96/);
  assert.doesNotMatch(followUp, new RegExp(image.toString('base64').slice(0, 40).replace(/[+/]/g, '\\$&')));

  const lines = await page.evaluate(() =>
    [...document.querySelectorAll('.chat-tool-line')].map((line) => line.textContent));
  assert.ok(lines.some((line) => line.includes('Image assets/header.png generated')), `tool lines: ${lines}`);
  await poll(() => page.evaluate(() =>
    [...document.querySelectorAll('#tree-container .tree-item')].some((item) => item.textContent.includes('assets'))),
  { what: 'assets folder in the tree' });

  // The image stands under the line of changed files, and again after a reload:
  // the card comes from the stored tool trace, the bytes from the workspace.
  const card = () => page.evaluate(() => {
    const img = document.querySelector('.chat-images button.chat-image-open img.chat-md-image-img');
    return img ? {
      src: img.getAttribute('src').slice(0, 22),
      caption: document.querySelector('.chat-image-caption')?.textContent ?? '',
      afterChanges: document.querySelector('.chat-images')?.previousElementSibling?.className ?? '',
    } : null;
  });
  await poll(card, { what: 'generated image in the chat', explain: evidence });
  assert.deepEqual(await card(), {
    src: 'data:image/png;base64,',
    caption: 'assets/header.png·96 × 64 · PNG',
    afterChanges: 'chat-changes',
  });
  await page.reload();
  await poll(card, { what: 'generated image after a reload', explain: evidence });

  // A refused prompt is an error for the model, and nothing is written.
  await images.update({ status: 400, error: { error: { message: 'Rejected by the safety system.', code: 'moderation_blocked' } } });
  model.queueAnswer({
    match: 'Draw something refused',
    toolCalls: [{ name: 'generate_image', arguments: { prompt: 'refused', relative_path: 'assets/refused.png' } }],
  });
  model.queueAnswer({ match: 'refused to draw', text: 'OpenAI refused that one.' });
  await send(page, 'Draw something refused.');
  await approveUntilDone(page, 'refused run through', evidence, () => model.requestFor('refused to draw'));
  assert.equal((await images.requests()).length, 2);
  assert.match(JSON.stringify(model.requestFor('refused to draw')?.body ?? {}), /Rejected by the safety system/,
    'the refusal reached the model in its own words');
  await assert.rejects(access(path.join(workspace, 'assets/refused.png')));
});
