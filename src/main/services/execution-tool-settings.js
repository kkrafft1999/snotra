'use strict';

/**
 * The switch in front of an execution tool — `run_python` (#86) and
 * `shell_execute` (#102).
 *
 * Two conditions have to hold before the tool is offered at all: the runtime
 * was found, and the user switched the tool on. The switch is off by default,
 * because code that runs gets around the workspace boundary. It is read at
 * start and after the settings are saved, and remembered here, since the tool
 * list is built synchronously.
 *
 * Detection runs whatever the switch says: it reads the user's PATH, which the
 * other runner needs as well (#111). The sandbox self-test runs only for a
 * switched-on tool (#329), so nothing of it starts for someone who never
 * enables either.
 */

/**
 * @param {Object} deps
 * @param {{ isAvailable: Function, describe: Function, detect: Function, run: Function }} deps.runnerService
 * @param {{ describe: Function, detect: Function }} deps.sandboxService
 * @param {() => Promise<Object>} deps.readUIPrefs
 * @param {string} deps.enabledPref     the preference that holds the switch
 * @param {string} deps.setup           what is missing with the switch on: the runtime
 * @param {string} deps.switchSetup     what is missing with the switch off: the switch (#773)
 */
function createExecutionToolSettings({ runnerService, sandboxService, readUIPrefs, enabledPref, setup, switchSetup }) {
  let enabled = false;

  const settings = {
    describe: () => ({
      ...runnerService.describe(),
      enabled,
      sandbox: sandboxService.describe(),
    }),
    async refresh() {
      const prefs = await readUIPrefs();
      enabled = prefs?.[enabledPref] === true;
      await runnerService.detect();
      if (enabled) await sandboxService.detect();
      return settings.describe();
    },
  };

  const runner = {
    isAvailable: () => enabled && runnerService.isAvailable(),
    setupNeeded: () => (enabled ? setup : switchSetup),
    run: (request) => runnerService.run(request),
  };

  return { runner, settings };
}

/**
 * The interpreter `run_python` would use decides whether pip needs its
 * certifi fallback inside the sandbox (decision 2b on #329). Without one the
 * check asks `python3`.
 */
function pythonCommandForSandbox(pythonRunnerService) {
  const python = pythonRunnerService.describe();
  return python.found ? python.command : 'python3';
}

module.exports = {
  createExecutionToolSettings,
  pythonCommandForSandbox,
};
