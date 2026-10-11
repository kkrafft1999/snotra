// Live voice input in the running app (#859): a speech-like WAV stands in for
// the microphone, a local server plays OpenAI's realtime transcription, and
// the transcript has to appear in the input field while the "speaker" talks —
// grey and slanted, drawn by a mirror that lines up with the textarea — and
// settle into plain text at the stop. Nothing reaches OpenAI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat } from './helpers/app.mjs';
import { startFakeRealtime, routeRealtime, feedMicrophone, speechLikeWav } from './helpers/fake-realtime.mjs';

async function launchWithMicrophone(t, realtimeOptions) {
  const model = await startFakeModel();
  const realtime = await startFakeRealtime(realtimeOptions);
  const workspace = await makeTempDir('snotra-voice-');
  const userDataDir = await makeTempDir('snotra-voice-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Voice\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  // An OpenAI key is stored with an OpenAI entry; the fake model stays active.
  const configPath = path.join(userDataDir, 'llm-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.presets.push({ id: 'gpt5', providerId: 'openai', model: 'gpt-5-mini', menuVisible: true });
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await realtime.close();
    await model.close();
  });
  const { page, app } = snotra;
  await routeRealtime(app, realtime.port);
  await feedMicrophone(page, speechLikeWav({ sampleRate: 24000 }));
  const evidence = async () => [
    `realtime events: ${JSON.stringify(realtime.connections.map((c) => c.events.map((e) => e.type)))}`,
    `status: ${await page.evaluate(() => document.getElementById('chat-voice-status').textContent)}`,
    `input: ${await page.evaluate(() => document.getElementById('chat-input').value)}`,
    `main:\n${snotra.mainOutput()}`,
  ].join('\n');
  return { page, app, realtime, userDataDir, evidence };
}

async function storeOpenAiKey(page, userDataDir) {
  const { encryptionAvailable } = await page.evaluate(() => window.electronAPI.getLLMState());
  if (!encryptionAvailable) return false;
  const config = JSON.parse(await readFile(path.join(userDataDir, 'llm-config.json'), 'utf8'));
  const saved = await page.evaluate(({ rows, active }) => window.electronAPI.commitSettings({
    presets: rows,
    activePresetId: active,
    providerPatches: { openai: { apiKey: 'sk-e2e-never-sent' } },
  }), { rows: config.presets, active: config.presets[0].id });
  assert.equal(saved?.ok, true, `settings saved: ${JSON.stringify(saved)}`);
  return true;
}

/** Edit › Voice Input — the item behind Cmd/Ctrl+D. */
async function pressVoiceShortcut(app) {
  await app.evaluate(({ Menu }) => {
    const find = (items) => {
      for (const item of items) {
        if (item.accelerator === 'CmdOrCtrl+D') return item;
        const inner = item.submenu && find(item.submenu.items);
        if (inner) return inner;
      }
      return null;
    };
    find(Menu.getApplicationMenu().items).click();
  });
}

const fieldState = (page) => page.evaluate(() => {
  const input = document.getElementById('chat-input');
  const mirror = document.getElementById('chat-input-mirror');
  const span = mirror.querySelector('.chat-dictation');
  return {
    value: input.value,
    dictating: document.getElementById('chat-input-field').dataset.dictating === 'true',
    pressed: document.getElementById('btn-chat-mic').getAttribute('aria-pressed'),
    dictation: span?.textContent ?? null,
    inputColor: getComputedStyle(input).color,
    spanStyle: span ? getComputedStyle(span).fontStyle : null,
    // The mirror breaks its lines where the textarea does.
    heights: [input.scrollHeight, mirror.scrollHeight],
    pillsShown: getComputedStyle(document.getElementById('chat-composer-pills')).display !== 'none',
  };
});

test('the transcript appears while speaking, grey and slanted, and settles at the stop', { timeout: 180000 }, async (t) => {
  const { page, app, realtime, userDataDir, evidence } = await launchWithMicrophone(t);
  if (!await storeOpenAiKey(page, userDataDir)) {
    t.skip('no encrypted storage here (a Linux runner without a keyring): no OpenAI key to dictate with');
    return;
  }
  // The folder's chat empties the composer when it arrives; on the macOS
  // runner that was after "Note:" had been written (#869).
  await waitForFolderChat(page, { explain: evidence });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Note:';
    input.setSelectionRange(5, 5);
  });

  await pressVoiceShortcut(app);
  await poll(async () => (await fieldState(page)).dictation?.includes('kannst du'), {
    what: 'first words in the field while speaking', timeoutMs: 20000, explain: evidence,
  });
  const live = await fieldState(page);
  assert.equal(live.dictating, true);
  assert.equal(live.pressed, 'true');
  assert.match(live.value, /^Note: kannst du/);
  assert.equal(live.inputColor, 'rgba(0, 0, 0, 0)', 'the textarea draws no text of its own');
  assert.equal(live.spanStyle, 'italic');
  assert.equal(live.heights[0], live.heights[1]);
  assert.equal(live.pillsShown, false);

  const [connection] = realtime.connections;
  assert.equal(connection.auth, 'Bearer sk-e2e-never-sent');
  assert.equal(connection.url, '/v1/realtime?intent=transcription');
  assert.equal(connection.events[0].session.audio.input.transcription.model, 'gpt-live-transcribe');

  // The pause in the WAV ends the turn: it settles while recording goes on.
  await poll(async () => (await fieldState(page)).value.includes('Kannst du die readme kürzen.'), {
    what: 'first sentence settled at the pause', timeoutMs: 20000, explain: evidence,
  });
  await poll(async () => /\. und/.test((await fieldState(page)).value), {
    what: 'second sentence growing after the first', timeoutMs: 20000, explain: evidence,
  });
  if (process.env.SNOTRA_VOICE_SHOT) await page.locator('#chat-input-row').screenshot({ path: process.env.SNOTRA_VOICE_SHOT });

  await page.click('#btn-chat-mic');
  await poll(async () => !(await fieldState(page)).dictating, { what: 'dictation over', explain: evidence });
  const done = await fieldState(page);
  assert.match(done.value, /^Note: Kannst du die readme kürzen\. Und die screenshots neu machen\./);
  assert.equal(done.dictation, null);
  assert.notEqual(done.inputColor, 'rgba(0, 0, 0, 0)');
  assert.equal(done.pillsShown, true);
  assert.equal(done.pressed, 'false');
  await poll(() => connection.closed, { what: 'connection closed after the stop' });
});
