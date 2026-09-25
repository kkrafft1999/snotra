'use strict';

/**
 * Operating system isolation for `shell_execute` and `run_python` (#329).
 *
 * The runners stay in charge of their process — time limit, output cap,
 * process-tree kill, "Stop". This service only rewrites *what* they spawn:
 * the command goes through `@anthropic-ai/sandbox-runtime`, which puts it
 * under a generated Seatbelt profile on macOS (`sandbox-exec`) and into
 * `bubblewrap` with a removed network namespace on Linux. Network access runs
 * through a proxy in this process that only lets the allowed domains through.
 *
 * What a sandboxed run may do:
 * - write inside the workspace and its own temp directory, nowhere else;
 * - read everything except the credential and profile locations below;
 * - reach the network only for the domains its approval named.
 *
 * When isolation is not available — Windows, Linux without bubblewrap/socat/
 * ripgrep, a kernel that refuses unprivileged user namespaces (Ubuntu 24.04+
 * as shipped) — `prepare()` returns null and the runner falls back to the
 * unisolated flow. That is never silent: `describe()` says why, and the
 * approval card and the tool result carry it.
 *
 * Whether isolation works is decided by a **self-test**, not by the
 * library's dependency check. On Ubuntu 24.04 `initialize()` succeeds and
 * every single command then fails; only running one tells the difference
 * (spike on #329).
 */

const { normalizeDomains } = require('../../shared/runtime/sandbox-domains');

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

/** The Linux packages the runtime needs, as the distributions name them. */
const LINUX_PACKAGES = Object.freeze(['bubblewrap', 'socat', 'ripgrep']);

const LIMITS = Object.freeze({
  SELF_TEST_TIMEOUT_MS: 15_000,
  PIP_PROBE_TIMEOUT_MS: 10_000,
});

/**
 * Locations a sandboxed run must not read: keys, cloud and package-registry
 * credentials, browser profiles, the keychain, and Snotra's own settings and
 * key storage. `~` is expanded by the runtime.
 */
function sensitiveReadPaths({ platform, userDataPath } = {}) {
  const common = [
    '~/.ssh',
    '~/.gnupg',
    '~/.aws',
    '~/.azure',
    '~/.kube',
    '~/.docker',
    '~/.config/gcloud',
    '~/.config/gh',
    '~/.netrc',
    '~/.git-credentials',
    '~/.npmrc',
    '~/.pypirc',
    '~/.password-store',
  ];
  const perPlatform = platform === 'darwin'
    ? [
      '~/Library/Keychains',
      '~/Library/Cookies',
      '~/Library/Safari',
      '~/Library/Application Support/Google/Chrome',
      '~/Library/Application Support/Chromium',
      '~/Library/Application Support/BraveSoftware',
      '~/Library/Application Support/Microsoft Edge',
      '~/Library/Application Support/Arc',
      '~/Library/Application Support/Firefox',
    ]
    : [
      '~/.local/share/keyrings',
      '~/.config/google-chrome',
      '~/.config/chromium',
      '~/.config/BraveSoftware',
      '~/.config/microsoft-edge',
      '~/.mozilla',
    ];
  const own = typeof userDataPath === 'string' && userDataPath ? [userDataPath] : [];
  return [...common, ...perPlatform, ...own];
}

/**
 * Paths the runtime keeps writable by default for Claude Code's own use.
 * They have no business being writable for Snotra's runs.
 */
const DENY_WRITE_DEFAULTS = Object.freeze(['/tmp/claude', '~/.claude/debug']);

/** POSIX single-quoting, so an argv survives the trip through `sh -c`. */
function quoteArgv(argv) {
  return argv
    .map((arg) => {
      const value = String(arg);
      return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

/** `pip 24.2 from …` → [24, 2]; null when the output says nothing usable. */
function parsePipVersion(text) {
  const match = /\bpip\s+(\d+)\.(\d+)/.exec(String(text || ''));
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * pip ≥ 24.2 verifies TLS through the operating system's trust store
 * (`truststore`). On macOS that is the `trustd` service, which the Seatbelt
 * profile keeps closed — the library calls opening it a potential
 * exfiltration channel. `PIP_USE_DEPRECATED=legacy-certs` sends pip back to
 * its bundled certifi instead. Older pip rejects the value and aborts, hence
 * the version check (decision on #329).
 */
function needsLegacyCerts(version) {
  if (!Array.isArray(version)) return false;
  const [major, minor] = version;
  return major > 24 || (major === 24 && minor >= 2);
}

/**
 * The runtime resolves its vendored helpers (the Linux seccomp binary, the
 * JVM proxy agent) relative to its own module. Inside a packaged app that is
 * a path into `app.asar`, which no external process can open. The files are
 * unpacked next to the archive (`asar.unpack` in package.json); this points
 * the configuration there.
 */
function unpackedPath(filePath, exists) {
  if (typeof filePath !== 'string' || !/app\.asar[\\/]/.test(filePath)) return filePath;
  const candidate = filePath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return exists(candidate) ? candidate : filePath;
}

/** Which packages a dependency error list names, in distribution terms. */
function missingPackages(errors) {
  const text = (Array.isArray(errors) ? errors : []).join('\n').toLowerCase();
  const found = [];
  if (text.includes('bubblewrap') || text.includes('bwrap')) found.push('bubblewrap');
  if (text.includes('socat')) found.push('socat');
  if (text.includes('ripgrep') || /\brg\b/.test(text)) found.push('ripgrep');
  return found;
}

/**
 * The proxy consults one process-wide domain list per request; a per-call
 * configuration does not reach it (spike on #329). Runs with the same domain
 * set can share that list and run side by side — the common case is two runs
 * without any network. A run with a different set waits until the others are
 * done, so no run can ever reach a domain its card did not name. FIFO, so a
 * stream of same-set runs cannot starve a waiting one.
 */
function createDomainGate() {
  let activeKey = null;
  let active = 0;
  const waiting = [];

  function makeRelease() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      active -= 1;
      if (active === 0) activeKey = null;
      pump();
    };
  }

  function pump() {
    while (waiting.length > 0) {
      const next = waiting[0];
      if (active > 0 && next.key !== activeKey) return;
      waiting.shift();
      activeKey = next.key;
      active += 1;
      next.grant(makeRelease());
    }
  }

  function acquire(key, abortSignal) {
    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(abortError());
        return;
      }
      if (waiting.length === 0 && (active === 0 || key === activeKey)) {
        activeKey = key;
        active += 1;
        resolve(makeRelease());
        return;
      }
      const entry = { key, grant: null };
      const onAbort = () => {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1);
        reject(abortError());
        pump();
      };
      entry.grant = (release) => {
        abortSignal?.removeEventListener('abort', onAbort);
        resolve(release);
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(entry);
    });
  }

  return {
    acquire,
    snapshot: () => ({ activeKey, active, waiting: waiting.length }),
  };
}

function abortError() {
  const error = new Error('Aborted while waiting for the sandbox.');
  error.name = 'AbortError';
  return error;
}

/** A plain promise chain: one critical section at a time. */
function createMutex() {
  let tail = Promise.resolve();
  return function exclusive(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

/**
 * @param {object} deps
 * @param {string} [deps.platform]
 * @param {typeof import('os')} deps.os
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs/promises')} deps.fs
 * @param {(p: string) => boolean} [deps.existsSync]
 * @param {typeof import('child_process').spawn} deps.spawn
 * @param {() => any} [deps.loadRuntime]  returns the sandbox-runtime module
 * @param {string} [deps.userDataPath]    Snotra's settings and key storage
 * @param {() => Promise<string>} [deps.readShellPath]   PATH from the profile (#111)
 * @param {() => Promise<string>} [deps.readPythonCommand]  interpreter for the pip check
 * @param {NodeJS.ProcessEnv} [deps.env]
 */
function createSandboxService({
  platform = process.platform,
  os,
  path,
  fs,
  existsSync = () => false,
  spawn,
  loadRuntime = () => require('@anthropic-ai/sandbox-runtime'),
  userDataPath = '',
  readShellPath = async () => '',
  readPythonCommand = async () => 'python3',
  env = process.env,
}) {
  let state = { status: 'unknown' };
  let runtime = null;
  let pipLegacyCerts = false;
  let detection = null;
  const gate = createDomainGate();
  const exclusive = createMutex();

  function vendorPaths() {
    const out = {};
    try {
      const root = path.dirname(path.dirname(require.resolve('@anthropic-ai/sandbox-runtime')));
      const jar = path.join(root, 'vendor', 'java-proxy-agent', 'srt-proxy-agent.jar');
      const resolvedJar = unpackedPath(jar, existsSync);
      if (resolvedJar !== jar) out.javaAgentJarPath = resolvedJar;
      if (platform === 'linux') {
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        const seccomp = path.join(root, 'vendor', 'seccomp', arch, 'apply-seccomp');
        const resolvedSeccomp = unpackedPath(seccomp, existsSync);
        if (resolvedSeccomp !== seccomp) out.seccomp = { applyPath: resolvedSeccomp };
      }
    } catch {
      /* not resolvable (tests with a fake runtime) — the defaults apply */
    }
    return out;
  }

  /** The complete runtime configuration for one run. */
  function buildConfig({ workspaceRoot = '', runTmp = '', allowedDomains = [] } = {}) {
    const allowWrite = [workspaceRoot, runTmp].filter((p) => typeof p === 'string' && p);
    return {
      network: { allowedDomains: normalizeDomains(allowedDomains), deniedDomains: [] },
      filesystem: {
        denyRead: sensitiveReadPaths({ platform, userDataPath }),
        allowWrite,
        denyWrite: [...DENY_WRITE_DEFAULTS],
      },
      ...vendorPaths(),
    };
  }

  /**
   * Environment additions for a run: caches into its temp dir, pip's CA.
   * TMPDIR is not among them — the runtime overrides it inside the sandbox,
   * see `prepare()`.
   */
  function runEnv(runTmp) {
    const extra = {
      PIP_CACHE_DIR: path.join(runTmp, 'cache', 'pip'),
      npm_config_cache: path.join(runTmp, 'cache', 'npm'),
      XDG_CACHE_HOME: path.join(runTmp, 'cache'),
    };
    if (pipLegacyCerts) extra.PIP_USE_DEPRECATED = 'legacy-certs';
    return extra;
  }

  function spawnAndWait(command, args, { cwd, childEnv, timeoutMs }) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        resolve({ code: null, out: '', err: e?.message || 'spawn failed' });
        return;
      }
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }, timeoutMs);
      child.stdout?.on('data', (c) => { out += String(c); });
      child.stderr?.on('data', (c) => { err += String(c); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: err || e?.message || '' }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
  }

  async function shellEnv() {
    const shellPath = String((await readShellPath()) || '').trim();
    return shellPath ? { ...env, PATH: shellPath } : env;
  }

  /** pip version of the interpreter the tools will use — macOS only. */
  async function detectPipLegacyCerts() {
    if (platform !== 'darwin') return false;
    try {
      const python = String((await readPythonCommand()) || '').trim() || 'python3';
      const result = await spawnAndWait(python, ['-m', 'pip', '--version'], {
        cwd: os.homedir(),
        childEnv: await shellEnv(),
        timeoutMs: LIMITS.PIP_PROBE_TIMEOUT_MS,
      });
      return result.code === 0 && needsLegacyCerts(parsePipVersion(result.out));
    } catch {
      return false;
    }
  }

  /**
   * Runs two commands through the real sandbox: one that must succeed and
   * one that must be refused. Both halves matter — on Ubuntu 24.04 "refused"
   * alone would pass because nothing runs at all.
   */
  async function selfTest() {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-sandbox-selftest-'));
    const allowed = path.join(base, 'allowed');
    const outside = path.join(base, 'outside');
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    const probeFile = path.join(outside, 'probe.txt');
    try {
      const attempt = async (command) => {
        const prepared = await prepare({ command, workspaceRoot: '', runTmp: allowed, allowedDomains: [], skipDetect: true });
        try {
          return await spawnAndWait(prepared.command, prepared.args, {
            cwd: allowed,
            childEnv: { ...env, ...prepared.env },
            timeoutMs: LIMITS.SELF_TEST_TIMEOUT_MS,
          });
        } finally {
          prepared.release();
        }
      };
      const ok = await attempt(`echo ok > ${quoteArgv([path.join(allowed, 'ok.txt')])}`);
      if (ok.code !== 0) {
        return { ok: false, detail: firstLine(ok.err) || `exit ${ok.code}` };
      }
      const denied = await attempt(`echo x > ${quoteArgv([probeFile])}`);
      const leaked = await fs.stat(probeFile).then(() => true, () => false);
      if (denied.code === 0 || leaked) {
        return { ok: false, detail: 'A write outside the allowed folders was not refused.' };
      }
      return { ok: true };
    } finally {
      await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function runDetection() {
    if (platform !== 'darwin' && platform !== 'linux') {
      state = { status: 'unavailable', reason: SANDBOX_REASONS.PLATFORM, platform };
      return describe();
    }
    try {
      runtime = loadRuntime();
    } catch (e) {
      state = { status: 'unavailable', reason: SANDBOX_REASONS.START, platform, detail: firstLine(e?.message) };
      return describe();
    }
    const manager = runtime.SandboxManager;
    let deps;
    try {
      deps = manager.checkDependencies();
    } catch (e) {
      deps = { errors: [e?.message || 'dependency check failed'] };
    }
    if (Array.isArray(deps?.errors) && deps.errors.length > 0) {
      const missing = missingPackages(deps.errors);
      state = {
        status: 'unavailable',
        reason: missing.length > 0 ? SANDBOX_REASONS.DEPENDENCIES : SANDBOX_REASONS.START,
        platform,
        missing,
        detail: firstLine(deps.errors.join('; ')),
      };
      return describe();
    }
    try {
      await manager.initialize(buildConfig({}));
    } catch (e) {
      state = { status: 'unavailable', reason: SANDBOX_REASONS.START, platform, detail: firstLine(e?.message) };
      return describe();
    }
    state = { status: 'testing', platform };
    const result = await selfTest().catch((e) => ({ ok: false, detail: firstLine(e?.message) }));
    if (!result.ok) {
      state = { status: 'unavailable', reason: SANDBOX_REASONS.SELF_TEST, platform, detail: result.detail };
      await manager.reset?.().catch?.(() => {});
      return describe();
    }
    pipLegacyCerts = await detectPipLegacyCerts();
    state = { status: 'isolated', platform };
    return describe();
  }

  /** Detection runs once per app start, like the shell detection (#111). */
  function detect() {
    if (!detection) detection = runDetection();
    return detection;
  }

  function describe() {
    return {
      isolated: state.status === 'isolated',
      status: state.status,
      reason: state.reason || '',
      platform: state.platform || platform,
      missing: Array.isArray(state.missing) ? [...state.missing] : [],
      detail: state.detail || '',
      pipLegacyCerts,
    };
  }

  /**
   * Wraps one command. Returns what to spawn — `/bin/sh -c <wrapped>` plus
   * environment additions — or null when the run is not isolated. The caller
   * must call `release()` once its process has closed; until then the
   * domain allowance of this run stays in force.
   *
   * @param {object} request
   * @param {string} request.command   a complete shell command line
   * @param {string} [request.workspaceRoot]
   * @param {string} request.runTmp    the run's own temp directory
   * @param {string[]} [request.allowedDomains]
   * @param {string} [request.commandId]
   * @param {string} [request.commandText]  what the user sees, for violations
   * @param {AbortSignal} [request.abortSignal]
   */
  async function prepare({
    command,
    workspaceRoot = '',
    runTmp,
    allowedDomains = [],
    commandId,
    commandText,
    abortSignal,
    skipDetect = false,
  } = {}) {
    if (!skipDetect) {
      await detect();
      if (state.status !== 'isolated') return null;
    }
    const domains = normalizeDomains(allowedDomains);
    const key = [...domains].sort().join(',');
    const release = await gate.acquire(key, abortSignal);
    const manager = runtime.SandboxManager;
    const config = buildConfig({ workspaceRoot, runTmp, allowedDomains: domains });
    // The runtime sets TMPDIR to its own /tmp/claude, a directory every run
    // (and Claude Code) shares and Snotra keeps closed. The run's temp dir
    // takes its place — assigned inside, after the runtime's assignment.
    const inner = runTmp ? `export TMPDIR=${quoteArgv([runTmp])}; ${command}` : command;
    let wrapped;
    try {
      // Filesystem rules are compiled at wrap time, so update and wrap must
      // not interleave with another run's update.
      wrapped = await exclusive(async () => {
        manager.updateConfig(config);
        return manager.wrapWithSandbox(inner, '/bin/sh', undefined, abortSignal, {
          ...(commandId ? { commandId } : {}),
          ...(commandText ? { commandText } : {}),
        });
      });
    } catch (e) {
      release();
      throw e;
    }
    let released = false;
    return {
      command: '/bin/sh',
      args: ['-c', wrapped],
      env: runEnv(runTmp),
      domains,
      release() {
        if (released) return;
        released = true;
        try { manager.cleanupAfterCommand?.(); } catch { /* best effort */ }
        release();
      },
      annotate(stderr) {
        try {
          return manager.annotateStderrWithSandboxFailures(commandId || inner, String(stderr ?? ''));
        } catch {
          return String(stderr ?? '');
        }
      },
    };
  }

  async function shutdown() {
    if (runtime?.SandboxManager?.reset) {
      await runtime.SandboxManager.reset().catch(() => {});
    }
  }

  return {
    detect,
    describe,
    isAvailable: () => state.status === 'isolated',
    prepare,
    shutdown,
    buildConfig,
  };
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0].slice(0, 300);
}

module.exports = {
  createSandboxService,
  createDomainGate,
  normalizeDomains,
  quoteArgv,
  parsePipVersion,
  needsLegacyCerts,
  unpackedPath,
  missingPackages,
  sensitiveReadPaths,
  SANDBOX_REASONS,
  LINUX_PACKAGES,
  DENY_WRITE_DEFAULTS,
};
