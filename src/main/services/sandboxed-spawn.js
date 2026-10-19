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

/**
 * What `planSpawn` takes from the sandbox service (`sandbox-service.js`): the
 * command to start instead of the plain one, and what to do once it is over.
 *
 * @typedef {(request: { target: string, allow: string[] }, options?: { signal?: AbortSignal }) => Promise<{ outcome: string, pattern?: string }>} NetworkAsk
 *
 * @typedef {Object} PreparedSandbox
 * @property {string} command
 * @property {string[]} args
 * @property {NodeJS.ProcessEnv} env
 * @property {string[]} domains
 * @property {string[]} [writePaths]  what a program allowance added
 * @property {boolean} [trustd]
 * @property {(stderr: string) => string} annotate
 * @property {(options?: { failed?: boolean, output?: string }) => Promise<object|null>} [blocked]
 * @property {() => void} release
 *
 * @typedef {Object} SandboxPrepareRequest
 * @property {string} [command]  a complete shell command line; without one nothing runs
 * @property {string} [workspaceRoot]
 * @property {string} [runTmp]
 * @property {string[]} [allowedDomains]
 * @property {string[]} [extraWritePaths]
 * @property {boolean} [weakerNetworkIsolation]
 * @property {object|null} [grants]
 * @property {string} [commandId]
 * @property {string} [commandText]
 * @property {NetworkAsk|null} [onNetworkAsk]
 * @property {(() => {stdout: string, stderr: string} | null) | null} [readOutput]
 * @property {AbortSignal} [abortSignal]
 *
 * @typedef {{
 *   prepare(request: SandboxPrepareRequest): Promise<PreparedSandbox|null>,
 *   describe(): { reason?: string, missing?: string[] },
 * }} SandboxForSpawn
 *
 * @typedef {Object} SpawnPlan
 * @property {string} command
 * @property {string[]} args
 * @property {NodeJS.ProcessEnv} env
 * @property {null|{isolated: boolean, domains?: string[], writePaths?: string[], trustd?: boolean,
 *   reason?: string, missing?: string[]}} isolation
 * @property {(s: string) => string} annotate
 * @property {(o?: {failed?: boolean, output?: string}) => Promise<object|null>} blocked
 * @property {() => void} release
 */

/** @type {Pick<SpawnPlan, 'env' | 'annotate' | 'blocked' | 'release'>} */
const PASSTHROUGH = Object.freeze({
  env: Object.freeze({}),
  annotate: (/** @type {string} */ stderr) => stderr,
  blocked: async () => null,
  release: () => {},
});

/**
 * @param {object} request
 * @param {SandboxForSpawn|null} request.sandbox       the sandbox service, if wired
 * @param {boolean} [request.disabled]         switched off for this workspace (#357)
 * @param {string[]} request.argv             [program, ...args]
 * @param {string} [request.workspaceRoot]
 * @param {string} request.runTmp
 * @param {string[]} [request.domains]
 * @param {{writePaths?: string[], trustd?: boolean}|null} [request.allowance]  a program allowance (#408)
 * @param {Object|null} [request.grants]     what the user allowed on a sandbox card (#792)
 * @param {string} [request.commandId]
 * @param {string} [request.commandText]
 * @param {NetworkAsk | null} [request.onNetworkAsk]  asks about a waiting connection (#792)
 * @param {(() => {stdout: string, stderr: string} | null) | null} [request.readOutput]  what the command printed so far, for that question
 * @param {AbortSignal} [request.abortSignal]
 * @returns {Promise<SpawnPlan>}
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
  // What the user allowed on a sandbox card (#792): writable folders and
  // protected paths opened for this run.
  grants = null,
  commandId,
  commandText,
  onNetworkAsk = null,
  readOutput = null,
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
    grants,
    commandId,
    commandText,
    onNetworkAsk,
    readOutput,
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
    // What the sandbox refused (#792); a stand-in without it refuses nothing.
    blocked: typeof prepared.blocked === 'function' ? prepared.blocked : PASSTHROUGH.blocked,
    release: prepared.release,
  };
}

module.exports = { planSpawn };
