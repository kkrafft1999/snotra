'use strict';

// The tokenizer the settings estimate each tool's context cost with (#1219).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActiveTokenizerProfile } = require('../src/application/chat/active-tokenizer-profile');

test('the profile of the model a new chat would use', async () => {
  const targets = [];
  const profile = createActiveTokenizerProfile({
    resolveChatTarget: async () => ({ providerId: 'openai', model: 'gpt-5' }),
    prepareSendBundle: async (target) => {
      targets.push(target);
      return { traits: { tokenizerProfile: 'o200k' } };
    },
  });
  assert.equal(await profile(), 'o200k');
  assert.deepEqual(targets, [{ providerId: 'openai', model: 'gpt-5' }]);
});

test('no model, or one that cannot be read: no profile, and no error', async () => {
  const noModel = createActiveTokenizerProfile({
    resolveChatTarget: async () => ({ ok: false, error: { key: 'provider.error.unknown' } }),
    prepareSendBundle: async () => { throw new Error('must not be asked'); },
  });
  assert.equal(await noModel(), undefined);
  const broken = createActiveTokenizerProfile({
    resolveChatTarget: async () => ({ providerId: 'gone', model: 'x' }),
    prepareSendBundle: async () => { throw new Error('Unknown provider "gone".'); },
  });
  assert.equal(await broken(), undefined);
});
