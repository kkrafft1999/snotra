'use strict';

/**
 * Why a command runs without the sandbox (#329, #357): what the card, the
 * settings and the model are told. Shared by the sandbox service, which finds
 * out, and the tool-call planner, which plans with it (#982).
 */
const SANDBOX_REASONS = Object.freeze({
  /** Windows (and anything that is neither macOS nor Linux). */
  PLATFORM: 'platform',
  /** Linux without bubblewrap, socat or ripgrep. */
  DEPENDENCIES: 'dependencies',
  /** The library could not be loaded or initialised. */
  START: 'start',
  /** The self-test ran and failed — typically restricted user namespaces. */
  SELF_TEST: 'self-test',
  /** The user switched the sandbox off for this workspace (#357). */
  WORKSPACE: 'workspace',
});

module.exports = { SANDBOX_REASONS };
