// The overrides a chat holds after proposal cards (#774): one shape for the
// history, the engine and the popover, and the arithmetic on it.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeChatConfigOverrides,
  applyConfigProposal,
  declineConfigProposal,
  effectiveDisabledTools,
  proposalKey,
  MAX_CHAT_OVERRIDE_NAMES,
} = require('../src/shared/contracts/chat-configuration');
const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');

test('normalize: names cleaned and bounded, a name never both on and off, empty is null', () => {
  assert.equal(normalizeChatConfigOverrides(null), null);
  assert.equal(normalizeChatConfigOverrides({ tools: { on: [] }, declined: [] }), null);
  const many = Array.from({ length: MAX_CHAT_OVERRIDE_NAMES + 10 }, (_, i) => `tool_${i}`);
  assert.equal(normalizeChatConfigOverrides({ tools: { on: many } }).tools.on.length, MAX_CHAT_OVERRIDE_NAMES);
  assert.deepEqual(
    normalizeChatConfigOverrides({ tools: { on: [' a ', 'a', '', 7, 'x'.repeat(200)], off: ['a', 'b'] } }),
    { tools: { on: ['a'], off: ['b'] } },
  );
});

test('apply: on and back off returns to the settings; off a setting\'s tool is recorded', () => {
  const on = applyConfigProposal(null, { kind: 'tool', name: 'fetch_url', enable: true });
  assert.deepEqual(on, { tools: { on: ['fetch_url'] } });
  assert.equal(applyConfigProposal(on, { kind: 'tool', name: 'fetch_url', enable: false }), null);
  const off = applyConfigProposal(on, { kind: 'skill', name: 'release', enable: false });
  assert.deepEqual(off, { tools: { on: ['fetch_url'] }, skills: { off: ['release'] } });
  // Applying the same change twice records it once.
  assert.deepEqual(applyConfigProposal(off, { kind: 'skill', name: 'release', enable: false }), off);
});

test('decline: remembered by kind, name and direction', () => {
  const declined = declineConfigProposal(null, { kind: 'tool', name: 'shell_execute', enable: true });
  assert.deepEqual(declined, { declined: ['tool:on:shell_execute'] });
  assert.equal(proposalKey({ kind: 'tool', name: 'shell_execute', enable: false }), 'tool:off:shell_execute');
});

test('effectiveDisabledTools: the settings\' list, minus the chat\'s on, plus its off', () => {
  assert.deepEqual(effectiveDisabledTools(['a', 'b'], { tools: { on: ['a'], off: ['c'] } }), ['b', 'c']);
  assert.deepEqual(effectiveDisabledTools(undefined, null), []);
});

test('the approval DTO carries a proposal only on its own checkpoint, and bounded', () => {
  const config = {
    kind: 'tool', name: 'fetch_url', enable: true, reason: `x${' y'.repeat(400)}`,
    descriptionKey: 'tools.short.fetch_url', riskClasses: ['external', 'bogus'], settingsMenu: 'settings.security',
    origin: 'elsewhere', descriptionIsData: 'yes',
  };
  const dto = createToolApprovalRequestDto({ requestId: 'r1', tool: 'propose_config_change', checkpoint: 'config', config });
  assert.equal(dto.checkpoint, 'config');
  assert.equal(dto.config.name, 'fetch_url');
  assert.ok(dto.config.reason.length <= 300);
  // A list with a class the contract does not know is dropped as a whole.
  assert.equal(Object.hasOwn(dto.config, 'riskClasses'), false);
  const clean = createToolApprovalRequestDto({ requestId: 'r0', tool: 'x', checkpoint: 'config', config: { ...config, riskClasses: ['external'] } });
  assert.deepEqual(clean.config.riskClasses, ['external']);
  assert.equal(Object.hasOwn(dto.config, 'origin'), false);
  assert.equal(Object.hasOwn(dto.config, 'descriptionIsData'), false);
  // A key outside the tool catalogue is not one the renderer looks up.
  const odd = createToolApprovalRequestDto({ requestId: 'r2', tool: 'x', checkpoint: 'config', config: { ...config, descriptionKey: 'settings.title' } });
  assert.equal(Object.hasOwn(odd.config, 'descriptionKey'), false);
  // Without a valid kind, name or direction there is no proposal.
  assert.equal(createToolApprovalRequestDto({ requestId: 'r3', tool: 'x', checkpoint: 'config', config: { kind: 'x', name: 'a', enable: true } }).config, undefined);
  assert.equal(createToolApprovalRequestDto({ requestId: 'r4', tool: 'x', checkpoint: 'access', config }).config, undefined);
});
