// The workspace watcher against the real file system, the way files are
// really written (#648).
//
// Every overwrite by `write_file_text`, `edit_file` and `apply_patch` goes
// through `writeFileAtomic` — a temporary file renamed onto the target —, and
// git swaps `HEAD.lock` onto `HEAD` the same way. On Linux, Node's emulated
// `recursive: true` lost every such file after its first replacement: the
// append that followed and the deletion after it were never reported, and
// only the first of three branch switches was. This runs in the CI of all
// three systems; on Linux it drives the folder-by-folder watch.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');
const nodeFs = require('fs');
const os = require('os');

const { createWorkspaceWatcher } = require('../src/main/services/workspace-watcher');
const { createFsService } = require('../src/main/services/fs-service');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The runs: the platform's own way, and — on macOS, where it can be watched
 * live — the Linux way on a real file system as well. Windows is left out of
 * the second: a folder with a watch of its own cannot be removed there while
 * the watch is open, which is the platform's business, not this test's.
 */
const MODES = [{ label: 'the platform watch', platform: process.platform }];
if (process.platform === 'darwin') MODES.push({ label: 'the folder-by-folder watch', platform: 'linux' });

for (const { label, platform } of MODES) {
  test(`${label}: an atomic overwrite, an append, a deletion and three branch switches are all reported (#648)`, { timeout: 60000 }, async (t) => {
    const root = await nodeFs.promises.realpath(
      await nodeFs.promises.mkdtemp(nodePath.join(os.tmpdir(), 'snotra-ws-real-'))
    );
    const notes = nodePath.join(root, 'notes');
    const gitDir = nodePath.join(root, '.git');
    await nodeFs.promises.mkdir(notes, { recursive: true });
    await nodeFs.promises.mkdir(gitDir, { recursive: true });
    await nodeFs.promises.writeFile(nodePath.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const reports = [];
    let lastReportAt = Date.now();
    const watcher = createWorkspaceWatcher({
      watch: nodeFs.watch,
      path: nodePath,
      realpath: nodeFs.realpathSync.native,
      platform,
      onChange: (payload) => {
        reports.push(payload);
        lastReportAt = Date.now();
      },
      // The question is whether `fs.watch` reports each change, not whether
      // the report after the start (#478) would cover for it.
      startRecheckMs: 0,
    });
    const fsService = createFsService({
      fs: nodeFs.promises,
      path: nodePath,
      maxReadFileBytes: 1024 * 1024,
      maxWriteFileBytes: 1024 * 1024,
    });
    t.after(async () => {
      watcher.close();
      await nodeFs.promises.rm(root, { recursive: true, force: true });
    });

    const writeAtomically = async (content) => {
      const result = JSON.parse(
        await fsService.runWriteFileTextTool({ relative_path: 'notes/plan.md', content }, root, {
          recovery: { allowUnrecoverable: true },
        })
      );
      assert.equal(result.error, undefined, JSON.stringify(result));
    };
    const namesNotes = (report) => report.directories.includes(notes);
    const isIncomplete = (report) => report.complete === false;

    /** Polls for a report since `from` that matches — no fixed sleep decides. */
    const reportSince = async (from, matches, what, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (reports.slice(from).some(matches)) return;
        await sleep(25);
      }
      assert.fail(`${label}: no report for ${what} within ${timeoutMs} ms: ${JSON.stringify(reports.slice(from))}`);
    };
    /** Waits until nothing has been reported for a while, so one step's report is not taken for the next. */
    const quiet = async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() - lastReportAt < 700 && Date.now() < deadline) await sleep(50);
    };
    const step = async (what, change, matches = namesNotes) => {
      await quiet();
      const from = reports.length;
      await change();
      await reportSince(from, matches, what);
    };

    watcher.watchWorkspace(root);

    // Right after `fs.watch()` a change can be lost for good (macOS, #465),
    // and on Linux the watch on `notes/` is set a moment later. So the first
    // write is repeated until one is reported; from then on the watch is
    // known to be live, and every later step has to be reported first time.
    const liveBy = Date.now() + 15000;
    for (let attempt = 0; ; attempt += 1) {
      const from = reports.length;
      await writeAtomically(`v0-${attempt}`);
      try {
        await reportSince(from, namesNotes, 'the first write', 1000);
        break;
      } catch (error) {
        if (Date.now() > liveBy) throw error;
      }
    }

    await step('an atomic overwrite', () => writeAtomically('v1'));
    await step('an append after the overwrite', () =>
      nodeFs.promises.appendFile(nodePath.join(notes, 'plan.md'), 'more\n'));
    await step('the deletion', () => nodeFs.promises.rm(nodePath.join(notes, 'plan.md')));

    for (const branch of ['feature', 'main', 'fix']) {
      await step(
        `the switch to ${branch} (HEAD.lock -> HEAD)`,
        async () => {
          await nodeFs.promises.writeFile(nodePath.join(gitDir, 'HEAD.lock'), `ref: refs/heads/${branch}\n`);
          await nodeFs.promises.rename(nodePath.join(gitDir, 'HEAD.lock'), nodePath.join(gitDir, 'HEAD'));
        },
        isIncomplete
      );
    }
  });
}
