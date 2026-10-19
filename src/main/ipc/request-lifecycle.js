/** The renderer a request belongs to; `null` for one without a sender. */
/** @typedef {import('electron').WebContents|null|undefined} RequestSender */

// Each renderer owns at most one pending request of this kind.
function createRequestLifecycle() {
  /** @type {Map<RequestSender, AbortController>} */
  const active = new Map();
  /** @param {RequestSender} sender */
  function cancel(sender) {
    active.get(sender)?.abort();
  }
  /**
   * @template T
   * @param {RequestSender} sender
   * @param {(signal: AbortSignal) => Promise<T>|T} operation
   * @returns {Promise<T>}
   */
  async function run(sender, operation) {
    cancel(sender);
    const controller = new AbortController();
    active.set(sender, controller);
    const onDestroyed = () => controller.abort();
    sender?.once?.('destroyed', onDestroyed);
    try {
      return await operation(controller.signal);
    } finally {
      sender?.removeListener?.('destroyed', onDestroyed);
      if (active.get(sender) === controller) active.delete(sender);
    }
  }
  return { run, cancel };
}
module.exports = { createRequestLifecycle };
