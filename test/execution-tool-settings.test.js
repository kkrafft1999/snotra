'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createExecutionToolSettings,
  pythonCommandForSandbox,
} = require('../src/main/services/execution-tool-settings');

function setup({ prefs = {}, available = true } = {}) {
  const calls = { detect: 0, sandboxDetect: 0, run: [] };
  const runnerService = {
    isAvailable: () => available,
    describe: () => ({ found: available, path: '/bin/zsh' }),
    detect: async () => {
      calls.detect += 1;
    },
    run: async (request) => {
      calls.run.push(request);
      return { ok: true };
    },
  };
  const sandboxService = {
    describe: () => ({ state: 'ready' }),
    detect: async () => {
      calls.sandboxDetect += 1;
    },
  };
  const { runner, settings } = createExecutionToolSettings({
    runnerService,
    sandboxService,
    readUIPrefs: async () => prefs,
    enabledPref: 'shellExecutionEnabled',
    setup: 'shell',
    switchSetup: 'shell-switch',
  });
  return { runner, settings, calls };
}

test('the tool is off until the switch is read as on (#102)', async () => {
  const { runner, settings } = setup({ prefs: { shellExecutionEnabled: true } });
  assert.equal(runner.isAvailable(), false);
  assert.equal(runner.setupNeeded(), 'shell-switch');

  await settings.refresh();

  assert.equal(runner.isAvailable(), true);
  assert.equal(runner.setupNeeded(), 'shell');
});

test('only `true` switches it on', async () => {
  const { runner, settings } = setup({ prefs: { shellExecutionEnabled: 'yes' } });
  await settings.refresh();
  assert.equal(runner.isAvailable(), false);
});

test('switched on but without a runtime, the runtime is what is missing (#773)', async () => {
  const { runner, settings } = setup({ prefs: { shellExecutionEnabled: true }, available: false });
  await settings.refresh();
  assert.equal(runner.isAvailable(), false);
  assert.equal(runner.setupNeeded(), 'shell');
});

test('detection runs whatever the switch says, the sandbox self-test only when it is on (#111, #329)', async () => {
  const off = setup();
  await off.settings.refresh();
  assert.deepEqual([off.calls.detect, off.calls.sandboxDetect], [1, 0]);

  const on = setup({ prefs: { shellExecutionEnabled: true } });
  await on.settings.refresh();
  assert.deepEqual([on.calls.detect, on.calls.sandboxDetect], [1, 1]);
});

test('the settings describe the runtime, the switch and the sandbox', async () => {
  const { settings } = setup({ prefs: { shellExecutionEnabled: true } });
  assert.deepEqual(await settings.refresh(), { found: true, path: '/bin/zsh', enabled: true, sandbox: { state: 'ready' } });
});

test('the settings name the tool behind the switch, as the registry knows it (#1008)', async () => {
  const { createExecutionToolSettings: create } = require('../src/main/services/execution-tool-settings');
  const { settings } = create({
    runnerService: { isAvailable: () => true, describe: () => ({ found: true }), detect: async () => {}, run: async () => ({}) },
    sandboxService: { describe: () => ({}), detect: async () => {} },
    readUIPrefs: async () => ({}),
    enabledPref: 'shellExecutionEnabled',
    setup: 'shell',
    switchSetup: 'shell-switch',
    toolName: () => 'shell_execute',
  });
  assert.equal(settings.describe().tool, 'shell_execute');
});

test('a run goes to the runner service', async () => {
  const { runner, calls } = setup();
  await runner.run({ command: 'ls' });
  assert.deepEqual(calls.run, [{ command: 'ls' }]);
});

test('the sandbox asks the interpreter run_python would use, and python3 without one (#329)', () => {
  assert.equal(pythonCommandForSandbox({ describe: () => ({ found: true, command: 'py' }) }), 'py');
  assert.equal(pythonCommandForSandbox({ describe: () => ({ found: false, command: '/broken/python' }) }), 'python3');
});
