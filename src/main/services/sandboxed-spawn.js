'use strict';

/**
 * What a runner spawns, with or without the sandbox (#329).
 *
 * Both runners hand in the argv they would start anyway. With isolation the
 * argv becomes one quoted command line inside `/bin/sh -c <wrapped>`, so the
 * process that runs is exactly the one that would have run — same shell,
 * same login flag, same interpreter flags — only under the sandbox. Without
 * isolation the argv is spawned as before, and `isolation` says why.
 *
 * `disabled` is the user's per-workspace opt-out (#357): the sandbox is not
 * even asked, and `isolation` names that choice as the reason.
 */

const { quoteArgv, SANDBOX_REASONS } = require('./sandbox-service');

const PASSTHROUGH = Object.freeze({
  env: Object.freeze({}),
  annotate: (stderr) => stderr,
  release: () => {},
});

/**
 * @param {object} request
 * @param {object|null} request.sandbox       the sandbox service, if wired
 * @param {boolean} [request.disabled]         switched off for this workspace (#357)
 * @param {string[]} request.argv             [program, ...args]
 * @param {string} [request.workspaceRoot]
 * @param {string} request.runTmp
 * @param {string[]} [request.domains]
 * @param {{writePaths?: string[], trustd?: boolean}|null} [request.allowance]  a program allowance (#408)
 * @param {string} [request.commandId]
 * @param {string} [request.commandText]
 * @param {AbortSignal} [request.abortSignal]
 * @returns {Promise<{command: string, args: string[], env: object,
 *   isolation: null|{isolated: boolean, domains?: string[], writePaths?: string[], trustd?: boolean,
 *     reason?: string, missing?: string[]},
 *   annotate: (s: string) => string, release: () => void}>}
 *   Rejects with an AbortError when "Stop" comes while waiting for the gate.
 */
async function planSpawn({
  sandbox,
  disabled = false,
  argv,
  workspaceRoot,
  runTmp,
  domains,
  allowance = null,
  commandId,
  commandText,
  abortSignal,
}) {
  const [program, ...rest] = argv;
  if (disabled) {
    return {
      command: program,
      args: rest,
      isolation: { isolated: false, reason: SANDBOX_REASONS.WORKSPACE, missing: [] },
      ...PASSTHROUGH,
    };
  }
  if (!sandbox) {
    return { command: program, args: rest, isolation: null, ...PASSTHROUGH };
  }
  const prepared = await sandbox.prepare({
    command: quoteArgv(argv),
    workspaceRoot,
    runTmp,
    allowedDomains: domains,
    extraWritePaths: Array.isArray(allowance?.writePaths) ? allowance.writePaths : [],
    weakerNetworkIsolation: allowance?.trustd === true,
    commandId,
    commandText,
    abortSignal,
  });
  if (!prepared) {
    const described = sandbox.describe();
    return {
      command: program,
      args: rest,
      isolation: {
        isolated: false,
        reason: described.reason || '',
        missing: Array.isArray(described.missing) ? described.missing : [],
      },
      ...PASSTHROUGH,
    };
  }
  return {
    command: prepared.command,
    args: prepared.args,
    env: prepared.env,
    isolation: {
      isolated: true,
      domains: prepared.domains,
      ...(Array.isArray(prepared.writePaths) && prepared.writePaths.length > 0 ? { writePaths: prepared.writePaths } : {}),
      ...(prepared.trustd === true ? { trustd: true } : {}),
    },
    annotate: prepared.annotate,
    release: prepared.release,
  };
}

module.exports = { planSpawn };
