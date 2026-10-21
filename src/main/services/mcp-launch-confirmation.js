'use strict';

/**
 * What a local MCP server starts, and when storing it needs a person at the
 * machine (#1104).
 *
 * A stdio server's command runs with the user's rights, outside the sandbox
 * and without a card, as soon as the server is switched on or tested. So the
 * store takes a command only with a receipt of the user-confirmation port
 * (#980) when it is new or changed — the command, its arguments, its folder
 * or its environment. Switching a server on or off, renaming it, its tool
 * selection and a remote server start nothing new and need none.
 *
 * Both sides decide with the functions here: the settings handler, to know
 * whether to ask, from the masked list the window sees; the store, under its
 * lock, from what is on disk. Each brings the server it had before in the
 * same shape (`McpLaunchBefore`), so the two cannot disagree.
 */

const { MCP_TRANSPORTS } = require('../../shared/contracts/mcp');

/** @typedef {import('../../shared/contracts/mcp').McpServerConfig} McpServerConfig */
/** @typedef {import('../../shared/contracts/mcp').McpSecretInputEntry} McpSecretInputEntry */

/**
 * A stored server as far as its launch goes. `env` names each variable with
 * whether its value is secret; a plain value comes with it.
 *
 * @typedef {Object} McpLaunchBefore
 * @property {string} transport
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {string|null} [cwd]
 * @property {Record<string, { secret: boolean, value?: string }>} env
 */

/**
 * @param {{ transport: string, command?: string, args?: string[], cwd?: string|null,
 *   env?: Record<string, { enc?: unknown, value?: unknown } | null | undefined> }|null|undefined} stored
 *   a server as the store keeps it: env values `{ enc }` or `{ value }`
 * @returns {McpLaunchBefore|null}
 */
function launchBeforeFromStored(stored) {
  if (!stored) return null;
  /** @type {McpLaunchBefore['env']} */
  const env = {};
  for (const [key, entry] of Object.entries(stored.env || {})) {
    env[key] = typeof entry?.enc === 'string'
      ? { secret: true }
      : { secret: false, value: typeof entry?.value === 'string' ? entry.value : '' };
  }
  return { transport: stored.transport, command: stored.command, args: stored.args, cwd: stored.cwd, env };
}

/**
 * @param {{ transport: string, command?: string, args?: string[], cwd?: string|null,
 *   env?: import('../../shared/contracts/mcp').McpMaskedEntry[] }|null|undefined} listed
 *   a server as the window sees it: env a masked list of `{ key, secret, value? }`
 * @returns {McpLaunchBefore|null}
 */
function launchBeforeFromListed(listed) {
  if (!listed) return null;
  /** @type {McpLaunchBefore['env']} */
  const env = {};
  for (const entry of Array.isArray(listed.env) ? listed.env : []) {
    if (!entry || typeof entry.key !== 'string') continue;
    env[entry.key] = entry.secret
      ? { secret: true }
      : { secret: false, value: typeof entry.value === 'string' ? entry.value : '' };
  }
  return { transport: listed.transport, command: listed.command, args: listed.args, cwd: listed.cwd, env };
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function sameList(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  return left.length === right.length && left.every((item, i) => item === right[i]);
}

/**
 * Whether one variable of the save leaves the stored one as it was.
 * @param {McpSecretInputEntry} entry
 * @param {McpLaunchBefore['env'][string]} before
 */
function sameEnvEntry(entry, before) {
  if (entry.keep) return true;
  // A secret typed in again counts as new: the stored one cannot be compared
  // without decrypting it, and a variable can change what a program loads.
  // Only an empty one, which is stored as an empty plain value, is the same.
  if (entry.secret && entry.value) return false;
  return before.secret === false && before.value === entry.value;
}

/**
 * Whether storing this server lets a command run that nobody confirmed.
 *
 * @param {McpServerConfig|null} value
 *   the validated server (`validateMcpServerInput(...).value`)
 * @param {McpSecretInputEntry[]} envEntries
 * @param {McpLaunchBefore|null} before  the server stored under the same id
 */
function mcpLaunchNeedsConfirmation(value, envEntries, before) {
  if (!value || value.transport !== MCP_TRANSPORTS.STDIO) return false;
  if (!before || before.transport !== MCP_TRANSPORTS.STDIO) return true;
  if (value.command !== before.command) return true;
  if ((value.cwd || '') !== (before.cwd || '')) return true;
  if (!sameList(value.args, before.args)) return true;
  const entries = Array.isArray(envEntries) ? envEntries : [];
  const beforeKeys = Object.keys(before.env || {});
  if (entries.length !== beforeKeys.length) return true;
  return entries.some((entry) => !before.env[entry.key] || !sameEnvEntry(entry, before.env[entry.key]));
}

/**
 * The subject the receipt is bound to: the server and everything it starts.
 * A secret goes into it as typed; the subject lives only in memory, for the
 * minute between the click and the write.
 *
 * @param {McpServerConfig|null} value
 * @param {McpSecretInputEntry[]} envEntries
 */
function mcpLaunchSubject(value, envEntries) {
  /** @type {Array<[string, boolean, string|null]>} */
  const env = [];
  for (const entry of Array.isArray(envEntries) ? envEntries : []) {
    env.push([entry.key, entry.secret === true, entry.keep ? null : entry.value]);
  }
  env.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([value?.id, value?.command, value?.args || [], value?.cwd || '', env]);
}

module.exports = {
  launchBeforeFromStored,
  launchBeforeFromListed,
  mcpLaunchNeedsConfirmation,
  mcpLaunchSubject,
};
