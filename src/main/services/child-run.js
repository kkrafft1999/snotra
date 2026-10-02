'use strict';

/**
 * One child process of the shell or Python runner, from spawn to its end
 * (#86/#102): hard time limit, "Stop", output cap, stdin as a string, and the
 * kill of the whole process tree. Both runners carried their own copy of this
 * until the code review of block B03 found the same two bugs in both
 * (CR-B03-01, CR-B03-02).
 *
 * The child gets a process group of its own on POSIX (`detached`), so that one
 * signal reaches everything it started. Windows has no such group;
 * `taskkill /T` walks the tree from the parent instead.
 */

const { createOutputSink } = require('./child-output-sink');

/**
 * @param {object} deps
 * @param {typeof import('child_process').spawn} deps.spawn
 * @param {string} [deps.platform]
 */
function createChildRunner({ spawn, platform = process.platform }) {
  // The stop of every child still running, for `disposeSync()` (#506).
  const running = new Set();

  /** Ends the process tree — a command almost always starts children of its own. */
  function killTree(child) {
    if (!child || child.killed) return;
    try {
      if (platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  /**
   * Whatever is left in the process group once its leader has exited: a
   * process the command put into the background (CR-B03-01). It would outlive
   * the time limit, "Stop" and the app, and inside the sandbox it would keep
   * using the network proxy after the run's domain allowance has passed to
   * the next run. Ended here, before the run counts as finished.
   *
   * POSIX only. On Windows the parent is gone by now and `taskkill /T` has no
   * tree left to walk; a process that leaves the group on purpose (`setsid`)
   * escapes on every platform — the security concept says so (§9).
   */
  function killLeftovers(child) {
    if (platform === 'win32' || !Number.isInteger(child?.pid)) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is empty */ }
  }

  /**
   * @param {object} request
   * @param {string} request.command
   * @param {string[]} request.args
   * @param {string} request.cwd
   * @param {NodeJS.ProcessEnv} request.env
   * @param {string} [request.stdin]
   * @param {number} request.maxStdinChars
   * @param {number} request.maxOutputBytes   per stream
   * @param {number} request.timeoutMs
   * @param {AbortSignal} [request.abortSignal]
   * @param {string} request.startError       the sentence when the spawn fails without a message
   * @returns {Promise<{error: string} | {stdout: string, stderr: string, exitCode: number|null,
   *   timedOut: boolean, aborted: boolean, truncated: boolean}>}
   */
  function run({
    command,
    args,
    cwd,
    env,
    stdin,
    maxStdinChars,
    maxOutputBytes,
    timeoutMs,
    abortSignal,
    startError,
  }) {
    const stdout = createOutputSink(maxOutputBytes);
    const stderr = createOutputSink(maxOutputBytes);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: platform !== 'win32',
          env,
          // Snotra has no console of its own; without this every command
          // flashes a console window on Windows (CR-B16-01, as in #442).
          windowsHide: true,
        });
      } catch (e) {
        resolve({ error: e?.message || startError });
        return;
      }

      let timedOut = false;
      let aborted = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);

      const onAbort = () => {
        aborted = true;
        killTree(child);
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      running.add(onAbort);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        running.delete(onAbort);
        resolve(result);
      };

      child.stdout?.on('data', (chunk) => stdout.push(chunk));
      child.stderr?.on('data', (chunk) => stderr.push(chunk));
      child.on('error', (e) => finish({ error: e?.message || startError }));
      // `exit` comes when the leader is gone, `close` only once every holder
      // of its output has let go — a background process keeps that open.
      child.on('exit', () => killLeftovers(child));
      child.on('close', (exitCode) => finish({
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        timedOut,
        aborted,
        truncated: stdout.truncated || stderr.truncated,
      }));

      // A command that exits before reading its input breaks the pipe; that
      // is not an error of the run, and unheard it would be an uncaught
      // exception in the main process (CR-B03-02).
      child.stdin?.on?.('error', () => {});
      // No TTY: whatever waits for input gets at most the given string, and
      // then an end of file.
      if (typeof stdin === 'string' && stdin) {
        child.stdin?.end(stdin.slice(0, maxStdinChars));
      } else {
        child.stdin?.end();
      }
      if (abortSignal?.aborted) onAbort();
    });
  }

  /**
   * For the app quitting (#506): ends every child still running, at once and
   * synchronously, as `mcpService.disposeSync()` does for the MCP servers.
   * The child runs in a process group of its own and the timeout timer lives
   * in this process — without this it would outlive the app.
   */
  function disposeSync() {
    for (const stop of [...running]) stop();
    running.clear();
  }

  return { run, disposeSync };
}

module.exports = { createChildRunner };
