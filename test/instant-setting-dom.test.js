// Settings that save on change (#297): saves run one after another, and a
// control never shows a landed save as undone (CR-B14-09, item 2). Flipped on
// and off quickly, with the first save landing and the second failing, the
// switch used to go back to the value before both and say "Not saved" while
// the store held "on".

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer } = require('./helpers/dom.js');

const MARKUP = `<!doctype html><html><body>
  <input type="checkbox" role="switch" id="switch">
  <span id="status" role="status"></span>
  <div id="choice" role="radiogroup">
    <input type="radio" name="c" value="light" checked>
    <input type="radio" name="c" value="dark">
  </div>
  <span id="choice-status" role="status"></span>
</body></html>`;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A save whose answers the test hands out one by one. */
function scriptedSave() {
  const calls = [];
  const save = (value) => new Promise((resolve) => calls.push({ value, resolve }));
  return { calls, save };
}

async function mount() {
  const dom = setupRendererDom({ markup: MARKUP });
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  const { bindInstantSwitch, bindInstantChoice } = await importRenderer('components', 'InstantSetting.js');
  const doc = dom.document;
  const input = doc.getElementById('switch');
  const flip = (on) => {
    input.checked = on;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, doc, input, flip, bindInstantSwitch, bindInstantChoice, cleanup: () => dom.cleanup() };
}

test('on, then off quickly: the first save lands, the second fails — the switch shows "on", what is stored', async (t) => {
  const ui = await mount();
  t.after(ui.cleanup);
  const { calls, save } = scriptedSave();
  ui.bindInstantSwitch(ui.input, ui.doc.getElementById('status'), save);

  ui.flip(true);
  ui.flip(false);
  await flush();
  assert.deepEqual(calls.map((call) => call.value), [true], 'one save at a time');

  calls[0].resolve(true);
  await flush();
  assert.deepEqual(calls.map((call) => call.value), [true, false], 'the second runs once the first is done');
  assert.equal(ui.input.checked, false, 'the newer change is still on screen');
  assert.equal(ui.doc.getElementById('status').textContent, '', 'only the latest change speaks');

  calls[1].resolve(false);
  await flush();
  assert.equal(ui.input.checked, true, 'back to what the store holds, not to the value before both');
  assert.equal(ui.doc.getElementById('status').textContent, 'Not saved');
});

test('both saves land: the store ends at the last value, in order', async (t) => {
  const ui = await mount();
  t.after(ui.cleanup);
  const { calls, save } = scriptedSave();
  ui.bindInstantSwitch(ui.input, ui.doc.getElementById('status'), save);
  ui.flip(true);
  ui.flip(false);
  await flush();
  calls[0].resolve(true);
  await flush();
  calls[1].resolve(true);
  await flush();
  assert.deepEqual(calls.map((call) => call.value), [true, false]);
  assert.equal(ui.input.checked, false);
  assert.equal(ui.doc.getElementById('status').textContent, 'Saved');
});

test('the first save fails, the second lands: the second value stands; a thrown save counts as failed', async (t) => {
  const ui = await mount();
  t.after(ui.cleanup);
  const { calls, save } = scriptedSave();
  ui.bindInstantSwitch(ui.input, ui.doc.getElementById('status'), save);
  ui.flip(true);
  ui.flip(false);
  await flush();
  calls[0].resolve(false);
  await flush();
  calls[1].resolve(true);
  await flush();
  assert.equal(ui.input.checked, false);
  assert.equal(ui.doc.getElementById('status').textContent, 'Saved');

  // A save that throws neither stalls the queue nor leaves the control wrong.
  const choiceCalls = [];
  const choice = ui.bindInstantChoice(ui.doc.getElementById('choice'), ui.doc.getElementById('choice-status'), async (value) => {
    choiceCalls.push(value);
    if (value === 'dark') throw new Error('disk full');
    return true;
  });
  const dark = ui.doc.querySelector('input[value="dark"]');
  dark.checked = true;
  dark.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.equal(choice.get(), 'light');
  assert.equal(ui.doc.getElementById('choice-status').textContent, 'Not saved');
  dark.checked = true;
  dark.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(choiceCalls, ['dark', 'dark'], 'the queue still runs');
});
