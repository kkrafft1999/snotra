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
const { isPathInside } = require('../../shared/runtime/path-inside');
const { summarizeViolations, describeForModel, widerFolder } = require('./sandbox-violations');

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
 * credentials, CLI token stores, shell and REPL histories, other AI tools'
 * credentials, browser and mail profiles, the keychain, and Snotra's own
 * settings and key storage. `~` is expanded by the runtime.
 *
 * Files that ordinary builds read stay readable even where they may hold a
 * credential (`~/.m2/settings.xml`, `~/.gradle/gradle.properties`) — denying
 * them would break `mvn` and `gradle` inside the sandbox (CR-B03-04).
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
    // CLI token stores (CR-B03-04)
    '~/.config/op',
    '~/.vault-token',
    '~/.terraform.d',
    '~/.cargo/credentials',
    '~/.cargo/credentials.toml',
    '~/.gem/credentials',
    '~/.config/hub',
    '~/.config/glab-cli',
    '~/.config/hcloud',
    '~/.config/doctl',
    '~/.oci',
    '~/.databrickscfg',
    '~/.pgpass',
    '~/.my.cnf',
    '~/.config/rclone',
    // Shell and REPL histories: where `export TOKEN=…` ends up. The runs are
    // not interactive and never need them (CR-B03-04).
    '~/.zsh_history',
    '~/.bash_history',
    '~/.local/share/fish/fish_history',
    '~/.python_history',
    '~/.node_repl_history',
    '~/.psql_history',
    '~/.mysql_history',
    // Other AI tools, with API keys or OAuth tokens in their files (CR-B03-04)
    '~/.claude.json',
    '~/.claude/.credentials.json',
    '~/.codex',
    '~/.config/github-copilot',
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
      '~/Library/Application Support/Vivaldi',
      '~/Library/Application Support/com.operasoftware.Opera',
      '~/Library/Thunderbird',
      '~/Library/Mail',
      '~/Library/Messages',
    ]
    : [
      '~/.local/share/keyrings',
      '~/.config/google-chrome',
      '~/.config/chromium',
      '~/.config/BraveSoftware',
      '~/.config/microsoft-edge',
      '~/.config/vivaldi',
      '~/.config/opera',
      '~/.mozilla',
      '~/.thunderbird',
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
 * @param {number} [deps.violationSettleMs]  how long a finished run waits for late violations
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
  // The Seatbelt monitor reads `log stream` in a child process, so a refusal
  // can still be on its way when the run's process has closed (#792). In
  // practice it is there already; the wait is a margin, not a measurement.
  violationSettleMs = platform === 'darwin' ? 100 : 0,
  /**
   * Folders a run may never write, even when the open folder contains them:
   * the global skill folders (#548, #650). Opened as `~`, the workspace would
   * otherwise make them writable for every command.
   */
  protectedWritePaths = [],
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

  const expandHome = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
  const around = (a, b) => isPathInside(path, a, b) || isPathInside(path, b, a);

  /**
   * Whether a write the sandbox refused may be allowed on its card (#792).
   * Never the root, the home folder or anything above it, nothing in or
   * around Snotra's own storage, the protected locations or the global skill
   * folders — the same lines a program allowance may not cross (#408), and
   * ones a model must not get a user to cross by a convincing error message.
   */
  function isGrantableWritePath(target) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
    const p = path.resolve(target);
    if (p === path.parse(p).root || isPathInside(path, p, os.homedir()) || isAlwaysUnwritable(p)) return false;
    const guarded = [userDataPath, ...sensitiveReadPaths({ platform, userDataPath }), ...protectedWritePaths]
      .filter((entry) => typeof entry === 'string' && entry)
      .map((entry) => path.resolve(expandHome(entry)));
    return !guarded.some((guard) => around(guard, p) || around(guard, privateAlias(p)));
  }

  /**
   * Whether a refused read may be allowed: a protected location may be
   * opened for a run, Snotra's own storage never — the keys of its providers
   * stay in the app, whatever the user is asked.
   */
  function isGrantableReadPath(target) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
    const p = path.resolve(target);
    if (p === path.parse(p).root || isPathInside(path, p, os.homedir())) return false;
    if (!userDataPath) return true;
    const own = path.resolve(userDataPath);
    return !around(own, p) && !around(own, privateAlias(p));
  }

  const exists = (p) => fs.stat(p).then(() => true, () => false);

  /**
   * What the card may offer for each blocked resource (#792): the path
   * itself and, for a write, the folder one level up. An entry without
   * options can only be shown, not allowed.
   *
   * bubblewrap can only open a path that exists. On Linux a missing path is
   * therefore offered only when the program was making it a folder — Snotra
   * creates it before the retry — and a file that does not exist yet is
   * offered as the folder it was to go into.
   */
  async function grantOptions(entry) {
    if (entry.kind === 'write') {
      // No folder around it would help: the runtime refuses it inside any.
      if (isAlwaysUnwritable(entry.target)) return [];
      let target = entry.target;
      const makesFolder = entry.folder === true
        || (Array.isArray(entry.operations) && entry.operations.some((op) => /^mkdir/.test(op)));
      if (platform === 'linux' && !makesFolder && !(await exists(target))) target = path.dirname(target);
      const wider = widerFolder(target, os.homedir());
      return [target, wider].filter((p, i, all) => p && isGrantableWritePath(p) && all.indexOf(p) === i);
    }
    if (entry.kind === 'read') return isGrantableReadPath(entry.target) ? [entry.target] : [];
    return [];
  }

  /** On Linux, the granted folders that do not exist yet are made before the run (see grantOptions). */
  async function makeGrantedFolders(grants) {
    if (platform !== 'linux' || !Array.isArray(grants?.writePaths)) return;
    for (const folder of grants.writePaths.filter(isGrantableWritePath)) {
      if (!(await exists(folder))) await fs.mkdir(folder, { recursive: true }).catch(() => {});
    }
  }

  /**
   * The complete runtime configuration for one run. A program allowance
   * (#408) adds its folders to the writable ones and, on macOS only, opens
   * the trust service for certificate checks.
   */
  function buildConfig({
    workspaceRoot = '',
    runTmp = '',
    allowedDomains = [],
    extraWritePaths = [],
    weakerNetworkIsolation = false,
    grants = null,
  } = {}) {
    // What the user allowed on a sandbox card (#792), checked again here: the
    // card offered only grantable paths, and nothing else gets through.
    const grantedWrites = (Array.isArray(grants?.writePaths) ? grants.writePaths : []).filter(isGrantableWritePath);
    const grantedReads = (Array.isArray(grants?.readPaths) ? grants.readPaths : []).filter(isGrantableReadPath);
    const allowWrite = [workspaceRoot, runTmp, ...(Array.isArray(extraWritePaths) ? extraWritePaths : []), ...grantedWrites]
      .filter((p, index, all) => typeof p === 'string' && p && all.indexOf(p) === index);
    // A protected folder is denied only where a writable folder contains it —
    // elsewhere it is not writable anyway, and on Linux the runtime would
    // mount /dev/null over a missing one for every run. A program allowance
    // that names the folder itself, or a folder inside it, is the user's
    // explicit decision and wins; the open folder merely containing it does
    // not (#650).
    const extras = Array.isArray(extraWritePaths) ? extraWritePaths.filter((p) => typeof p === 'string' && p) : [];
    const protectedPaths = (Array.isArray(protectedWritePaths) ? protectedWritePaths : [])
      .filter((p) => typeof p === 'string' && p)
      .filter((p) => allowWrite.some((dir) => isPathInside(path, dir, p)))
      .filter((p) => !extras.some((extra) => isPathInside(path, p, extra)));
    return {
      network: { allowedDomains: normalizeDomains(allowedDomains), deniedDomains: [] },
      filesystem: {
        denyRead: sensitiveReadPaths({ platform, userDataPath }),
        ...(grantedReads.length ? { allowRead: [...new Set(grantedReads)] } : {}),
        allowWrite,
        denyWrite: [...DENY_WRITE_DEFAULTS, ...protectedPaths],
      },
      ...(platform === 'darwin' && weakerNetworkIsolation === true ? { enableWeakerNetworkIsolation: true } : {}),
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
      // With the monitor, refused writes and reads are recorded per run, not
      // only refused connections (#792): Seatbelt's log on macOS, the seccomp
      // observer on Linux.
      await manager.initialize(buildConfig({}), undefined, true);
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
   * @param {string[]} [request.extraWritePaths]  a program allowance's folders (#408)
   * @param {boolean} [request.weakerNetworkIsolation]  a program allowance's trustd (#408)
   * @param {{writePaths?: string[], readPaths?: string[]}} [request.grants]  allowed on a sandbox card (#792)
   * @param {string} [request.commandId]
   * @param {string} [request.commandText]  what the user sees, for violations
   * @param {AbortSignal} [request.abortSignal]
   */
  async function prepare({
    command,
    workspaceRoot = '',
    runTmp,
    allowedDomains = [],
    extraWritePaths = [],
    weakerNetworkIsolation = false,
    grants = null,
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
    await makeGrantedFolders(grants);
    const config = buildConfig({ workspaceRoot, runTmp, allowedDomains: domains, extraWritePaths, weakerNetworkIsolation, grants });
    const trustd = config.enableWeakerNetworkIsolation === true;
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
    let proxyPort;
    try { proxyPort = manager.getProxyPort?.(); } catch { /* no proxy, nothing to name */ }
    const collector = collectViolations(manager, commandId || inner);
    const isPermittedWrite = collector ? await writeRules(config.filesystem) : undefined;
    /** undefined until `blocked()` has looked; then the summary or null. */
    let summary;
    const summarize = () => summarizeViolations(collector.lines, { homeDir: os.homedir(), isPermittedWrite });
    let released = false;
    return {
      command: '/bin/sh',
      args: ['-c', wrapped],
      env: runEnv(runTmp),
      domains,
      // What a program allowance added (#408), as the run actually got it.
      writePaths: config.filesystem.allowWrite.filter((p) => p !== workspaceRoot && p !== runTmp),
      trustd,
      release() {
        if (released) return;
        released = true;
        collector?.stop();
        try { manager.cleanupAfterCommand?.(); } catch { /* best effort */ }
        release();
      },
      /**
       * What the sandbox refused during this run (#792), or null. Called once
       * the process has closed, before `annotate()`. A run that failed is the
       * likely victim of a refusal and waits longer for late lines.
       */
      async blocked({ failed = false, output = '' } = {}) {
        if (summary !== undefined) return summary;
        if (!collector) {
          summary = null;
          return summary;
        }
        const refused = failed && PERMISSION_ERROR.test(String(output || ''));
        await settleViolations(collector, { settleMs: violationSettleMs, failed, refused });
        summary = summarize();
        if (summary) {
          for (const entry of summary.entries) entry.allow = await grantOptions(entry);
        }
        return summary;
      },
      annotate(stderr) {
        let text = String(stderr ?? '');
        if (collector) {
          // In place of the runtime's raw lines, which with the monitor on
          // also carry the system queries every run makes.
          const note = describeForModel(summary === undefined ? summarize() : summary);
          if (note) text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${note}\n`;
        } else {
          try {
            text = manager.annotateStderrWithSandboxFailures(commandId || inner, text);
          } catch { /* keep stderr as it is */ }
        }
        text = annotateUnreachableProxy(text, proxyPort);
        return platform === 'darwin' && !trustd ? annotateBlockedTrustd(text) : text;
      },
    };
  }

  /**
   * Whether this run was allowed to write to a path: inside one of its
   * writable folders and not inside a protected one (#792). Each folder in
   * both spellings, as given and resolved — the Linux observer reports the
   * path the kernel saw.
   */
  async function writeRules({ allowWrite = [], denyWrite = [] }) {
    const home = os.homedir();
    const spellings = async (list) => {
      const out = [];
      for (const raw of list) {
        if (typeof raw !== 'string' || !raw || /[*?[]/.test(raw)) continue;
        const p = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
        out.push(p);
        const real = await fs.realpath(p).catch(() => p);
        if (real !== p) out.push(real);
      }
      return out;
    };
    // bubblewrap mounts its own /dev and /proc, writable, and the observer
    // still reports writes there.
    const writable = [...(await spellings(allowWrite)), '/dev', '/proc'];
    const protectedDirs = await spellings(denyWrite);
    return (target) => writable.some((dir) => isPathInside(path, dir, target))
      && !protectedDirs.some((dir) => isPathInside(path, dir, target));
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
    isGrantableWritePath,
    isGrantableReadPath,
  };
}

/**
 * Files and folders the runtime keeps unwritable inside every writable folder
 * (its DANGEROUS_FILES and dangerous directories, not exported): a card that
 * opened one would only see the retry refused again (#792). Compared in lower
 * case, as the runtime does.
 */
const ALWAYS_UNWRITABLE_FILES = new Set([
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json',
]);
const ALWAYS_UNWRITABLE_DIRS = ['.vscode', '.idea', '.claude/commands', '.claude/agents', '.git/hooks', '.git/config'];

function isAlwaysUnwritable(p) {
  const lower = p.toLowerCase();
  if (ALWAYS_UNWRITABLE_FILES.has(lower.split('/').pop())) return true;
  return ALWAYS_UNWRITABLE_DIRS.some((dir) => lower.endsWith(`/${dir}`) || lower.includes(`/${dir}/`));
}

/** `/private/var/x` for `/var/x` and back: macOS links /var, /tmp and /etc into /private. */
function privateAlias(p) {
  const m = /^\/private(\/(?:var|tmp|etc)(?:\/.*)?)$/.exec(p);
  if (m) return m[1];
  return /^\/(?:var|tmp|etc)(?:\/|$)/.test(p) ? `/private${p}` : p;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A failed run waits up to this many times the settle time for late lines. */
const FAILED_RUN_SETTLE_FACTOR = 6;
/** One whose own output says it was not permitted something waits up to this many. */
const REFUSED_RUN_SETTLE_FACTOR = 20;
/** What a program prints when the system refused it something. */
const PERMISSION_ERROR = /operation not permitted|permission denied|\bEPERM\b|\bEACCES\b/i;
/** Lines that have stopped arriving for this long are taken as complete. */
const VIOLATIONS_QUIET_MS = 50;

/**
 * Waits for refusals still on their way (#792). Seatbelt's lines come
 * through `log stream`, a child process; under load they arrive a few hundred
 * milliseconds after the run's process has closed. Every run waits the
 * settle time. A failed run waits longer: until lines have come and gone
 * quiet, or six times the settle time when none come at all — twenty when
 * the program itself reported a refused permission, where a line is all but
 * certain to come.
 */
async function settleViolations(collector, { settleMs, failed, refused = false }) {
  if (!(settleMs > 0)) return;
  const started = Date.now();
  await pause(settleMs);
  if (!failed) return;
  const longest = settleMs * (refused ? REFUSED_RUN_SETTLE_FACTOR : FAILED_RUN_SETTLE_FACTOR);
  while (Date.now() - started < longest) {
    if (collector.lines.length > 0 && Date.now() - collector.lastAt() >= VIOLATIONS_QUIET_MS) return;
    await pause(VIOLATIONS_QUIET_MS / 2);
  }
}

/** The runtime's SANDBOXED_COMMAND_KEY_LENGTH: how much of a command key a violation carries. */
const COMMAND_KEY_LENGTH = 100;
/** Lines one run keeps; past that, a run is not going to be read line by line. */
const MAX_COLLECTED_VIOLATIONS = 1000;

/**
 * Collects one run's violations as they arrive (#792). The runtime keeps the
 * last 100 of all runs together, which a single pip install fills with cache
 * writes, so the run keeps its own. Null when the runtime has no store to
 * listen to; the run then falls back to the runtime's own annotation.
 */
function collectViolations(manager, key) {
  let store = null;
  try {
    store = manager.getSandboxViolationStore?.() || null;
  } catch {
    store = null;
  }
  if (!store || typeof store.subscribe !== 'function' || typeof store.getTotalCount !== 'function') return null;
  const wanted = String(key).slice(0, COMMAND_KEY_LENGTH);
  const lines = [];
  let lastAt = 0;
  let seen = store.getTotalCount();
  // The store calls back after every single addition, with its whole tail.
  const unsubscribe = store.subscribe((list) => {
    const total = store.getTotalCount();
    const fresh = Math.min(total - seen, Array.isArray(list) ? list.length : 0);
    seen = total;
    if (fresh <= 0) return;
    for (const violation of list.slice(-fresh)) {
      if (lines.length < MAX_COLLECTED_VIOLATIONS && decodeCommandKey(violation?.encodedCommand) === wanted) {
        lines.push(String(violation.line ?? ''));
        lastAt = Date.now();
      }
    }
  });
  return {
    lines,
    lastAt: () => lastAt,
    stop() {
      try { unsubscribe(); } catch { /* already gone */ }
    },
  };
}

function decodeCommandKey(encoded) {
  if (typeof encoded !== 'string' || !encoded) return '';
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0].slice(0, 300);
}

/**
 * A command that cannot reach the sandbox's own network proxy fails with an
 * ordinary connection error — curl's "Failed to connect to localhost port …"
 * reads as if the target host were down (#368). The runtime records nothing
 * in that case, so the run says it here: nothing left the sandbox, and the
 * cause is the proxy, not the host. Only an error naming the proxy port, or a
 * client's own "cannot connect to proxy", counts; anything else stays as it is.
 *
 * @param {string} stderr  already annotated by the runtime
 * @param {number|undefined} proxyPort
 */
function annotateUnreachableProxy(stderr, proxyPort) {
  const text = String(stderr ?? '');
  if (!Number.isInteger(proxyPort) || text.includes('<sandbox_network>')) return text;
  const namesPort = new RegExp(`(?:port\\s+|:)${proxyPort}\\b`).test(text)
    && /connect|refused|not permitted/i.test(text);
  const namesProxy = /(?:unable to|cannot|can't|could not) connect to (?:the )?proxy/i.test(text);
  if (!namesPort && !namesProxy) return text;
  const note = `The sandbox's network proxy on localhost:${proxyPort} did not accept the connection, `
    + 'so this command could not reach the network at all. This is a problem of the sandbox, '
    + 'not a sign that the target host is down.';
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n<sandbox_network>\n${note}\n</sandbox_network>\n`;
}

/**
 * Go's certificate check on macOS asks the system trust service, which the
 * sandbox keeps closed; the check then fails with `OSStatus -26276`
 * (errSecInternalComponent) before a single byte reaches the host (#408).
 * Without a word the model reads that as a broken certificate or a host that
 * is down, so the run says what happened and where the user can change it.
 */
function annotateBlockedTrustd(stderr) {
  const text = String(stderr ?? '');
  if (!/x509: OSStatus -26276\b/.test(text) || text.includes('<sandbox_certificates>')) return text;
  const note = 'The certificate check was refused inside the sandbox: this program verifies certificates '
    + 'through the macOS trust service (trustd), which the sandbox keeps closed. The host was not reached. '
    + 'If the user trusts the program, they can allow certificate checks for it under Settings › Tools & security › '
    + 'Execute › Program allowances. Tell them that instead of working around it.';
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n<sandbox_certificates>\n${note}\n</sandbox_certificates>\n`;
}

module.exports = {
  createSandboxService,
  annotateBlockedTrustd,
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
