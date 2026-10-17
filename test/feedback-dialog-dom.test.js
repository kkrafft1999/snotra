// The feedback form on the real index.html (#1045): its states, what it
// hands to main, and the way round the endpoint when sending fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const DIAG = { appVersion: '1.25.0', os: 'macOS 15.1', arch: 'arm64', provider: 'openai' };
const ISSUE = 'https://github.com/kkrafft1999/snotra/issues/1200';

async function mount({ api: overrides = {}, locale = 'en' } = {}) {
  const dom = setupRendererDom();
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale, { force: true });
  const { initFeedbackDialog } = await importRenderer('components', 'FeedbackDialog.js');
  const calls = { sent: [], opened: [], copied: [], diagnosticsFor: [] };
  let pushOpen = () => {};
  const api = {
    getFeedbackDiagnostics: async (providerId) => { calls.diagnosticsFor.push(providerId); return DIAG; },
    sendFeedback: async (payload) => { calls.sent.push(payload); return { ok: true, issueUrl: ISSUE }; },
    openExternal: async (url) => { calls.opened.push(url); },
    writeClipboardText: async (text) => { calls.copied.push(text); return { ok: true }; },
    onOpenFeedback: (cb) => { pushOpen = cb; },
    ...overrides,
  };
  const appStore = { llmState: { activeProvider: 'anthropic', chatTarget: { providerId: 'openai' } } };
  const dialog = initFeedbackDialog({ api, appStore });
  const $ = (id) => dom.document.getElementById(id);
  const type = (id, value) => {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const submit = async () => {
    $('feedback-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await flush();
    await flush();
  };
  return {
    dom,
    dialog,
    calls,
    $,
    type,
    submit,
    openFromMenu: async () => { pushOpen(); await flush(); },
    isOpen: () => !$('modal-feedback').classList.contains('hidden'),
  };
}

test('the sidebar has a bar with feedback and settings at its foot (#1045)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  const footer = ui.$('sidebar-footer');
  assert.ok(footer, 'the bar exists');
  assert.equal(footer.parentElement.id, 'sidebar');
  assert.equal(footer.previousElementSibling.id, 'tree-container');
  assert.equal(footer.getAttribute('role'), 'toolbar');
  for (const id of ['btn-sidebar-feedback', 'btn-sidebar-settings']) {
    const button = ui.$(id);
    assert.equal(button.tagName, 'BUTTON');
    assert.ok(button.getAttribute('aria-label'));
    assert.equal(button.getAttribute('title'), button.getAttribute('aria-label'));
  }
});

test('the menu opens the form; it shows the diagnostics of the chat on screen (#1045)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  assert.equal(ui.isOpen(), false);
  await ui.openFromMenu();

  assert.equal(ui.isOpen(), true);
  assert.deepEqual(ui.calls.diagnosticsFor, ['openai']);
  assert.equal(ui.$('feedback-diagnostics-values').textContent, 'Snotra 1.25.0 · macOS 15.1 · arm64 · openai');
  assert.equal(ui.$('feedback-diagnostics').checked, true);
  assert.equal(ui.dom.document.activeElement, ui.$('feedback-message'));
  assert.equal(ui.$('feedback-message').placeholder, 'What would help you, and in which situation?');
  assert.equal(ui.$('feedback-fallback').hidden, true);
});

test('Send hands main what was typed, then thanks with the issue number (#1045)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  ui.dialog.open();
  await flush();
  ui.$('feedback-form').querySelector('input[value="bug"]').checked = true;
  ui.type('feedback-message', 'It crashed when I opened a PDF.');
  ui.type('feedback-email', ' du@example.com ');
  ui.$('feedback-diagnostics').checked = false;
  await ui.submit();

  assert.deepEqual(ui.calls.sent, [{
    kind: 'bug',
    message: 'It crashed when I opened a PDF.',
    email: 'du@example.com',
    includeDiagnostics: false,
    providerId: 'openai',
    locale: 'en',
  }]);
  assert.equal(ui.$('feedback-form').hidden, true);
  assert.equal(ui.$('feedback-sent').hidden, false);
  assert.equal(ui.$('feedback-sent-body').textContent, 'Your feedback is now issue #1200 on GitHub.');
  assert.equal(ui.$('feedback-open-issue').hidden, false);
  assert.equal(ui.$('feedback-send').hidden, true);
  assert.equal(ui.dom.document.activeElement, ui.$('feedback-done'));

  ui.$('feedback-open-issue').click();
  assert.deepEqual(ui.calls.opened, [ISSUE]);

  // Done closes; the next open starts with an empty form.
  ui.$('feedback-done').click();
  assert.equal(ui.isOpen(), false);
  ui.dialog.open();
  await flush();
  assert.equal(ui.$('feedback-message').value, '');
  assert.equal(ui.$('feedback-form').hidden, false);
});

test('an empty message or a wrong address stays in the form, at its field (#1045)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  ui.dialog.open();
  await ui.submit();
  assert.equal(ui.calls.sent.length, 0);
  assert.equal(ui.$('feedback-message-error').hidden, false);
  assert.equal(ui.$('feedback-message-error').textContent, 'Write a message first.');
  assert.equal(ui.$('feedback-message').getAttribute('aria-invalid'), 'true');

  ui.type('feedback-message', 'Hello');
  assert.equal(ui.$('feedback-message-error').hidden, true);
  ui.type('feedback-email', 'nope');
  await ui.submit();
  assert.equal(ui.calls.sent.length, 0);
  assert.equal(ui.$('feedback-email-error').textContent, 'This e-mail address does not look right.');
  assert.equal(ui.dom.document.activeElement, ui.$('feedback-email'));
});

test('the counter shows near the limit and turns into "too many" above it (#1045)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  ui.dialog.open();
  ui.type('feedback-message', 'x'.repeat(3999));
  assert.equal(ui.$('feedback-message-counter').hidden, true);
  ui.type('feedback-message', 'x'.repeat(4999));
  assert.equal(ui.$('feedback-message-counter').hidden, false);
  assert.equal(ui.$('feedback-message-counter').textContent, '1 character left');
  ui.type('feedback-message', 'x'.repeat(5002));
  assert.equal(ui.$('feedback-message-counter').textContent, '2 characters too many');
  await ui.submit();
  assert.equal(ui.calls.sent.length, 0);
});

test('a failure keeps the text and offers copy and GitHub (#1045)', async (t) => {
  const ui = await mount({ api: { sendFeedback: async () => ({ ok: false, reason: 'network' }) } });
  t.after(ui.dom.cleanup);
  ui.dialog.open();
  await flush();
  ui.type('feedback-message', 'Please add a dark icon.');
  await ui.submit();

  assert.equal(ui.$('feedback-message').value, 'Please add a dark icon.');
  assert.match(ui.$('feedback-status').textContent, /could not reach the feedback server/);
  assert.ok(ui.$('feedback-status').classList.contains('feedback-dialog__status--error'));
  assert.equal(ui.$('feedback-fallback').hidden, false);
  assert.equal(ui.$('feedback-send').disabled, false);
  assert.equal(ui.dom.document.activeElement, ui.$('feedback-github'));

  ui.$('feedback-copy').click();
  await flush();
  assert.deepEqual(ui.calls.copied, ['Please add a dark icon.']);
  assert.equal(ui.$('feedback-copy').textContent, 'Text copied');

  ui.$('feedback-github').click();
  const url = new URL(ui.calls.opened[0]);
  assert.equal(url.pathname, '/kkrafft1999/snotra/issues/new');
  assert.equal(url.searchParams.get('template'), 'feature_request.yml');
  assert.equal(url.searchParams.get('problem'), 'Please add a dark icon.');
});

test('a duplicate is said plainly, without a fallback (#1045)', async (t) => {
  const ui = await mount({ api: { sendFeedback: async () => ({ ok: false, reason: 'duplicate' }) } });
  t.after(ui.dom.cleanup);
  ui.dialog.open();
  ui.type('feedback-message', 'Same again');
  await ui.submit();
  assert.match(ui.$('feedback-status').textContent, /already sent today/);
  assert.equal(ui.$('feedback-fallback').hidden, true);
});

test('while sending, the form is locked and cannot be closed (#1045)', async (t) => {
  let release;
  const ui = await mount({ api: { sendFeedback: () => new Promise((resolve) => { release = resolve; }) } });
  t.after(ui.dom.cleanup);
  ui.dialog.open();
  ui.type('feedback-message', 'Slow network');
  ui.$('feedback-form').dispatchEvent(new ui.dom.window.Event('submit', { cancelable: true }));
  await flush();

  assert.equal(ui.$('feedback-send').disabled, true);
  assert.equal(ui.$('feedback-send').textContent, 'Sending…');
  assert.equal(ui.$('feedback-message').disabled, true);
  ui.$('modal-feedback').dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.isOpen(), true);

  release({ ok: true, issueUrl: null });
  await flush();
  await flush();
  assert.equal(ui.$('feedback-sent-body').textContent, 'Your feedback is now an issue on GitHub.');
  assert.equal(ui.$('feedback-open-issue').hidden, true);
});

test('Escape closes and keeps the draft for the next open (#1045)', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  ui.dialog.open();
  ui.type('feedback-message', 'Half a thought');
  ui.$('modal-feedback').dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.isOpen(), false);
  ui.dialog.open();
  assert.equal(ui.$('feedback-message').value, 'Half a thought');
});

test('in German the form says du and counts in German (#1045)', async (t) => {
  const ui = await mount({ locale: 'de' });
  t.after(ui.dom.cleanup);
  ui.dialog.open();
  await ui.submit();
  assert.equal(ui.$('feedback-message-error').textContent, 'Schreib zuerst eine Nachricht.');
  ui.type('feedback-message', 'x'.repeat(4500));
  assert.equal(ui.$('feedback-message-counter').textContent, 'Noch 500 Zeichen');
});
