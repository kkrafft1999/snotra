/**
 * Starts the tool runtimes once after the window is shown (#63, #86, #108).
 *
 * Each runtime starts on its own (#1002): with a plain `Promise.all` one
 * rejection skipped the notification below, and the failure went nowhere.
 * Now a failure is logged with the runtime's name, the others carry on, and
 * `onSettled` runs whatever happened — it is what tells the mode pill which
 * execution tools exist (#357). How a failure reaches the settings is the
 * runtime's own business; this only makes sure it is not swallowed.
 *
 * @param {object} options
 * @param {{ name: string, start: () => unknown }[]} options.runtimes
 * @param {() => void} [options.onSettled]
 * @param {{ error: (...args: unknown[]) => void }} [options.log]
 * @returns {Promise<{ failed: string[] }>} the names of the runtimes that failed
 */
async function startToolRuntimes({ runtimes, onSettled = () => {}, log = console }) {
  // `then(start)` also turns a synchronous throw into a rejection of its own.
  const results = await Promise.allSettled(runtimes.map(({ start }) => Promise.resolve().then(start)));
  /** @type {string[]} */
  const failed = [];
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const { name } = runtimes[index];
    failed.push(name);
    log.error(`Tool runtime ${name} failed to start:`, result.reason);
  });
  try {
    onSettled();
  } catch (error) {
    log.error('Announcing the tool runtimes failed:', error);
  }
  return { failed };
}

module.exports = {
  startToolRuntimes,
};
