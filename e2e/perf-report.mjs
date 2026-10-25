// Measures the performance budgets PERF-1 to PERF-4 of
// docs/architecture/quality-requirements.md in the real app (#984). Not a test: it reports
// numbers and never fails on a missed budget unless asked to — only a
// measurement that breaks fails the run. `.github/workflows/perf.yml` runs it
// on every push to main; docs/development/test-concept.md describes what it covers.
//
//   npm run perf -- [--runs=5] [--strict] [--out=out/perf]
//
// --runs    measured starts for PERF-1, after one warm-up start (default 5)
// --strict  exit 1 when a budget is missed, for a local check
// --out     where report.json and report.md go (default out/perf)
//
// One fixture for all four: 200 chats in the history, one of them 200
// messages long, and a workspace with 2000 folders (e2e/helpers/perf-fixture.mjs).
//
// PERF-1  main process created → the renderer's `snotra:ready` mark (folder
//         and chat restored, src/renderer/app.js), median of the runs.
// PERF-2  the worst of: Event Timing while typing into the composer of the
//         long chat, and click → long chat on screen and painted (3 switches).
// PERF-3  the longest animation frame (long-animation-frame) during a 50 KB
//         streamed answer and while a folder with more than 2000 entries opens.
// PERF-4  app.getAppMetrics(), working set summed over all processes, after
//         10 s idle with a chat open — once after the start, once after the
//         scenarios above; the budget is held against the higher one.

import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { startFakeModel } from './helpers/fake-model.mjs';
import { composerState, launchApp, makeTempDir, poll, prepareUserData, sendChat } from './helpers/app.mjs';
import {
  ACTIVE_CHAT_END, LONG_CHAT_END, MANY_ENTRIES, STREAM_END,
  longAnswer, writeLargeWorkspace, writeSeededHistory,
} from './helpers/perf-fixture.mjs';

const require = createRequire(import.meta.url);
const { evaluate, markdownTable, max, median } = require('../scripts/perf-budgets.js');

const { values: options } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    strict: { type: 'boolean', default: false },
    out: { type: 'string', default: 'out/perf' },
  },
});
const RUNS = Math.max(1, Number.parseInt(options.runs, 10) || 5);
const IDLE_MS = 10_000;
const SWITCHES = 3;
const STREAM_BYTES = 50 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const log = (line) => process.stderr.write(`[perf] ${line}\n`);

/**
 * Collects long animation frames and slow events in the renderer from here
 * on. `buffered` brings in what happened before — the frames of the start,
 * when it is called right after the launch.
 */
async function observe(page) {
  return page.evaluate(() => {
    const perf = { loafs: [], events: [], pointerDownAt: null };
    window.__snotraPerf = perf;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.loafs.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration });
    }).observe({ type: 'long-animation-frame', buffered: true });
    // 16 ms is the lowest threshold Event Timing allows; anything faster is
    // not reported at all and counts as instant.
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.events.push({ name: e.name, start: e.startTime, duration: e.duration });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
    document.addEventListener('pointerdown', (event) => { perf.pointerDownAt = event.timeStamp; }, true);
    return PerformanceObserver.supportedEntryTypes.filter((type) => type === 'long-animation-frame' || type === 'event');
  });
}

const now = (page) => page.evaluate(() => performance.now());

/**
 * Blocks one frame for 150 ms on purpose and checks that the observer reports
 * it. A window that draws no frames — occluded, or a runner without a working
 * compositor (#331) — would otherwise report no long frame at all, and
 * "nothing over 500 ms" would pass for a kept budget.
 */
async function probeFrameObserver(page) {
  const seen = await page.evaluate(async () => {
    const from = performance.now();
    await new Promise((resolve) => requestAnimationFrame(() => {
      const until = performance.now() + 150;
      while (performance.now() < until) { /* busy on purpose */ }
      resolve();
    }));
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      // A frame starts with its first task, and that is this very script:
      // the frame begins a moment before `from`, so it is matched by its end.
      const found = window.__snotraPerf.loafs.find((e) => e.start + e.duration >= from && e.duration >= 140);
      if (found) return found.duration;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  });
  if (seen == null) throw new Error('the long-animation-frame observer missed a deliberate 150 ms frame — no frame numbers would be trustworthy');
  return Math.round(seen);
}

/**
 * What the observers saw since `since` (renderer time): every entry that ends
 * after it. A frame or an event that began in the task taking `since` starts
 * a moment before it.
 */
function seenSince(page, since) {
  return page.evaluate((from) => ({
    loafs: window.__snotraPerf.loafs.filter((e) => e.start + e.duration >= from),
    events: window.__snotraPerf.events.filter((e) => e.start + e.duration >= from),
  }), since);
}

function frameSummary(loafs) {
  return {
    longestFrameMs: round(max(loafs.map((e) => e.duration))) ?? 0,
    // Every long animation frame is over 50 ms by definition.
    framesOver50ms: loafs.length,
    framesOver200ms: loafs.filter((e) => e.duration > 200).length,
    framesOver500ms: loafs.filter((e) => e.duration > 500).length,
    totalBlockingMs: round(loafs.reduce((sum, e) => sum + (e.blocking || 0), 0)),
  };
}

/** A trusted click in the middle of the element — no Playwright actionability waits (see app.mjs). */
async function clickCenter(page, selector) {
  const point = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  if (!point) throw new Error(`nothing to click: ${selector}`);
  await page.mouse.click(point.x, point.y);
}

/** Resolves in the renderer once `marker` ends the last message and a frame has been painted after it. */
function waitForChatOnScreen(page, marker, what) {
  return page.evaluate(async ({ marker: end, what: label }) => {
    const deadline = performance.now() + 60_000;
    const lastText = () => [...document.querySelectorAll('#chat-messages > li.chat-msg')].at(-1)?.textContent ?? '';
    while (!lastText().includes(end)) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // The next frame draws it; the task after that frame runs after the paint.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    return performance.now();
  }, { marker, what });
}

async function memory(app) {
  const processes = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((m) => ({
    type: m.type,
    workingSetKB: m.memory.workingSetSize,
    privateKB: m.memory.privateBytes ?? null,
  })));
  const sum = (key) => processes.reduce((total, p) => total + (p[key] ?? 0), 0) / 1024;
  return {
    workingSetMB: round(sum('workingSetKB')),
    privateMB: processes.every((p) => p.privateKB != null) ? round(sum('privateKB')) : null,
    processes: processes.length,
  };
}

async function readyTiming(snotra) {
  const createdAt = await snotra.app.evaluate(() => process.getCreationTime());
  const marks = await poll(() => snotra.page.evaluate(() => {
    const ready = performance.getEntriesByName('snotra:ready')[0];
    if (!ready) return null;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      readyAt: performance.timeOrigin + ready.startTime,
      firstPaintAt: fcp ? performance.timeOrigin + fcp.startTime : null,
    };
  }), { what: 'the snotra:ready mark', timeoutMs: 60_000 });
  return {
    readyMs: round(marks.readyAt - createdAt),
    firstPaintMs: marks.firstPaintAt ? round(marks.firstPaintAt - createdAt) : null,
  };
}

function machine() {
  const commit = process.env.GITHUB_SHA || (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
  })();
  return {
    platform: process.platform,
    arch: process.arch,
    ci: Boolean(process.env.CI),
    cpu: os.cpus()[0]?.model ?? null,
    cpus: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1024 ** 3),
    electron: require('electron/package.json').version,
    commit,
  };
}

// ── Fixture ────────────────────────────────────────────────────────────────

const model = await startFakeModel();
const workspace = await realpath(await makeTempDir('snotra-perf-workspace-'));
const userDataDir = await makeTempDir('snotra-perf-userdata-');
log('writing the fixture');
const { many } = await writeLargeWorkspace(workspace);
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en', chatHistoryVisible: true }), 'utf8');
const history = await writeSeededHistory(userDataDir, workspace);

const report = {
  machine: machine(),
  fixture: { sessions: 200, longChatMessages: 200, historyBytes: history.bytes, watchedFolders: 2000, folderEntries: MANY_ENTRIES, streamBytes: STREAM_BYTES },
  measurements: {},
};

let snotra = null;
try {
  // ── PERF-1: starts ───────────────────────────────────────────────────────
  // The first start encrypts the seeded history and fills the file cache; it
  // is not counted.
  log('warm-up start');
  snotra = await launchApp({ userDataDir });
  await readyTiming(snotra);
  await snotra.stop();
  snotra = null;

  const starts = [];
  for (let run = 1; run <= RUNS; run += 1) {
    snotra = await launchApp({ userDataDir });
    starts.push(await readyTiming(snotra));
    log(`start ${run}/${RUNS}: ready after ${starts.at(-1).readyMs} ms`);
    if (run < RUNS) {
      await snotra.stop();
      snotra = null;
    }
  }
  report.measurements.start = {
    runs: starts,
    medianReadyMs: round(median(starts.map((s) => s.readyMs))),
    medianFirstPaintMs: round(median(starts.map((s) => s.firstPaintMs))),
  };

  // The last start stays open for everything else.
  const { app, page } = snotra;
  const supported = await observe(page);
  if (supported.length < 2) throw new Error(`this Chromium lacks ${['long-animation-frame', 'event'].filter((t) => !supported.includes(t)).join(' and ')}`);
  report.measurements.startFrames = frameSummary((await seenSince(page, 0)).loafs);
  report.measurements.probeFrameMs = await probeFrameObserver(page);

  // ── PERF-4, first sample: idle right after the start ─────────────────────
  await sleep(IDLE_MS);
  const idleAfterStart = await memory(app);
  log(`idle after start: ${idleAfterStart.workingSetMB} MB`);

  // ── PERF-2: chat switches ────────────────────────────────────────────────
  const rowSelector = (id) => `#chat-history-list .chat-history-row[data-chat-id="${id}"] .chat-history-row-main`;
  await poll(() => page.evaluate((sel) => !!document.querySelector(sel), rowSelector(history.longId)), { what: 'the long chat in the history list' });
  const switches = [];
  const switchStart = await now(page);
  for (let i = 0; i < SWITCHES; i += 1) {
    await clickCenter(page, rowSelector(history.longId));
    const paintedAt = await waitForChatOnScreen(page, LONG_CHAT_END, 'the long chat');
    const clickedAt = await page.evaluate(() => window.__snotraPerf.pointerDownAt);
    switches.push(round(paintedAt - clickedAt));
    log(`switch ${i + 1}/${SWITCHES} to the long chat: ${switches.at(-1)} ms`);
    if (i < SWITCHES - 1) {
      await clickCenter(page, rowSelector(history.activeId));
      await waitForChatOnScreen(page, ACTIVE_CHAT_END, 'the active chat');
    }
  }
  const switchEvents = (await seenSince(page, switchStart)).events;

  // ── PERF-2: typing, into the composer below the long chat ────────────────
  await page.evaluate(() => document.getElementById('chat-input').focus());
  const typingStart = await now(page);
  await page.keyboard.type('Please summarise the open points of this thread in three bullets.', { delay: 25 });
  const typing = await seenSince(page, typingStart);
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const keyEvents = typing.events.filter((e) => /^key|input$/.test(e.name));
  report.measurements.input = {
    switchToLongChatMs: switches,
    medianSwitchMs: round(median(switches)),
    slowestSwitchEventMs: round(max(switchEvents.map((e) => e.duration))) ?? 0,
    slowestKeyEventMs: round(max(keyEvents.map((e) => e.duration))) ?? 0,
    slowKeyEvents: keyEvents.length,
    typingFrames: frameSummary(typing.loafs),
  };

  // ── PERF-3: a 50 KB answer streams into a new chat ───────────────────────
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  await poll(() => page.evaluate((end) => !document.getElementById('chat-messages').textContent.includes(end), LONG_CHAT_END), { what: 'the new chat' });
  model.queueAnswer({ match: 'perf-stream-request', text: longAnswer(STREAM_BYTES), chunkDelayMs: 1 });
  const streamStart = await now(page);
  const streamStartedAt = Date.now();
  await sendChat(page, 'Write the long overview (perf-stream-request)');
  await waitForChatOnScreen(page, STREAM_END, 'the end of the streamed answer');
  await poll(async () => (await composerState(page))?.running === false, { what: 'the run to end', timeoutMs: 60_000 });
  const stream = await seenSince(page, streamStart);
  report.measurements.stream = { durationMs: Date.now() - streamStartedAt, ...frameSummary(stream.loafs) };
  log(`stream: longest frame ${report.measurements.stream.longestFrameMs} ms`);

  // ── PERF-3: a folder with more entries than a listing shows opens ────────
  const manyRow = await page.evaluate((p) => {
    const row = [...document.querySelectorAll('#tree-container .tree-item')].find((el) => el.dataset.path === p);
    return row ? `#tree-container .tree-item[data-path="${CSS.escape(p)}"]` : null;
  }, many);
  if (!manyRow) throw new Error(`the folder ${many} is not in the tree`);
  const treeStart = await now(page);
  await clickCenter(page, manyRow);
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length >= 2000), { what: 'the large folder listed', timeoutMs: 60_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
  const tree = await seenSince(page, treeStart);
  report.measurements.largeFolder = frameSummary(tree.loafs);
  log(`large folder: longest frame ${report.measurements.largeFolder.longestFrameMs} ms`);

  // ── PERF-4, second sample: idle with a chat open, after use ──────────────
  await clickCenter(page, rowSelector(history.activeId));
  await waitForChatOnScreen(page, ACTIVE_CHAT_END, 'the active chat');
  await sleep(IDLE_MS);
  const idleAfterUse = await memory(app);
  log(`idle after use: ${idleAfterUse.workingSetMB} MB`);
  report.measurements.memory = { idleAfterStart, idleAfterUse };
} finally {
  await snotra?.stop().catch(() => {});
  await model.close();
}

// ── Against the budgets ──────────────────────────────────────────────────────

const m = report.measurements;
report.budgets = evaluate({
  'PERF-1': m.start.medianReadyMs,
  'PERF-2': max([m.input.medianSwitchMs, m.input.slowestKeyEventMs]),
  'PERF-3': max([m.stream.longestFrameMs, m.largeFolder.longestFrameMs]),
  'PERF-4': max([m.memory.idleAfterStart.workingSetMB, m.memory.idleAfterUse.workingSetMB]),
}, report.machine);

const details = [
  `- **PERF-1:** ready after ${m.start.runs.map((s) => s.readyMs).join(' / ')} ms (median ${m.start.medianReadyMs}), first paint median ${m.start.medianFirstPaintMs ?? '—'} ms; longest frame during the start ${m.startFrames.longestFrameMs} ms.`,
  `- **PERF-2:** switch to the 200-message chat ${m.input.switchToLongChatMs.join(' / ')} ms (median ${m.input.medianSwitchMs}); slowest key event ${m.input.slowestKeyEventMs || '< 16'} ms.`,
  `- **PERF-3:** 50 KB stream in ${m.stream.durationMs} ms, longest frame ${m.stream.longestFrameMs} ms, ${m.stream.framesOver50ms} frames over 50 ms, ${m.stream.framesOver200ms} over 200 ms, ${m.stream.totalBlockingMs} ms blocking; opening ${MANY_ENTRIES} entries: longest frame ${m.largeFolder.longestFrameMs} ms, ${m.largeFolder.framesOver50ms} over 50 ms. Probe frame seen at ${m.probeFrameMs} ms.`,
  `- **PERF-4:** working set ${m.memory.idleAfterStart.workingSetMB} MB after the start, ${m.memory.idleAfterUse.workingSetMB} MB after use (${m.memory.idleAfterUse.processes} processes${m.memory.idleAfterUse.privateMB != null ? `, private ${m.memory.idleAfterUse.privateMB} MB` : ''}).`,
];
const where = report.machine;
const markdown = [
  `### Performance budgets — ${where.platform}/${where.arch}${where.ci ? ' (CI)' : ''}`,
  '',
  markdownTable(report.budgets),
  '',
  ...details,
  '',
  `<sub>${where.cpu ?? 'unknown CPU'}, ${where.cpus} cores, ${where.memoryGB} GB · Electron ${where.electron} · ${where.commit ? where.commit.slice(0, 7) : 'no commit'} · time budgets ×${report.budgets[0].limit / 3000} on this machine</sub>`,
  '',
].join('\n');

await mkdir(options.out, { recursive: true });
await writeFile(path.join(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(path.join(options.out, 'report.md'), markdown, 'utf8');
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
process.stdout.write(markdown);

if (options.strict && report.budgets.some((row) => row.ok === false)) process.exitCode = 1;
