// A system notification when an approval card waits out of sight (#792,
// step 5): main's side — the switch, one notification per card, a click that
// brings the window and the chat up, and closing it once the card is decided.
// The renderer's side is in approval-notification-dom.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createApprovalNotifier } = require('../src/main/services/approval-notifier');

function fakeNotification({ supported = true } = {}) {
  const shown = [];
  class Notification extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.closed = false;
    }

    static isSupported() { return supported; }

    show() { shown.push(this); }

    close() {
      this.closed = true;
      this.emit('close');
    }
  }
  return { Notification, shown };
}

function fakeWindow({ minimized = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
}

function make({ enabled = true, supported = true, win = fakeWindow() } = {}) {
  const { Notification, shown } = fakeNotification({ supported });
  const opened = [];
  const state = { enabled };
  const notifier = createApprovalNotifier({
    Notification,
    getMainWindow: () => win,
    isEnabled: async () => (typeof state.enabled === 'function' ? state.enabled() : state.enabled),
    openChat: (chatId) => opened.push(chatId),
  });
  return { notifier, shown, opened, win, state };
}

const REQUEST = { requestId: 'r1', chatId: 'chat-b', title: 'Needs your approval', body: 'Move:  edit_file wants to\nwrite a file.' };

test('a waiting card gets one notification, with its words tidied', async () => {
  const { notifier, shown } = make();
  assert.equal(await notifier.show(REQUEST), true);
  assert.equal(await notifier.show(REQUEST), false, 'the same card once');
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].options, { title: 'Needs your approval', body: 'Move: edit_file wants to write a file.' });
});

test('nothing when the user switched it off, the system has none, or the switch cannot be read', async () => {
  assert.equal(await make({ enabled: false }).notifier.show(REQUEST), false);
  assert.equal(await make({ supported: false }).notifier.show(REQUEST), false);
  const unreadable = make({ enabled: () => { throw new Error('store'); } });
  assert.equal(await unreadable.notifier.show(REQUEST), false);
  assert.equal(unreadable.shown.length, 0);
  assert.equal(await make().notifier.show({ ...REQUEST, requestId: '' }), false, 'no card, no notification');
});

test('a click brings the window up and opens the card\'s chat', async () => {
  const win = fakeWindow({ minimized: true });
  const { notifier, shown, opened } = make({ win });
  await notifier.show(REQUEST);
  shown[0].emit('click');
  assert.deepEqual(win.calls, ['restore', 'show', 'focus']);
  assert.deepEqual(opened, ['chat-b']);
  assert.equal(notifier.openCount(), 0);
});

test('a decided card takes its notification with it', async () => {
  const { notifier, shown } = make();
  await notifier.show(REQUEST);
  assert.equal(notifier.close('r1'), true);
  assert.equal(shown[0].closed, true);
  assert.equal(notifier.close('r1'), false);
  await notifier.show({ ...REQUEST, requestId: 'r2' });
  shown[1].emit('close');
  assert.equal(notifier.openCount(), 0, 'one the user swiped away is forgotten too');
});

test('a flood of cards does not flood the system', async () => {
  const { notifier, shown } = make();
  for (let i = 0; i < 60; i += 1) await notifier.show({ ...REQUEST, requestId: `r${i}` });
  assert.equal(shown.length, 50);
});
