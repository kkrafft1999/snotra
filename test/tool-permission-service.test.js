const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolPermissionService } = require('../src/main/services/tool-permission-service');

// The permission rules without IPC (#1006): the service is driven directly,
// against a policy store and a confirmation port held in memory.

function setup({ encryptionAvailable = true, confirmed = true } = {}) {
  const calls = [];
  let mode = 'smart';
  const toolPolicyStore = {
    read: async () => ({
      mode,
      encryptionAvailable,
      integrity: 'ok',
      globalRules: [],
      workspaceRules: {},
      unsandboxedWorkspaces: [],
      sensitivePathPatterns: [],
      policyVersion: 1,
    }),
    setMode: async (next, options) => {
      calls.push(['setMode', next, options.confirmation]);
      mode = next;
      return { ok: true, mode: next };
    },
    addRule: async (rule, options) => {
      calls.push(['addRule', rule.scope, options.confirmation]);
      return { ok: true, ruleId: 'r1' };
    },
  };
  const asked = [];
  const confirmations = {
    confirm: async (request) => {
      asked.push(request.action);
      return confirmed ? { confirmed: true, receipt: `receipt:${request.action}` } : { confirmed: false };
    },
  };
  const voided = [];
  const service = createToolPermissionService({
    toolPolicyStore,
    confirmations,
    approvals: {
      invalidateAll: (reason) => voided.push(['all', reason]),
      invalidateChat: (chatId) => voided.push(['chat', chatId]),
      respond: () => ({ ok: true, response: 'allow' }),
      getPendingRequest: () => null,
      listPending: () => [],
    },
    sessionGrants: { list: () => [], count: () => 0, clear: () => {}, clearChat: () => {}, revoke: () => false },
    chatSessionSettings: { getCurrentChatId: () => 'chat-1', rememberMode: async () => {}, forgetBackgroundModes: () => {} },
    getActiveWorkspaceRoot: () => '/work',
  });
  let notified = 0;
  const notify = () => { notified += 1; };
  return { service, calls, asked, voided, notify, notified: () => notified };
}

test('"Auto" is asked for, stored with its receipt and voids only the chat\'s own cards', async () => {
  const { service, calls, asked, voided, notify, notified } = setup();
  const result = await service.setMode(notify, 'auto');
  assert.equal(result.ok, true);
  assert.deepEqual(asked, ['mode-auto']);
  assert.deepEqual(calls, [['setMode', 'auto', 'receipt:mode-auto']]);
  assert.deepEqual(voided, [['chat', 'chat-1']]);
  assert.equal(notified(), 1);
});

test('"Auto" without encrypted storage is refused before anyone is asked', async () => {
  const { service, asked, calls, notify, notified } = setup({ encryptionAvailable: false });
  const result = await service.setMode(notify, 'auto');
  assert.equal(result.ok, false);
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, []);
  assert.equal(notified(), 0);
});

test('a declined confirmation stores nothing', async () => {
  const { service, calls, notify } = setup({ confirmed: false });
  const result = await service.addRule(notify, { effect: 'allow', tool: 'read_file', scope: 'global' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'cancelled');
  assert.deepEqual(calls, []);
});

test('a workspace rule is bound to main\'s open folder, and the change voids every card', async () => {
  const { service, calls, voided, notify, notified } = setup();
  const result = await service.addRule(notify, { effect: 'deny', tool: 'read_file', scope: 'workspace', root: '/elsewhere' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['addRule', 'workspace', null]], 'a block needs no confirmation');
  assert.equal(voided[0][0], 'all');
  assert.equal(notified(), 1);
});

test('the state names the open workspace and its mode', async () => {
  const { service } = setup();
  const state = await service.buildState();
  assert.equal(state.workspaceRoot, '/work');
  assert.equal(state.mode, 'smart');
  assert.equal(state.workspaceMode, 'smart');
});
