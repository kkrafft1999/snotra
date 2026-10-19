// The capability register of the providers (#996, AR-21).
//
// Every provider declares every capability, every gap carries a reason the UI
// can show and the issue that tracks it (parity rule, quality requirements
// §3). And nothing in the core or the contracts asks which provider it talks
// to — that is what the register is for (CORE-3).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const providers = require('../src/main/providers');
const en = require('../src/shared/i18n/messages/en');
const de = require('../src/shared/i18n/messages/de');
const {
  PROVIDER_CAPABILITIES,
  PER_CONNECTION,
  CAPABILITY_LIMITS,
  TOKENIZER_PROFILES,
  declarationProblems,
  resolveProviderCapabilities,
  declaredProviderTraits,
  resolveProviderTraits,
} = require('../src/shared/contracts/provider-capabilities');

const ROOT = path.join(__dirname, '..');
const knownReasonKeys = new Set(Object.keys(en).filter((key) => Object.hasOwn(de, key)));

function providerOf(id) {
  return providers.getProvider(id);
}

test('every provider declares every capability, each gap with a reason and an issue', () => {
  const register = providers.listCapabilityRegister();
  assert.deepEqual(register.map((entry) => entry.id), providers.PROVIDER_ORDER);
  for (const id of providers.PROVIDER_ORDER) {
    assert.deepEqual(declarationProblems(providerOf(id), { knownReasonKeys }), [], id);
  }
});

test('the reasoning capability matches the levels the adapter offers', () => {
  for (const id of providers.PROVIDER_ORDER) {
    const provider = providerOf(id);
    const declared = provider.capabilities[PROVIDER_CAPABILITIES.REASONING_LEVELS].supported;
    assert.equal(declared === true, !!provider.reasoning, id);
  }
});

test('a per-connection capability follows a setting the entry form offers', () => {
  for (const id of providers.PROVIDER_ORDER) {
    const provider = providerOf(id);
    for (const [name, entry] of Object.entries(provider.capabilities)) {
      if (entry.supported !== PER_CONNECTION) continue;
      assert.equal(provider.connectionPerPreset, true, `${id}.${name}: only an entry with its own connection`);
      assert.equal(provider.fields?.[entry.setting], true, `${id}.${name}: field ${entry.setting}`);
    }
  }
});

test('the check fails on an undeclared capability and on a gap without reason or issue', () => {
  const complete = {
    capabilities: {
      images: { supported: true },
      reasoningLevels: { supported: false, reason: 'provider.capability.reasoningLevels.notBuilt', issue: 1148 },
    },
  };
  assert.deepEqual(declarationProblems(complete, { knownReasonKeys }), []);

  const missing = { capabilities: { images: { supported: true } } };
  assert.match(declarationProblems(missing).join('\n'), /does not declare "reasoningLevels"/);
  assert.deepEqual(declarationProblems({}), ['declares no capabilities']);

  const unknown = { capabilities: { ...complete.capabilities, telepathy: { supported: true } } };
  assert.match(declarationProblems(unknown).join('\n'), /unknown capability "telepathy"/);

  const noReason = { capabilities: { ...complete.capabilities, images: { supported: false, issue: 1 } } };
  assert.match(declarationProblems(noReason).join('\n'), /"images": a gap needs a reason key/);

  const noIssue = { capabilities: { ...complete.capabilities, images: { supported: false, reason: 'chat.image.error.generic' } } };
  assert.match(declarationProblems(noIssue).join('\n'), /"images": a gap needs the number of the issue/);

  const unknownKey = { capabilities: { ...complete.capabilities, images: { supported: false, reason: 'no.such.key', issue: 1 } } };
  assert.match(declarationProblems(unknownKey, { knownReasonKeys }).join('\n'), /not in the message catalogue/);

  const noSetting = { capabilities: { ...complete.capabilities, images: { supported: PER_CONNECTION, reason: 'chat.image.error.generic' } } };
  assert.match(declarationProblems(noSetting).join('\n'), /names its setting/);

  const vague = { capabilities: { ...complete.capabilities, images: { supported: 'sometimes' } } };
  assert.match(declarationProblems(vague).join('\n'), /supported must be/);

  const tiff = { capabilities: { ...complete.capabilities, images: { supported: true, mediaTypes: ['image/tiff'] } } };
  assert.match(declarationProblems(tiff).join('\n'), /mediaTypes/);
});

test('the DTO carries the capabilities as the renderer and the engine read them', () => {
  assert.deepEqual(resolveProviderCapabilities(providerOf('openai')), { images: true, reasoningLevels: true });
  // Gemini narrows the formats (#91); the order is the contract's.
  assert.deepEqual(resolveProviderCapabilities(providerOf('google')), {
    images: true,
    imageMediaTypes: ['image/png', 'image/jpeg', 'image/webp'],
    reasoningLevels: true,
  });
  // Nothing declared, nothing supported — and the gap says it is the provider.
  const nothing = resolveProviderCapabilities(null);
  assert.equal(nothing.images, false);
  assert.equal(nothing.gaps.images.limitedBy, CAPABILITY_LIMITS.PROVIDER);
});

test('an OpenAI-compatible entry takes images by its own switch (#193, #202)', () => {
  const compat = providerOf('openai-compatible');
  const off = resolveProviderCapabilities(compat, { supportsImages: false });
  assert.equal(off.images, false);
  assert.deepEqual(off.gaps.images, {
    limitedBy: CAPABILITY_LIMITS.CONNECTION,
    reason: 'chat.image.error.connectionWithoutImages',
  });
  assert.equal(resolveProviderCapabilities(compat).images, false);
  const on = resolveProviderCapabilities(compat, { supportsImages: true });
  assert.equal(on.images, true);
  assert.equal(on.gaps.images, undefined);
  // The reasoning gap stays, with the issue that tracks it.
  assert.deepEqual(on.gaps.reasoningLevels, {
    limitedBy: CAPABILITY_LIMITS.PROVIDER,
    reason: 'provider.capability.reasoningLevels.notBuilt',
    issue: 1148,
  });
});

test('local models: declared by Ollama, or a server address on this machine (#193)', () => {
  assert.equal(resolveProviderTraits(providerOf('ollama')).runsLocally, true);
  // Ollama stays local behind a network address — the budget held before #996.
  assert.equal(resolveProviderTraits(providerOf('ollama'), { baseUrl: 'https://ollama.intern.example' }).runsLocally, true);
  const compat = providerOf('openai-compatible');
  assert.equal(resolveProviderTraits(compat, { baseUrl: 'http://127.0.0.1:8080/v1' }).runsLocally, true);
  assert.equal(resolveProviderTraits(compat, { baseUrl: 'http://localhost:1234/v1' }).runsLocally, true);
  assert.equal(resolveProviderTraits(compat, { baseUrl: 'https://gw.intern.example/v1' }).runsLocally, false);
  assert.equal(resolveProviderTraits(providerOf('openai')).runsLocally, false);
});

test('the tokenizer profile: measured for OpenAI and local models, conservative elsewhere (#178)', () => {
  assert.equal(resolveProviderTraits(providerOf('openai')).tokenizerProfile, TOKENIZER_PROFILES.O200K);
  assert.equal(resolveProviderTraits(providerOf('ollama')).tokenizerProfile, TOKENIZER_PROFILES.LOCAL);
  // Anthropic and Google were never measured — they get the conservative one.
  assert.equal(resolveProviderTraits(providerOf('anthropic')).tokenizerProfile, TOKENIZER_PROFILES.LOCAL);
  assert.equal(resolveProviderTraits(providerOf('google')).tokenizerProfile, TOKENIZER_PROFILES.LOCAL);
  assert.equal(resolveProviderTraits(providerOf('openai-compatible'), { baseUrl: 'https://openrouter.ai/api/v1' })
    .tokenizerProfile, TOKENIZER_PROFILES.LOCAL);
  // A provider pointed at this machine talks to a locally loaded model.
  assert.equal(resolveProviderTraits(providerOf('openai'), { baseUrl: 'http://127.0.0.1:8080/v1' })
    .tokenizerProfile, TOKENIZER_PROFILES.LOCAL);
});

test('only an entry with an output limit of its own is told to raise it (#931)', () => {
  for (const id of providers.PROVIDER_ORDER) {
    assert.equal(declaredProviderTraits(providerOf(id)).outputLimitSetting, id === 'openai-compatible', id);
  }
});

test('the price table keeps the LiteLLM providers of the register (#949)', () => {
  assert.deepEqual(new Set(providers.litellmPriceProviders()), new Set(['openai', 'anthropic', 'gemini', 'openrouter']));
  assert.deepEqual(declaredProviderTraits(providerOf('google')).priceTable.keyPrefixes, ['gemini/']);
  assert.deepEqual(declaredProviderTraits(providerOf('openai')).priceTable.keyPrefixes, []);
});

// --- No provider IDs in the core and the contracts (CORE-3) ---------------

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** The code of a file without its comments, line by line — a comment may name a provider. */
function codeLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('src/application and src/shared/contracts name no provider ID (#996)', () => {
  const ids = providers.PROVIDER_ORDER.map(escapeRegExp).join('|');
  // A string literal that is exactly an ID, or an ID as an object key.
  const literal = new RegExp(`(['"\`])(?:${ids})\\1`);
  const key = new RegExp(`^\\s*(?:${ids})\\s*:`);
  const offenders = [];
  for (const dir of ['src/application', 'src/shared/contracts']) {
    for (const file of listJsFiles(path.join(ROOT, dir))) {
      codeLines(fs.readFileSync(file, 'utf8')).forEach((line, index) => {
        if (literal.test(line) || key.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], 'ask the capability register (shared/contracts/provider-capabilities.js) instead');
});

test('the guard would catch a provider ID', () => {
  const ids = providers.PROVIDER_ORDER.map(escapeRegExp).join('|');
  const literal = new RegExp(`(['"\`])(?:${ids})\\1`);
  assert.ok(literal.test("const suffix = providerId === 'openai-compatible' ? 'Setting' : '';"));
  assert.ok(literal.test('new Set(["ollama"])'));
  assert.ok(!literal.test("'openai-compatible-ish'"));
  assert.deepEqual(codeLines("// 'ollama'\n/* 'openai' */ x"), ['', ' x']);
});
