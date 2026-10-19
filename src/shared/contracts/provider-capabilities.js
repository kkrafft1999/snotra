/**
 * The capability register of the model providers (#996, AR-21).
 *
 * One vocabulary for what a provider can do, declared by each adapter next to
 * its code (`src/main/providers/*.js`) and assembled in
 * `src/main/providers/index.js`. Nothing outside the adapters asks *which*
 * provider it talks to; it asks what the provider can do — so adding a
 * provider touches its adapter and the catalogue, not the engine and not the
 * settings modal (CORE-3).
 *
 * Two kinds of entry:
 *
 * - **Capabilities** are features a user can miss. Under the parity rule
 *   (`docs/quality-requirements.md` §3) every one of them is declared for
 *   every provider, and every gap carries a reason key the UI can show and the
 *   issue that tracks it. `test/provider-capabilities.test.js` fails on an
 *   undeclared capability and on a gap without reason or issue.
 * - **Traits** are facts about a provider that steer behaviour without being
 *   a feature: whether its models run on this machine, which tokenizer the
 *   context estimate assumes, where its prices are in LiteLLM's table.
 *
 * What travels on is resolved against the configuration of one entry: the
 * renderer gets `{ images, imageMediaTypes?, reasoningLevels, gaps? }` per
 * provider and per entry, the core gets the same plus the traits in the
 * send bundle (`LlmSendBundle`).
 */
'use strict';

const { IMAGE_ATTACHMENT_MEDIA_TYPES } = require('./attachments');
const { isLocalEndpoint } = require('./provider-endpoint');

/** The capabilities every provider declares. */
const PROVIDER_CAPABILITIES = Object.freeze({
  /** Passes image attachments on to the model (#93). */
  IMAGES: 'images',
  /** Offers a reasoning level per chat (#725, #994). */
  REASONING_LEVELS: 'reasoningLevels',
});

/**
 * `supported` of a capability that the entry's own connection decides: the
 * capability follows the boolean connection setting named in `setting`
 * (*Supports images* on an OpenAI-compatible entry).
 */
const PER_CONNECTION = 'per-connection';

/** Why a resolved capability is missing — what the composer names (#995). */
const CAPABILITY_LIMITS = Object.freeze({
  /** Snotra's adapter does not offer it for this provider. */
  PROVIDER: 'provider',
  /** The entry's connection setting is off. */
  CONNECTION: 'connection',
});

/** The tokenizer profiles the context estimate knows (context-breakdown.js). */
const TOKENIZER_PROFILES = Object.freeze({
  LOCAL: 'local',
  O200K: 'o200k',
});

const DEFAULT_TRAITS = Object.freeze({
  runsLocally: false,
  // The more conservative profile, for every tokenizer nobody measured.
  tokenizerProfile: TOKENIZER_PROFILES.LOCAL,
  outputLimitSetting: false,
  priceTable: Object.freeze({ litellmProviders: Object.freeze([]), keyPrefixes: Object.freeze([]) }),
});

/**
 * @typedef {Object} CapabilityDeclaration
 * @property {boolean|string} [supported]  true, false or PER_CONNECTION
 * @property {string} [setting]   PER_CONNECTION: the boolean connection setting it follows
 * @property {string} [reason]    a gap: the message key the UI can show
 * @property {number} [issue]     a gap for good: the issue that tracks it
 * @property {readonly string[]} [mediaTypes]  images: the formats, where fewer than all
 *
 * @typedef {Object} DeclaredTraits
 * @property {boolean} [runsLocally]
 * @property {string} [tokenizerProfile]
 * @property {{ litellmProviders?: readonly string[], keyPrefixes?: readonly string[] }} [priceTable]
 *
 * What an adapter declares — the part of `ProviderAdapter` this file reads.
 * @typedef {Object} DeclaringProvider
 * @property {Object<string, CapabilityDeclaration>} [capabilities]
 * @property {DeclaredTraits} [traits]
 * @property {Object<string, boolean>} [fields]
 */

function isIssueNumber(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isReasonKey(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * What is wrong with one adapter's declaration, as a list of sentences; empty
 * when it is complete. `knownReasonKeys` is the message catalogue the reason
 * keys must exist in.
 *
 * @param {DeclaringProvider|null|undefined} provider
 * @param {{ knownReasonKeys?: Set<string> }} [options]
 */
function declarationProblems(provider, { knownReasonKeys } = {}) {
  const problems = [];
  const declared = provider?.capabilities;
  if (!declared || typeof declared !== 'object') return ['declares no capabilities'];
  const names = Object.values(PROVIDER_CAPABILITIES);
  for (const name of Object.keys(declared)) {
    if (!names.includes(name)) problems.push(`declares unknown capability "${name}"`);
  }
  for (const name of names) {
    const entry = declared[name];
    if (!entry || typeof entry !== 'object') {
      problems.push(`does not declare "${name}"`);
      continue;
    }
    const { supported } = entry;
    if (supported !== true && supported !== false && supported !== PER_CONNECTION) {
      problems.push(`"${name}": supported must be true, false or "${PER_CONNECTION}"`);
      continue;
    }
    if (supported === PER_CONNECTION && !isReasonKey(entry.setting)) {
      problems.push(`"${name}": a per-connection capability names its setting`);
    }
    if (supported === true) continue;
    // A gap — for good, or whenever the connection's switch is off.
    if (!isReasonKey(entry.reason)) {
      problems.push(`"${name}": a gap needs a reason key`);
    } else if (knownReasonKeys && !knownReasonKeys.has(entry.reason)) {
      problems.push(`"${name}": reason key "${entry.reason}" is not in the message catalogue`);
    }
    if (supported === false && !isIssueNumber(entry.issue)) {
      problems.push(`"${name}": a gap needs the number of the issue that tracks it`);
    }
  }
  if (declared.images?.mediaTypes !== undefined) {
    const types = declared.images.mediaTypes;
    if (!Array.isArray(types) || types.some((type) => !IMAGE_ATTACHMENT_MEDIA_TYPES.includes(type))) {
      problems.push('"images": mediaTypes lists only formats Snotra attaches');
    }
  }
  return problems;
}

/**
 * One capability resolved against an entry's configuration:
 * `{ supported: boolean, gap?: { limitedBy, reason, issue? } }`.
 */
function resolveCapability(entry, config) {
  if (entry?.supported === true) return { supported: true };
  if (entry?.supported === PER_CONNECTION) {
    if (config?.[entry.setting] === true) return { supported: true };
    return { supported: false, gap: { limitedBy: CAPABILITY_LIMITS.CONNECTION, reason: entry.reason || '' } };
  }
  const gap = { limitedBy: CAPABILITY_LIMITS.PROVIDER, reason: entry?.reason || '' };
  if (isIssueNumber(entry?.issue)) gap.issue = entry.issue;
  return { supported: false, gap };
}

/**
 * The capability DTO of a provider for one entry's configuration — what the
 * renderer reads and what the engine checks. `imageMediaTypes` only goes
 * along where the provider narrows the formats, so "no field" keeps meaning
 * "all of them" (#91). Without a configuration a per-connection capability
 * is off, the way a new entry starts.
 *
 * @param {DeclaringProvider|null|undefined} provider
 * @param {Object<string, unknown>} [config]
 * @returns {{ images: boolean, imageMediaTypes?: string[], reasoningLevels: boolean,
 *   gaps?: Object<string, { limitedBy: string, reason: string, issue?: number }> }}
 */
function resolveProviderCapabilities(provider, config) {
  /** @type {Object<string, CapabilityDeclaration>} */
  const declared = provider?.capabilities || {};
  /** @type {any} */
  const out = {};
  const gaps = {};
  for (const name of Object.values(PROVIDER_CAPABILITIES)) {
    const { supported, gap } = resolveCapability(declared[name], config);
    out[name] = supported;
    if (gap) gaps[name] = gap;
  }
  const own = declared.images?.mediaTypes;
  if (out.images && Array.isArray(own)) {
    out.imageMediaTypes = IMAGE_ATTACHMENT_MEDIA_TYPES.filter((type) => own.includes(type));
  }
  if (Object.keys(gaps).length > 0) out.gaps = gaps;
  return out;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v) : [];
}

/**
 * A provider's traits as declared, with the defaults filled in — without
 * looking at any configuration.
 *
 * @param {DeclaringProvider|null|undefined} provider
 */
function declaredProviderTraits(provider) {
  /** @type {DeclaredTraits} */
  const raw = provider?.traits || {};
  const profile = Object.values(TOKENIZER_PROFILES).includes(raw.tokenizerProfile)
    ? raw.tokenizerProfile
    : DEFAULT_TRAITS.tokenizerProfile;
  return {
    runsLocally: raw.runsLocally === true,
    tokenizerProfile: profile,
    // An entry that sets its own output limit (#931) is told so when an
    // answer is cut off; the field in the form is the declaration.
    outputLimitSetting: provider?.fields?.maxOutputTokens === true,
    priceTable: {
      litellmProviders: stringList(raw.priceTable?.litellmProviders),
      keyPrefixes: stringList(raw.priceTable?.keyPrefixes),
    },
  };
}

/**
 * The traits for one entry's configuration. A server address on this machine
 * makes the models local whatever the provider declares (#193): the same
 * provider serves LM Studio on `localhost` and a gateway on the network, and
 * only the address tells them apart. A local model is estimated with the
 * profile measured against one.
 *
 * @param {DeclaringProvider|null|undefined} provider
 * @param {{ baseUrl?: string }} [config]
 */
function resolveProviderTraits(provider, config) {
  const traits = declaredProviderTraits(provider);
  if (isLocalEndpoint(config?.baseUrl)) {
    traits.runsLocally = true;
    traits.tokenizerProfile = TOKENIZER_PROFILES.LOCAL;
  }
  return traits;
}

module.exports = {
  PROVIDER_CAPABILITIES,
  PER_CONNECTION,
  CAPABILITY_LIMITS,
  TOKENIZER_PROFILES,
  DEFAULT_TRAITS,
  declarationProblems,
  resolveProviderCapabilities,
  declaredProviderTraits,
  resolveProviderTraits,
};
