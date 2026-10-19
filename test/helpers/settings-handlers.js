const { registerSettingsHandlers } = require('../../src/main/ipc/settings-handlers');
const { createLlmPresets } = require('../../src/main/services/llm-settings');
const { createSettingsService } = require('../../src/main/services/settings-service');

/**
 * Registers the settings handlers the way the composition root does: the
 * settings service built from the same collaborators, the handlers on top
 * (#1006). Tests that drive the channels keep handing in one bag of deps.
 */
function registerSettingsForTest(deps) {
  // Older tests hand in the stand-in as `safeStorage`; the services take a secret store (#983).
  const secretStore = deps.secretStore ?? deps.safeStorage;
  const presets = createLlmPresets({ ...deps, secretStore });
  const settings = createSettingsService({ ...deps, secretStore, presets });
  registerSettingsHandlers({ ...deps, settings });
  return settings;
}

module.exports = { registerSettingsForTest };
