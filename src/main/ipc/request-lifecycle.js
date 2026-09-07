// Each renderer owns at most one pending request of this kind.
function createRequestLifecycle() {
  const active = new Map();
  function cancel(sender) {
    active.get(sender)?.abort();
  }
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
