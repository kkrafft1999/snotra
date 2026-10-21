'use strict';

const { TOOL_EXECUTION_KINDS } = require('../contracts/tool-presentation');

/**
 * Which domains an isolated run may reach (#329).
 *
 * One function for both sides of an approval: the planner puts its result on
 * the card, the tool handler hands the same result to the sandbox. Both read
 * the same arguments, and the approval is bound to those arguments through
 * the plan key — so the card cannot name other domains than the run gets.
 *
 * Two sources:
 * - what the model declares in `network_domains`;
 * - domains a package install obviously needs (`pip install` → PyPI,
 *   `npm install` → the npm registry). Without them the most common reason
 *   for network access would fail by default, and a default that breaks
 *   package installs gets switched off (comment on #329).
 */

const MAX_DOMAINS = 20;
const MAX_DOMAIN_CHARS = 253;

/**
 * A host name, optionally with a leading `*.` and a `:port`. Everything else
 * is dropped: an IP literal would bypass what the card shows by name, a bare
 * `*` would open everything.
 */
const DOMAIN_PATTERN = /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;
const IP_LITERAL = /^[\d.]+(:\d+)?$/;

/**
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizeDomains(list) {
  if (!Array.isArray(list)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
    if (!value || value.length > MAX_DOMAIN_CHARS) continue;
    if (!DOMAIN_PATTERN.test(value) || IP_LITERAL.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

/** Package managers and the registries they cannot work without. */
const PACKAGE_INSTALLS = Object.freeze([
  {
    pattern: /\b(?:pip3?|pipx|uv\s+pip|python3?\s+-m\s+pip)\s+(?:install|download|wheel)\b|\bpoetry\s+(?:install|add|update)\b|\buv\s+(?:add|sync|lock)\b/,
    domains: ['pypi.org', 'files.pythonhosted.org'],
  },
  {
    pattern: /\b(?:npm|pnpm)\s+(?:install|i|ci|add|update|exec)\b|\bnpx\s/,
    domains: ['registry.npmjs.org'],
  },
  {
    pattern: /\byarn(?:\s+(?:install|add|up|upgrade))?(?:\s|$)/,
    domains: ['registry.yarnpkg.com', 'registry.npmjs.org'],
  },
]);

/**
 * @param {unknown} command
 * @returns {string[]}
 */
function suggestDomains(command) {
  const text = typeof command === 'string' ? command : '';
  /** @type {string[]} */
  const out = [];
  for (const entry of PACKAGE_INSTALLS) {
    if (entry.pattern.test(text)) out.push(...entry.domains);
  }
  return out;
}

/**
 * The domains of one call, by the kind of process the tool starts (its
 * descriptor's `execution`, #1008). A shell command adds the suggestions for
 * its command; a Python program gets what it declares and nothing else — its
 * description says "no pip install", and a subprocess inside the script is
 * not something to guess about.
 *
 * @param {string | undefined} execution  One of `TOOL_EXECUTION_KINDS`.
 * @param {{ network_domains?: unknown, command?: unknown } | null | undefined} args
 * @returns {string[]}
 */
function resolveNetworkDomains(execution, args) {
  const declared = Array.isArray(args?.network_domains) ? args.network_domains : [];
  const suggested = execution === TOOL_EXECUTION_KINDS.SHELL ? suggestDomains(args?.command) : [];
  return normalizeDomains([...declared, ...suggested]);
}

/**
 * The domains of one run with a program allowance (#408): the allowance's
 * first, so the cap never pushes out what the user set, then the call's own.
 *
 * @param {string | undefined} execution
 * @param {{ network_domains?: unknown, command?: unknown } | null | undefined} args
 * @param {{ domains?: string[], writePaths?: string[], trustd?: boolean } | null | undefined} allowance  A program allowance.
 * @returns {string[]}
 */
function resolveRunDomains(execution, args, allowance) {
  const declared = resolveNetworkDomains(execution, args);
  const granted = Array.isArray(allowance?.domains) ? allowance.domains : [];
  return granted.length > 0 ? normalizeDomains([...granted, ...declared]) : declared;
}

module.exports = {
  normalizeDomains,
  suggestDomains,
  resolveNetworkDomains,
  resolveRunDomains,
  MAX_DOMAINS,
};
