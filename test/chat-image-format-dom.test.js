// The composer refuses an image format the active provider does not take
// (#91): a GIF pasted while Gemini is active becomes a note, not a chip.
//
// On the limits of the stack (no layout, no sanitizing) see test/helpers/dom.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const GEMINI = { mediaTypes: ['image/png', 'image/jpeg', 'image/webp'], provider: 'Google (Gemini)' };

let harness = null;

async function getHarness() {
  if (harness) return harness;
  const dom = setupRendererDom();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');

  const api = {
    onChatDelta: () => {},
    onChatProgress: () => {},
    onChatToolLine: () => {},
    getChatHistory: async () => ({ sessions: [] }),
    setActiveChatId: async () => {},
    upsertChatSession: async () => ({ ok: true }),
    nameChat: async () => ({ title: null }),
    writeClipboardText: async () => ({ ok: true }),
    abortChat: async () => ({ ok: true }),
    chat: async () => ({ ok: true }),
  };

  initChatStream({
    api,
    appStore,
    onInputChanged() {},
    stopChatVoiceListening() {},
    activeProviderConfigured: () => true,
    activeProviderSupportsImages: () => true,
    activeImageFormats: () => GEMINI,
    syncLiveDot() {},
    syncChatTitle() {},
    onWorkspaceFileWritten() {},
    approvalCards: { mount() {}, beginRun() {}, reset() {} },
  });

  harness = { cleanup() { dom.cleanup(); } };
  return harness;
}

test.after(() => harness?.cleanup());

/** A paste of the given files, as the clipboard hands a copied image file over. */
function paste(files) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: files.map((file) => ({ kind: 'file', getAsFile: () => file })) },
  });
  document.getElementById('chat-input').dispatchEvent(event);
  return event;
}

test('a GIF pasted while Gemini is active is refused with a note that names what works', async () => {
  await getHarness();
  const gif = new window.File([new Uint8Array([71, 73, 70, 56, 57, 97])], 'wave.gif', { type: 'image/gif' });

  const event = paste([gif]);
  await flush();

  assert.equal(event.defaultPrevented, true, 'the clipboard image does not land in the text field');
  assert.equal(document.querySelectorAll('#chat-attachments li').length, 0, 'no chip for the refused image');
  assert.equal(
    document.getElementById('chat-token-usage-value').textContent,
    'Google (Gemini) does not take GIF images — PNG, JPEG, WebP work.',
  );
});
