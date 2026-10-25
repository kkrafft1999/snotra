'use strict';

/**
 * Snotra's own secrets (security concept §5): the values a tool result must
 * never carry back to the model. A result that contains one of them, verbatim
 * or encoded, is withheld and cannot be approved (`containsOwnSecret`), and
 * the status of an MCP server is masked with them before it leaves the main
 * process (`redactOwnSecrets`).
 *
 * What counts as own:
 * - the API key of every provider and of every model entry with a connection
 *   of its own (#202),
 * - the values of the extra headers of a gateway (#193),
 * - the secrets stored for the MCP servers (#108),
 * - the web search key (#63),
 * - the credentials of the program allowances (#1262). A run that gets one
 *   has it masked in its output already; anywhere else it is withheld.
 *
 * Both checks compare plain substrings. A value therefore has to be in the
 * list in each form it can turn up in: `Bearer abcdefgh12345678` in a header
 * reaches an `env` dump or a `.npmrc` as the bare token, so the token is
 * listed next to the full value (#505). Each of these forms is listed once
 * more in each encoding a shell command or a request log prints it in —
 * base64 and base64url, hex, URL and JSON escaping (#993, `encodedForms`).
 */

/** Shorter values turn up in any text by chance — the same bound as the checks. */
const MIN_SECRET_LENGTH = 8;

/**
 * An auth scheme in front of a single token: `Bearer …`, `Basic …`,
 * `Token …`, `Bot …`, `SSWS …` and whatever a gateway invents. The scheme is
 * a word; the token is everything after the whitespace and has none itself.
 */
const SCHEME_AND_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*\s+(\S+)$/;

/**
 * The forms a secret can turn up in: the full value, and the bare token after a scheme.
 * @param {unknown} value
 * @returns {string[]}
 */
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
 * The base64 characters that only the value decides, for each of the three
 * places it can start at within a 3-byte group. `echo -n "$KEY" | base64`
 * starts it at the first byte, `printf 'user:%s' "$KEY" | base64` at the
 * third; the characters at both ends also carry bits of whatever stands next
 * to the value and are left off. What remains of an 8-character value is 10
 * characters long, so no form falls under the minimum length.
 *
 * @param {Buffer} bytes
 * @returns {string[]}
 */
function base64Slices(bytes) {
  /** @type {string[]} */
  const out = [];
  for (let offset = 0; offset < 3; offset += 1) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    const start = Math.ceil((8 * offset) / 6);
    const end = Math.floor((8 * (offset + bytes.length)) / 6);
    out.push(encoded.slice(start, end));
  }
  return out;
}

/**
 * The encoded forms of one verbatim form (#993): base64 at each of the three
 * offsets, the same in the base64url alphabet, hex in lower and upper case,
 * percent-encoded with upper- and lower-case escapes, and JSON-escaped — a
 * tool result reaches the check as JSON, where a `"` or `\` in a value is
 * escaped. Only the forms that differ from the value are listed.
 *
 * Not listed, and therefore not matched: other encodings (base32, gzip,
 * encryption, a hex dump with offsets or spaces), mixed-case hex, a value
 * split into pieces, and what a value decodes to — the user name and
 * password inside a `Basic` token are not secrets of their own.
 *
 * @param {string} form
 * @returns {string[]}
 */
function encodedForms(form) {
  const bytes = Buffer.from(form, 'utf8');
  /** @type {Set<string>} */
  const out = new Set();
  for (const slice of base64Slices(bytes)) {
    out.add(slice);
    out.add(slice.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  const hex = bytes.toString('hex');
  out.add(hex);
  out.add(hex.toUpperCase());
  const uriEncoded = encodeURIComponent(form);
  out.add(uriEncoded);
  out.add(uriEncoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
  out.add(JSON.stringify(form).slice(1, -1));
  out.delete(form);
  return [...out].filter((encoded) => encoded.length >= MIN_SECRET_LENGTH);
}

/**
 * Values of "Name: value" lines. The **value** is the secret, not the header
 * name: `X-Tenant` is no secret, what it carries can be one. Very short values
 * stay out, or an `X-Env: dev` would mask every "dev" in every tool output.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function extraHeaderSecretValues(raw) {
  /** @type {string[]} */
  const out = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    out.push(...secretForms(line.slice(sep + 1)));
  }
  return out;
}

/**
 * Every form of every value, verbatim and encoded, once each.
 * @param {Iterable<unknown>} values
 * @returns {string[]}
 */
function expandSecrets(values) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const value of values) {
    for (const form of secretForms(value)) {
      out.add(form);
      for (const encoded of encodedForms(form)) out.add(encoded);
    }
  }
  return [...out];
}

/**
 * Reads the own secrets from the stores. Only for comparing — the result is
 * never logged and never leaves the main process.
 *
 * The stores are typed from this side: what is read of each.
 *
 * @param {Object} deps
 * @param {Pick<import('../ports/llm-config-store-port').LlmConfigStorePort, 'readLLMConfig'>} deps.llmConfigStore
 * @param {import('../ports/provider-secrets-port').ProviderSecretsPort} deps.providerSecrets
 * @param {{ getMcpSecretValues: () => Promise<string[]> }} deps.mcpSecrets
 * @param {{ getWebSearchApiKey: () => Promise<string|null> }} deps.webSearchStore
 * @param {{ getAllowanceSecretValues: () => Promise<string[]> } | null} [deps.allowanceSecrets]
 */
function createOwnSecrets({ llmConfigStore, providerSecrets, mcpSecrets, webSearchStore, allowanceSecrets = null }) {
  /** The MCP secrets alone, in all their forms — for masking a server's status. */
  async function readMcpSecrets() {
    return expandSecrets(await mcpSecrets.getMcpSecretValues());
  }

  async function readOwnSecrets() {
    const config = await llmConfigStore.readLLMConfig();
    /** @type {string[]} */
    const values = [];
    /** @param {import('../ports/provider-secrets-port').EffectiveProviderConfig|null} effective */
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
    // A token handed to a program through its allowance (#1262).
    if (allowanceSecrets) values.push(...(await allowanceSecrets.getAllowanceSecretValues()));
    return expandSecrets(values);
  }

  return { readOwnSecrets, readMcpSecrets };
}

module.exports = {
  MIN_SECRET_LENGTH,
  secretForms,
  encodedForms,
  extraHeaderSecretValues,
  expandSecrets,
  createOwnSecrets,
};
