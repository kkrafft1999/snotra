// Look instead of trust: starts the real app with an answer the model cuts off
// at its output limit, and takes screenshots of how the chat shows it (#538).
// Not a test — a look.
//
//   node e2e/manual-cut-off.mjs
//
// Result: out/mockup/cut-off-{de,en}-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const QUESTION = 'Fasse bitte die Projektdokumentation zusammen.';
const ANSWER = 'Die Dokumentation beschreibt drei Teile: die Architektur mit ihren Schichten, '
  + 'das Sicherheitskonzept mit den Freigaben im Chat und den Ablauf eines Releases. Zur Architektur '
  + 'gehört vor allem die Trennung zwischen';

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-cut-off-');
const userDataDir = await makeTempDir('snotra-cut-off-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Beispielprojekt\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

async function setLocale(locale) {
  await page.evaluate(async (value) => {
    await window.electronAPI.setUIPrefs({ appLocale: value });
  }, locale);
}

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'gezeichneter Baum' });

  for (const locale of ['de', 'en']) {
    await setLocale(locale);
    await page.reload();
    await poll(() => page.evaluate(() => !!document.getElementById('chat-input')), { what: 'Chat bereit' });
    await page.evaluate(() => document.getElementById('btn-chat-new').click());
    await page.waitForTimeout(300);

    model.queueAnswer({ match: QUESTION, text: ANSWER, finishReason: 'length' });
    await page.evaluate((text) => {
      const input = document.getElementById('chat-input');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-chat-send').click();
    }, QUESTION);
    await poll(() => page.evaluate(() => !!document.querySelector('#chat-messages .chat-msg.assistant.error')),
      { what: 'Hinweis zum Abschneiden' });
    await page.waitForTimeout(300);

    const state = await page.evaluate(() => [...document.querySelectorAll('#chat-messages .chat-msg')]
      .map((li) => `${li.className.replace('chat-msg ', '')}: ${li.textContent.replace(/\s+/g, ' ').trim().slice(0, 90)}`));
    console.log(locale, JSON.stringify(state, null, 2));

    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
      }, theme);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(SHOTS, `cut-off-${locale}-${theme}.png`) });
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  }
} finally {
  await snotra.stop();
  await model.close();
}
