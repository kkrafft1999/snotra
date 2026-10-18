const test = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../src/main/providers');

test('disposeAll calls every dispose hook and survives throwing providers', (t) => {
  let disposed = 0;
  providers.PROVIDERS['test-ok'] = { id: 'test-ok', dispose: () => { disposed++; } };
  providers.PROVIDERS['test-throws'] = {
    id: 'test-throws',
    dispose: () => {
      throw new Error('kaputt');
    },
  };
  providers.PROVIDER_ORDER.push('test-throws', 'test-ok');
  t.after(() => {
    delete providers.PROVIDERS['test-ok'];
    delete providers.PROVIDERS['test-throws'];
    providers.PROVIDER_ORDER.splice(providers.PROVIDER_ORDER.indexOf('test-throws'), 2);
  });

  assert.doesNotThrow(() => providers.disposeAll());
  assert.equal(disposed, 1, 'dispose after a throwing provider must still run');
});

test('ollama exposes dispose as alias for destroyInsecureDispatcher', () => {
  const ollama = providers.getProvider('ollama');
  assert.equal(typeof ollama.dispose, 'function');
  assert.equal(ollama.dispose, ollama.destroyInsecureDispatcher);
});

// Image attachments (#93): the flag says whether *our* adapter maps images,
// not what the provider could take. Since #90–#92 every built-in one does.
test('jeder Provider deklariert, ob er Bilder weiterreicht', () => {
  const expected = {
    openai: true,
    anthropic: true,
    google: true,
    ollama: true,
  };
  for (const [id, images] of Object.entries(expected)) {
    assert.equal(providers.getProvider(id).capabilities.images, images, id);
  }
  for (const meta of providers.listProviderMeta()) {
    assert.equal(typeof meta.capabilities?.images, 'boolean', meta.id);
  }
});

// A provider that takes fewer image formats names them (#91) — only formats
// the composer can attach, or the list would promise what never arrives.
test('a provider narrows the image formats only to ones Snotra attaches', () => {
  const { IMAGE_ATTACHMENT_MEDIA_TYPES } = require('../src/shared/contracts/attachments');
  for (const meta of providers.listProviderMeta()) {
    const own = meta.capabilities?.imageMediaTypes;
    if (own === undefined) continue;
    assert.ok(own.length > 0, meta.id);
    for (const type of own) assert.ok(IMAGE_ATTACHMENT_MEDIA_TYPES.includes(type), `${meta.id}: ${type}`);
  }
  assert.deepEqual([...providers.getProvider('google').capabilities.imageMediaTypes],
    ['image/png', 'image/jpeg', 'image/webp']);
  assert.equal(providers.getProvider('anthropic').capabilities.imageMediaTypes, undefined);
});

test('openai offers its levels to the chat, not as a preset field (#726)', () => {
  const openai = providers.getProvider('openai');
  assert.deepEqual(openai.presentation.presetFields.map((f) => f.key), ['reasoningSummary']);
  // Every level OpenAI knows, in order of effort; medium stays the default (#718).
  assert.deepEqual(openai.reasoning.levels, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(openai.reasoning.defaultLevel, 'medium');
});
