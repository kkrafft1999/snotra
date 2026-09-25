'use strict';

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

function normalizeDomains(list) {
  if (!Array.isArray(list)) return [];
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

function suggestDomains(command) {
  const text = typeof command === 'string' ? command : '';
  const out = [];
  for (const entry of PACKAGE_INSTALLS) {
    if (entry.pattern.test(text)) out.push(...entry.domains);
  }
  return out;
}

/**
 * The domains of one call. `shell_execute` adds the suggestions for its
 * command; `run_python` gets what it declares and nothing else — its
 * description says "no pip install", and a subprocess inside the script is
 * not something to guess about.
 */
function resolveNetworkDomains(toolName, args) {
  const declared = Array.isArray(args?.network_domains) ? args.network_domains : [];
  const suggested = toolName === 'shell_execute' ? suggestDomains(args?.command) : [];
  return normalizeDomains([...declared, ...suggested]);
}

module.exports = {
  normalizeDomains,
  suggestDomains,
  resolveNetworkDomains,
  MAX_DOMAINS,
};
