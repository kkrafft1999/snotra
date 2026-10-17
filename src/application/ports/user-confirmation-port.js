/**
 * UserConfirmation port (#980, AR-05): a person at this machine confirms an
 * action that loosens a protection — "Auto", an allow rule, a block or a
 * sensitive pattern taken away, the sandbox off for a workspace, a program
 * allowance, a host kept open, a reset — or that brings something in from
 * outside the workspace (an import, a skill made global).
 *
 * **The presence guarantee.** A `confirmed` outcome means that a person at
 * the desktop answered a prompt the app showed there, and nothing else: not
 * a front end that holds a credential, not a message a client sent, not a
 * click the renderer reports. Only an adapter that can show such a prompt
 * declares `presence: 'desktop'`; every other one answers each request with
 * `no-presence` and so can never loosen anything (remote interface §7.6).
 *
 * The outcome of a confirmation carries a **receipt**. The policy store
 * refuses every loosening without one, and a receipt is good only once, only
 * for its action and subject, and only for a short while
 * (`src/application/permissions/user-confirmation.js`). So a path that does
 * not go through this port cannot loosen the policy, whatever it calls.
 *
 * Cancel is the default answer of every prompt: Enter and Escape confirm
 * nothing (#59).
 */

/**
 * What the person sees. `buttons[0]` confirms, `buttons[1]` cancels; any
 * `defaultId`/`cancelId` given is overridden — cancel is always the default.
 *
 * @typedef {Object} ConfirmationPrompt
 * @property {'warning'|'question'|'info'} [type]
 * @property {string} [title]
 * @property {string} message
 * @property {string} [detail]
 * @property {string[]} buttons
 * @property {boolean} [noLink]
 * @property {number} [defaultId]
 * @property {number} [cancelId]
 */

/**
 * @typedef {Object} ConfirmationRequest
 * @property {string} action  a CONFIRMATION_ACTIONS value
 * @property {string} [subject]  what the receipt is bound to: a chat, a root, a rule, a program
 * @property {ConfirmationPrompt} prompt
 */

/**
 * @typedef {Object} ConfirmationOutcome
 * @property {boolean} confirmed
 * @property {object} [receipt]  only when confirmed; opaque, good once
 * @property {'declined'|'no-presence'} [reason]  only when not confirmed
 */

/**
 * @typedef {Object} UserConfirmationPort
 * @property {'desktop'|'none'} presence  whether a person at this machine can be asked at all
 * @property {() => boolean} canConfirm  whether a prompt can be shown right now
 * @property {(request: ConfirmationRequest) => Promise<ConfirmationOutcome>} confirm
 */

module.exports = {};
