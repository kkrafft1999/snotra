// Look instead of trust (#1317): "Distil into knowledge…" in the real chat
// header — in an empty chat, ready, with keyboard focus, while an answer is on
// its way, and icon-only in a narrow panel. Also measures how much room the
// chat title keeps beside the labelled button (the numbers behind
// DISTIL_MIN_TITLE_ROOM_PX), and where the icon-only form takes over.
// Not a test — a look.
//
//   node e2e/manual-distil-action.mjs [en|de]
//
//   out/mockup/distil-action-<locale>-<state>-<theme>.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const QUESTION = locale === 'de' ? 'Welche Beete bekommen die Bohnen?' : 'Which beds get the beans?';
// Wide enough for the label in each language (German needs about 620 px).
const WIDE = locale === 'de' ? 660 : 600;

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-distil-look-');
const userDataDir = await makeTempDir('snotra-distil-look-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Garden\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const setWidth = (width) => page.evaluate((w) => { document.getElementById('chat-panel').style.width = `${w}px`; }, width);
const settle = () => new Promise((r) => setTimeout(r, 250));
const describe = () => page.evaluate(() => {
  const b = document.getElementById('btn-chat-distil');
  return {
    state: b.dataset.state,
    ariaDisabled: b.getAttribute('aria-disabled'),
    compact: b.classList.contains('chat-distil--compact'),
    title: b.title.replace(/\n/g, ' | '),
    description: document.getElementById('chat-distil-reason').textContent,
    width: Math.round(b.getBoundingClientRect().width),
    chatTitle: document.getElementById('chat-title').textContent,
    titleWidth: Math.round(document.getElementById('chat-title').getBoundingClientRect().width),
  };
});

async function shoot(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await settle();
    const box = await page.locator('#chat-panel').boundingBox();
    await page.screenshot({
      path: path.join(SHOTS, `distil-action-${locale}-${name}-${theme}.png`),
      clip: { x: box.x, y: box.y, width: box.width, height: 150 },
    });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  console.log(name.padEnd(14), JSON.stringify(await describe()));
}

try {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0), { what: 'drawn tree' });
  await setWidth(WIDE);
  await shoot('empty');

  model.queueAnswer({ match: QUESTION, text: locale === 'de' ? 'Das Nordbeet bekommt Buschbohnen.' : 'The north bed gets bush beans.' });
  await sendChat(page, QUESTION);
  await poll(() => page.evaluate(() => document.getElementById('btn-chat-distil').dataset.state === 'ready'), { what: 'ready' });
  // A title the length a real one has.
  await page.evaluate((text) => { document.getElementById('chat-title').textContent = text; },
    locale === 'de' ? 'Bohnen in den Beeten' : 'Beans in the beds');
  await shoot('ready');
  await page.locator('#btn-chat-distil').hover();
  await shoot('hover');
  await page.mouse.move(0, 0);
  await page.keyboard.press('Shift');
  await page.evaluate(() => document.getElementById('btn-chat-distil').focus());
  await shoot('focus');
  await page.evaluate(() => document.activeElement.blur());

  // Narrow: the default panel width.
  await setWidth(320);
  await shoot('compact');
  await page.keyboard.press('Shift');
  await page.evaluate(() => document.getElementById('btn-chat-distil').focus());
  await shoot('compact-focus');
  await page.evaluate(() => document.activeElement.blur());
  await setWidth(WIDE);

  // How much room the title keeps beside the labelled button, by panel width.
  const rows = await page.evaluate(async () => {
    // The CSP keeps <style> elements out; an adopted sheet is allowed.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.chat-distil.chat-distil--compact{width:auto!important;padding:0 12px 0 10px!important}'
      + '.chat-distil--compact .chat-distil-label{position:static!important;width:auto!important;height:auto!important;margin:0!important;clip:auto!important}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const title = document.getElementById('chat-title');
    const before = title.textContent;
    title.textContent = 'A rather long chat title that never fits anywhere';
    const out = [];
    for (let w = 300; w <= 720; w += 20) {
      document.getElementById('chat-panel').style.width = `${w}px`;
      await new Promise((r) => requestAnimationFrame(() => r()));
      out.push([w, Math.round(title.getBoundingClientRect().width),
        Math.round(document.getElementById('btn-chat-distil').getBoundingClientRect().width),
        Math.round(document.getElementById('btn-chat-kind').getBoundingClientRect().width)]);
    }
    title.textContent = before;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    return out;
  });
  console.log('panel width → title room, labelled button, kind pill');
  for (const row of rows) console.log(`  ${row.join('\t')}`);
  const forms = await page.evaluate(async () => {
    const out = [];
    for (let w = 300; w <= 720; w += 20) {
      document.getElementById('chat-panel').style.width = `${w}px`;
      await new Promise((r) => setTimeout(r, 60));
      out.push(`${w}:${document.getElementById('btn-chat-distil').classList.contains('chat-distil--compact') ? 'icon' : 'label'}`);
    }
    return out.join(' ');
  });
  console.log('form by panel width:', forms);
  await setWidth(WIDE);

  // While an answer is on its way.
  let release;
  model.queueAnswer({ match: 'second', text: 'Still writing.', holdUntil: new Promise((r) => { release = r; }) });
  await sendChat(page, locale === 'de' ? 'Und die second Frage?' : 'And the second question?');
  await poll(() => page.evaluate(() => document.getElementById('btn-chat-distil').dataset.state === 'running'), { what: 'running' });
  await page.evaluate((text) => { document.getElementById('chat-title').textContent = text; },
    locale === 'de' ? 'Bohnen in den Beeten' : 'Beans in the beds');
  await shoot('running');
  release();
  await poll(() => page.evaluate(() => document.getElementById('btn-chat-distil').dataset.state === 'ready'), { what: 'ready again' });
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
