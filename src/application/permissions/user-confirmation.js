'use strict';

/**
 * The core side of the user-confirmation port (#980): which actions need a
 * person at the machine, the receipts a confirmation hands out, and the
 * implementation every front end without that person gets.
 *
 * A receipt is an object, not a value: the registry knows it by identity, so
 * it cannot be written down, sent over a wire or rebuilt from its fields. A
 * copy — JSON, IPC, a remote message — is a different object and redeems
 * nothing. The registry is made once in the composition root; its `issue`
 * goes only to the desktop adapter, its `redeem` only to the policy store.
 */

/** What a confirmation is for. The subject named next to each binds the receipt. */
const CONFIRMATION_ACTIONS = Object.freeze({
  /** "Auto" for the chat on screen — subject: the chat id, or '' without one. */
  MODE_AUTO: 'mode-auto',
  /** "Auto" as a workspace's default mode (#413) — subject: the root. */
  WORKSPACE_AUTO: 'workspace-auto',
  /** A stored allow rule, from the settings or a card (#121) — subject: `permissionRuleSubject`. */
  ALLOW_RULE: 'allow-rule',
  /** A block taken away — subject: the rule id. */
  REMOVE_BLOCK: 'remove-block',
  /** Sensitive path patterns taken away (#514) — subject: the removed patterns, sorted, one per line. */
  REMOVE_SENSITIVE_PATTERNS: 'remove-sensitive-patterns',
  /** The sandbox off for a workspace (#357) — subject: the root. */
  SANDBOX_OFF: 'sandbox-off',
  /** A program allowance that widens the sandbox (#408) — subject: the program path. */
  PROGRAM_ALLOWANCE: 'program-allowance',
  /** Hosts kept open for a workspace (#946) — subject: the root. */
  WORKSPACE_HOSTS: 'workspace-hosts',
  /** A workspace's rules reset while blocks or "Always ask" go with them (#514) — subject: the root. */
  RESET_WORKSPACE: 'reset-workspace',
  /** Every rule reset — subject: ''. */
  RESET_ALL: 'reset-all',
  /** Files taken over from outside the workspace (#101) — subject: the target folder. */
  IMPORT_ITEMS: 'import-items',
  /** A workspace skill moved into the global skill folder (#764) — subject: the skill name. */
  SKILL_MAKE_GLOBAL: 'skill-make-global',
});

const CONFIRMATION_REFUSALS = Object.freeze({
  DECLINED: 'declined',
  NO_PRESENCE: 'no-presence',
});

/** How long a receipt waits to be redeemed. The store writes right after the click. */
const RECEIPT_TTL_MS = 60_000;

/**
 * The subject of an allow rule: everything that makes it the rule it is,
 * without its id and creation time — those are minted by the store.
 *
 * @param {object} rule  a normalized permission rule
 * @returns {string}
 */
function permissionRuleSubject(rule) {
  if (!rule || typeof rule !== 'object') return '';
  const fields = Object.keys(rule)
    .filter((key) => key !== 'id' && key !== 'createdAt')
    .sort()
    .map((key) => [key, rule[key]]);
  return JSON.stringify(fields);
}

/** @param {string[]} patterns */
function removedPatternsSubject(patterns) {
  return [...patterns].sort().join('\n');
}

/**
 * @param {{ now?: () => number, ttlMs?: number }} [options]
 * @returns {{
 *   issue: (binding: { action: string, subject?: string }) => object,
 *   redeem: (receipt: unknown, action: string, subject?: string) => boolean,
 * }}
 */
function createConfirmationReceipts({ now = () => Date.now(), ttlMs = RECEIPT_TTL_MS } = {}) {
  /** receipt → { action, subject, expiresAt } */
  const open = new WeakMap();

  function issue({ action, subject = '' }) {
    const receipt = Object.freeze({});
    open.set(receipt, { action, subject: String(subject), expiresAt: now() + ttlMs });
    return receipt;
  }

  /** Good once: a receipt is spent by the first attempt, matching or not. */
  function redeem(receipt, action, subject = '') {
    if (!receipt || typeof receipt !== 'object') return false;
    const entry = open.get(receipt);
    if (!entry) return false;
    open.delete(receipt);
    return entry.action === action && entry.subject === String(subject) && now() <= entry.expiresAt;
  }

  return { issue, redeem };
}

/** What the policy store holds when nothing was wired: every loosening refused. */
const NO_RECEIPTS = Object.freeze({ redeem: () => false });

/**
 * The implementation for every front end without a person at the machine —
 * a local program, the phone, a headless process (remote interface §7.6,
 * O4): it asks nobody and confirms nothing.
 *
 * @returns {import('../ports/user-confirmation-port').UserConfirmationPort}
 */
function createRefusingConfirmation() {
  return {
    presence: 'none',
    canConfirm: () => false,
    confirm: async () => ({ confirmed: false, reason: CONFIRMATION_REFUSALS.NO_PRESENCE }),
  };
}

module.exports = {
  CONFIRMATION_ACTIONS,
  CONFIRMATION_REFUSALS,
  RECEIPT_TTL_MS,
  NO_RECEIPTS,
  permissionRuleSubject,
  removedPatternsSubject,
  createConfirmationReceipts,
  createRefusingConfirmation,
};
