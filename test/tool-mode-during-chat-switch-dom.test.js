// A mode chosen while a chat switch is still on its way (#564): the renderer
// already shows the new chat, main has not applied its stored mode yet. Sent
// right away, the choice would be overwritten by that switch — so it waits.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer } = require('./helpers/dom.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeApi() {
  const sent = [];
  return {
    sent,
    api: {
      getToolPermissionState: async () => ({ mode: sent.at(-1) || 'smart' }),
      setToolPermissionMode: async (mode) => {
        sent.push(mode);
        return { ok: true, mode };
      },
      setWorkspaceMode: async (mode) => {
        sent.push(`workspace:${mode}`);
        return { ok: true };
      },
    },
  };
}

test('a mode chosen during a chat switch reaches main only after the switch', async () => {
  setupRendererDom();
  const { initToolPermissionState } = await importRenderer('state', 'tool-permissions.js');
  const { api, sent } = fakeApi();
  const chatSwitch = deferred();
  const permissions = initToolPermissionState({ api, whenChatSettled: () => chatSwitch.promise });

  const chosen = permissions.setMode('ask-all');
  await flush();
  assert.deepEqual(sent, [], 'held back while the switch runs');

  chatSwitch.resolve();
  const result = await chosen;
  assert.deepEqual(sent, ['ask-all']);
  assert.equal(result.ok, true);
  assert.equal(permissions.mode(), 'ask-all');
});

test('without a switch on its way the mode goes out at once; the workspace default never waits', async () => {
  setupRendererDom();
  const { initToolPermissionState } = await importRenderer('state', 'tool-permissions.js');
  const { api, sent } = fakeApi();
  const never = new Promise(() => {});
  const settled = initToolPermissionState({ api });

  await settled.setMode('ask-all');
  assert.deepEqual(sent, ['ask-all']);

  // The default lives on the folder, not on the chat: no switch overwrites it.
  const switching = initToolPermissionState({ api, whenChatSettled: () => never });
  await switching.setWorkspaceMode('ask-all');
  assert.deepEqual(sent, ['ask-all', 'workspace:ask-all']);
});
