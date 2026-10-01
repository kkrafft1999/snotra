'use strict';

/**
 * Snotra's own secrets (security concept §5): the values a tool result must
 * never carry back to the model. A result that contains one of them verbatim
 * is withheld and cannot be approved (`containsOwnSecret`), and the status of
 * an MCP server is masked with them before it leaves the main process
 * (`redactOwnSecrets`).
 *
 * What counts as own:
 * - the API key of every provider and of every model entry with a connection
 *   of its own (#202),
 * - the values of the extra headers of a gateway (#193),
 * - the secrets stored for the MCP servers (#108),
 * - the web search key (#63).
 *
 * Both checks compare plain substrings. A value therefore has to be in the
 * list in each form it can turn up in: `Bearer abcdefgh12345678` in a header
 * reaches an `env` dump or a `.npmrc` as the bare token, so the token is
 * listed next to the full value (#505).
 */

/** Shorter values turn up in any text by chance — the same bound as the checks. */
const MIN_SECRET_LENGTH = 8;

/**
 * An auth scheme in front of a single token: `Bearer …`, `Basic …`,
 * `Token …`, `Bot …`, `SSWS …` and whatever a gateway invents. The scheme is
 * a word; the token is everything after the whitespace and has none itself.
 */
const SCHEME_AND_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*\s+(\S+)$/;

/** The forms a secret can turn up in: the full value, and the bare token after a scheme. */
function secretForms(value) {
  if (typeof value !== 'string') return [];
  const full = value.trim();
  if (full.length < MIN_SECRET_LENGTH) return [];
  const forms = [full];
  const match = SCHEME_AND_TOKEN.exec(full);
  if (match && match[1].length >= MIN_SECRET_LENGTH) forms.push(match[1]);
  return forms;
}

/**
 * Values of "Name: value" lines. The **value** is the secret, not the header
 * name: `X-Tenant` is no secret, what it carries can be one. Very short values
 * stay out, or an `X-Env: dev` would mask every "dev" in every tool output.
 */
function extraHeaderSecretValues(raw) {
  const out = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    out.push(...secretForms(line.slice(sep + 1)));
  }
  return out;
}

/** Every form of every value, once each. */
function expandSecrets(values) {
  const out = new Set();
  for (const value of values) {
    for (const form of secretForms(value)) out.add(form);
  }
  return [...out];
}

/**
 * Reads the own secrets from the stores. Only for comparing — the result is
 * never logged and never leaves the main process.
 */
function createOwnSecrets({ llmConfigStore, providerSecrets, mcpSecrets, webSearchStore }) {
  /** The MCP secrets alone, in all their forms — for masking a server's status. */
  async function readMcpSecrets() {
    return expandSecrets(await mcpSecrets.getMcpSecretValues());
  }

  async function readOwnSecrets() {
    const config = await llmConfigStore.readLLMConfig();
    const values = [];
    const add = (effective) => {
      if (effective?.apiKey) values.push(effective.apiKey);
      // On a gateway the extra headers carry the token (#193) and must not
      // leave the app any more than an API key.
      if (effective?.extraHeaders) values.push(...extraHeaderSecretValues(effective.extraHeaders));
    };
    for (const providerId of Object.keys(config?.providers || {})) {
      add(await providerSecrets.getEffectiveProviderConfig(providerId));
    }
    // Providers with a connection per entry (#202) are not in `providers`;
    // their keys hang on the entries. Without this loop exactly the gateway
    // token would slip through.
    for (const preset of Array.isArray(config?.presets) ? config.presets : []) {
      if (!preset?.id || !preset.connection) continue;
      add(await providerSecrets.getEffectiveProviderConfig(preset.providerId, { presetId: preset.id }));
    }
    // An MCP server could hand its own token back in a result (#108).
    values.push(...(await mcpSecrets.getMcpSecretValues()));
    // The web search key is a provider key like the others (#505).
    const webSearchKey = await webSearchStore.getWebSearchApiKey();
    if (webSearchKey) values.push(webSearchKey);
    return expandSecrets(values);
  }

  return { readOwnSecrets, readMcpSecrets };
}

module.exports = {
  MIN_SECRET_LENGTH,
  secretForms,
  extraHeaderSecretValues,
  expandSecrets,
  createOwnSecrets,
};
