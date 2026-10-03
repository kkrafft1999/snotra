'use strict';

/**
 * A line diff for "Show changes" (#348): Myers' O(ND) algorithm over lines.
 *
 * Own code instead of a library: the diff is computed in the main process,
 * which holds the snapshots, and the app has no runtime dependency that
 * would carry one. What it does is small enough to test in full.
 *
 * Lines are compared without their line ending. A file whose only change is
 * CRLF → LF compares equal here, and the caller reports that on its own
 * instead of showing every line as changed.
 */

/**
 * The edit distance at which the search gives up. Beyond it the middle part
 * (after trimming the common start and end) is shown as removed, then added:
 * still a correct diff, only not the shortest one. The bound keeps a rewritten
 * 2 MiB file from blocking the main process; memory grows with its square.
 */
const MAX_EDIT_DISTANCE = 1000;

/**
 * Splits text into lines without their endings. A final line ending does not
 * start an empty last line; `trailingNewline` says whether there was one.
 * `endings` holds each line's own ending ('' for a last line without one).
 */
function splitLines(text) {
  const source = typeof text === 'string' ? text : '';
  const lines = [];
  const endings = [];
  const pattern = /\r\n|\r|\n/g;
  let start = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    lines.push(source.slice(start, match.index));
    endings.push(match[0]);
    start = match.index + match[0].length;
  }
  const trailingNewline = start === source.length && lines.length > 0;
  if (start < source.length) {
    lines.push(source.slice(start));
    endings.push('');
  }
  return { lines, endings, trailingNewline };
}

/** Appends `count` of `op`, merging with the run before it. */
function pushRun(segments, op, count) {
  if (count <= 0) return;
  const last = segments[segments.length - 1];
  if (last && last.op === op) last.count += count;
  else segments.push({ op, count });
}

/**
 * The shortest edit script between two line arrays of the middle part, as
 * runs, or null when it needs more than `maxD` edits.
 */
function myersRuns(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds V[-d..d] after step d — a band, so memory is O(D²).
  const trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Walk back from the end; the ops come out in reverse.
  const reversed = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const at = (k) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push('equal');
      x -= 1;
      y -= 1;
    }
    if (down) {
      reversed.push('insert');
      y -= 1;
    } else {
      reversed.push('delete');
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push('equal');
    x -= 1;
    y -= 1;
  }
  const runs = [];
  for (let i = reversed.length - 1; i >= 0; i -= 1) pushRun(runs, reversed[i], 1);
  return runs;
}

/**
 * Diffs two line arrays. Returns runs `{ op: 'equal'|'delete'|'insert', count }`
 * in order — deletions of a change before its insertions — and whether the
 * search gave up (`approximate`).
 */
function diffLines(before, after, { maxEditDistance = MAX_EDIT_DISTANCE } = {}) {
  const a = Array.isArray(before) ? before : [];
  const b = Array.isArray(after) ? after : [];
  // Integers compare faster than strings, and a long line is compared once.
  const ids = new Map();
  const idOf = (line) => {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    return id;
  };
  const ai = a.map(idOf);
  const bi = b.map(idOf);

  let prefix = 0;
  while (prefix < ai.length && prefix < bi.length && ai[prefix] === bi[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < ai.length - prefix
    && suffix < bi.length - prefix
    && ai[ai.length - 1 - suffix] === bi[bi.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const midA = ai.slice(prefix, ai.length - suffix);
  const midB = bi.slice(prefix, bi.length - suffix);

  const segments = [];
  pushRun(segments, 'equal', prefix);
  let approximate = false;
  if (midA.length === 0 || midB.length === 0) {
    pushRun(segments, 'delete', midA.length);
    pushRun(segments, 'insert', midB.length);
  } else {
    const runs = myersRuns(midA, midB, maxEditDistance);
    if (runs) {
      for (const run of runs) pushRun(segments, run.op, run.count);
    } else {
      approximate = true;
      pushRun(segments, 'delete', midA.length);
      pushRun(segments, 'insert', midB.length);
    }
  }
  pushRun(segments, 'equal', suffix);
  return { segments: orderChanges(segments), approximate };
}

/**
 * Myers may yield insert-then-delete within one change; the view reads
 * better with what went first. Swaps neighbouring insert/delete runs.
 */
function orderChanges(segments) {
  const out = [];
  let i = 0;
  while (i < segments.length) {
    if (segments[i].op === 'equal') {
      out.push(segments[i]);
      i += 1;
      continue;
    }
    let deleted = 0;
    let inserted = 0;
    while (i < segments.length && segments[i].op !== 'equal') {
      if (segments[i].op === 'delete') deleted += segments[i].count;
      else inserted += segments[i].count;
      i += 1;
    }
    pushRun(out, 'delete', deleted);
    pushRun(out, 'insert', inserted);
  }
  return out;
}

/** Lines added and removed, from the runs. */
function countChanges(segments) {
  let added = 0;
  let removed = 0;
  for (const run of segments) {
    if (run.op === 'insert') added += run.count;
    else if (run.op === 'delete') removed += run.count;
  }
  return { added, removed };
}

module.exports = {
  MAX_EDIT_DISTANCE,
  splitLines,
  diffLines,
  countChanges,
};
