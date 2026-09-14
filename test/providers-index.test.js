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

// Bild-Anhaenge (Issue #93): Das Flag beschreibt, ob *unser* Adapter Bilder
// abbildet — nicht, was der Anbieter koennte. Es wandert mit #90 (Anthropic),
// #91 (Google) und #92 (Ollama) auf true; mlx-lm bleibt false.
test('jeder Provider deklariert, ob er Bilder weiterreicht', () => {
  const expected = {
    openai: true,
    anthropic: false,
    google: false,
    ollama: false,
    'mlx-lm': false,
  };
  for (const [id, images] of Object.entries(expected)) {
    assert.equal(providers.getProvider(id).capabilities.images, images, id);
  }
  for (const meta of providers.listProviderMeta()) {
    assert.equal(typeof meta.capabilities?.images, 'boolean', meta.id);
  }
});

test('openai presetFields declare identity-affecting reasoning options', () => {
  const openai = providers.getProvider('openai');
  const field = openai.presentation.presetFields[0];
  assert.equal(field.key, 'reasoningEffort');
  assert.equal(field.affectsPresetIdentity, true);
  // Ohne Praefix: Der nackte Wert haengt im Chat hinter dem Modellnamen.
  assert.equal(field.detailPrefix, '');
  assert.equal(field.showAsSuffix, true);
  assert.equal(field.formatDetail('high'), 'high');
});
