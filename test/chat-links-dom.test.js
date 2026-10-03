// Der Klick-Handler fuer Links in Modellantworten am echten DOM (Issue #78).
//
// test/open-chat-link.test.js prueft die Entscheidung ohne DOM ("darf dieser
// href geoeffnet werden?"), test/renderer-link-styles.test.js das Stylesheet
// per Regex. Ungeprueft war die Verdrahtung dazwischen: dass der Chat-Container
// den Klick ueberhaupt abfaengt, das Standardverhalten unterbindet und einen
// Fehlschlag sichtbar meldet (#82, #83).
//
// Bewusst NICHT hier: das Sanitizing selbst. DOMPurify laeuft unter happy-dom
// nicht korrekt (siehe Kommentar in test/helpers/dom.js), ein gruener Test waere
// hier also wertlos. Die Markup-Ebene bleibt beim Regex-Test, den echten
// Sanitizer deckt erst ein Lauf in Chromium ab.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

let harness = null;
/** Pro Test austauschbar, damit auch ein Fehlschlag von openExternal pruefbar ist. */
let openExternalImpl = async () => ({ ok: true });
/** The same for a link to an HTML file of the workspace (#479). */
let openWorkspaceImpl = async () => ({ ok: true });

async function getHarness() {
  if (harness) return harness;
  const dom = setupRendererDom();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');

  const opened = [];
  const workspaceOpens = [];
  const api = {
    openExternal: async (href) => { opened.push(href); return openExternalImpl(href); },
    onChatDelta: () => {},
    onChatProgress: () => {},
    onChatToolLine: () => {},
    getChatHistory: async () => ({ sessions: [] }),
    setActiveChatId: async () => {},
    upsertChatSession: async () => ({ ok: true }),
    generateChatTitle: async () => ({ title: '' }),
    writeClipboardText: async () => ({ ok: true }),
    abortChat: async () => ({ ok: true }),
    chat: async () => ({ ok: true }),
  };

  const chat = initChatStream({
    api,
    appStore,
    onInputChanged() {},
    stopChatVoiceListening() {},
    activeProviderConfigured: () => true,
    syncLiveDot() {},
    syncChatTitle() {},
    onWorkspaceFileWritten() {},
    approvalCards: { mount() {}, beginRun() {}, reset() {} },
    openWorkspaceFile: async (path, options) => {
      workspaceOpens.push({ path, options });
      return openWorkspaceImpl(path);
    },
  });

  harness = {
    opened,
    workspaceOpens,
    appStore,
    /**
     * Zeigt eine Antwort mit Links an. Das Markup ist das, was DOMPurify in der
     * App nach markdownToSafeHtml() stehen laesst — inklusive target/rel und
     * ohne href, wo der Sanitizer ihn entfernt hat.
     */
    showAnswer(innerHtml) {
      appStore.chatMessages = [{ role: 'assistant', content: 'Antwort' }];
      chat.renderChatMessages();
      document.querySelector('#chat-messages .chat-msg.assistant .chat-md').innerHTML = innerHtml;
    },
    reset() {
      opened.length = 0;
      workspaceOpens.length = 0;
      openExternalImpl = async () => ({ ok: true });
      openWorkspaceImpl = async () => ({ ok: true });
      appStore.rootPath = '/ws';
      appStore.chatMessages = [];
      appStore.chatTokenUsage = { prompt: 0, completion: 0, total: 0 };
      chat.renderChatMessages();
    },
    cleanup() { dom.cleanup(); },
  };
  return harness;
}

test.after(() => harness?.cleanup());
test.beforeEach(async () => { (await getHarness()).reset(); });

const sanitizedLink = (href, text) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

const linkIn = (text) => [...document.querySelectorAll('#chat-messages a')]
  .find((a) => a.textContent.includes(text));

const clickOn = (link) => {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  return event;
};

test('ein Klick auf einen Link aus der Antwort geht an den Main-Prozess', async () => {
  const chat = await getHarness();
  chat.showAnswer(`Siehe ${sanitizedLink('https://example.com/docs', 'die Doku')}.`);

  const event = clickOn(linkIn('die Doku'));
  await flush();

  assert.deepEqual(chat.opened, ['https://example.com/docs']);
  // Ohne preventDefault wuerde Electron die Seite im App-Fenster selbst oeffnen.
  assert.equal(event.defaultPrevented, true);
});

test('a middle click on a link takes the same way, with feedback (#595)', async () => {
  const chat = await getHarness();
  chat.showAnswer(`Siehe ${sanitizedLink('https://example.com/docs', 'die Doku')}.`);

  const event = new window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
  linkIn('die Doku').dispatchEvent(event);
  await flush();

  assert.deepEqual(chat.opened, ['https://example.com/docs']);
  // Without it, the window-open handler would take it, where a failure reaches nobody.
  assert.equal(event.defaultPrevented, true);
});

test('auch ein Klick auf Text innerhalb des Links zaehlt', async () => {
  const chat = await getHarness();
  chat.showAnswer(sanitizedLink('https://example.com', '<strong>fett</strong> verlinkt'));

  clickOn(document.querySelector('#chat-messages a strong'));
  await flush();

  assert.deepEqual(chat.opened, ['https://example.com']);
});

test('ein mailto-Link geht denselben Weg', async () => {
  const chat = await getHarness();
  chat.showAnswer(sanitizedLink('mailto:info@example.com', 'Mail'));

  clickOn(linkIn('Mail'));
  await flush();

  assert.deepEqual(chat.opened, ['mailto:info@example.com']);
});

test('was der Sanitizer nicht durchlaesst, ist auch nicht klickbar', async () => {
  const chat = await getHarness();
  // So sieht es nach dem Sanitizer aus: der Text bleibt, der href ist weg.
  chat.showAnswer(
    '<a target="_blank" rel="noopener noreferrer">Skript</a>' +
    sanitizedLink('file:///etc/passwd', 'lokal')
  );

  for (const text of ['Skript', 'lokal']) {
    assert.equal(clickOn(linkIn(text)).defaultPrevented, false, `${text} haette liegenbleiben muessen`);
  }
  await flush();

  assert.deepEqual(chat.opened, []);
});

test('scheitert das Oeffnen, sagt es die Statuszeile statt still zu bleiben', async () => {
  const chat = await getHarness();
  openExternalImpl = async () => ({ ok: false, error: 'Kein Standardbrowser gefunden.' });

  chat.showAnswer(sanitizedLink('https://example.com', 'Doku'));
  clickOn(linkIn('Doku'));
  await flush();

  // Der Hinweis steht in der Textzelle der Token-Anzeige — seit Issue #174
  // ist die Anzeige selbst ein Schalter mit Aufschlüsselung.
  assert.equal(
    document.getElementById('chat-token-usage-value').textContent,
    'Kein Standardbrowser gefunden.'
  );
});

test('wirft der Main-Prozess, bleibt der Klick trotzdem beantwortet', async () => {
  const chat = await getHarness();
  openExternalImpl = async () => { throw new Error('IPC weg'); };

  chat.showAnswer(sanitizedLink('https://example.com', 'Doku'));
  clickOn(linkIn('Doku'));
  await flush();

  assert.equal(document.getElementById('chat-token-usage-value').textContent, 'IPC weg');
});

// ── Links to HTML files of the workspace (#479) ───────────────────────────
// What the sanitizer leaves of `[Bericht](out/report.html)` in a chat answer:
// the path in `data-workspace-href`, `#` as the address.
const htmlLink = (target, text) =>
  `<a href="#" rel="noopener noreferrer" data-workspace-href="${target}">${text}</a>`;

test('a link to an HTML file opens it in the preview, not in the browser', async () => {
  const chat = await getHarness();
  chat.showAnswer(`Siehe ${htmlLink('out/report.html#summary', 'Bericht')} und ${htmlLink('/ws/index.htm', 'Start')}.`);

  const event = clickOn(linkIn('Bericht'));
  clickOn(linkIn('Start'));
  await flush();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(chat.workspaceOpens, [
    { path: '/ws/out/report.html', options: { fragment: 'summary' } },
    { path: '/ws/index.htm', options: { fragment: '' } },
  ]);
  assert.deepEqual(chat.opened, [], 'nothing went to the browser');
});

test('a middle click on it takes the same way', async () => {
  const chat = await getHarness();
  chat.showAnswer(htmlLink('report.html', 'Bericht'));
  const event = new window.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
  linkIn('Bericht').dispatchEvent(event);
  await flush();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(chat.workspaceOpens.map((entry) => entry.path), ['/ws/report.html']);
});

test('one outside the folder, or not there, says so in the status line', async () => {
  const chat = await getHarness();
  openWorkspaceImpl = async (path) => ({ ok: false, reason: path.startsWith('/ws/') ? 'not-found' : 'outside' });
  chat.showAnswer(`${htmlLink('../other/x.html', 'Draussen')} ${htmlLink('gone.html', 'Weg')}`);

  clickOn(linkIn('Draussen'));
  await flush();
  assert.equal(document.getElementById('chat-token-usage-value').textContent, '../other/x.html is outside the open folder.');

  clickOn(linkIn('Weg'));
  await flush();
  assert.equal(document.getElementById('chat-token-usage-value').textContent, 'gone.html does not exist in the open folder.');
});
