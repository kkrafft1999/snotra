'use strict';

const { createHash, randomBytes } = require('crypto');
const { splitLines, diffLines, countChanges } = require('./line-diff');
const { readRegularFile } = require('./read-regular-file');

/**
 * What the agent changed, file by file (#348).
 *
 * The writing tools hand over the content before and after each write; this
 * keeps both, in memory only, so that the chat and the tree can show the
 * change afterwards. Nothing reaches the disk: a restart forgets every
 * snapshot, the same as the marks in the tree (#347) — decided in the issue
 * on 2026-10-02. Ids carry a boot id, so an id from before a restart is
 * recognised as such instead of looking like any unknown one.
 *
 * Memory is bounded twice: a file above `maxBytesPerFile` is recorded with
 * its sizes only and reported as too large, and the whole store keeps at most
 * `budgetBytes`, dropping the oldest changes first.
 */

const DEFAULT_MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
const DEFAULT_BUDGET_BYTES = 32 * 1024 * 1024;
/** Above this many lines on either side, a diff is not computed. */
const DEFAULT_MAX_LINES = 20000;
const MAX_IDS_PER_REQUEST = 500;

const STATUS = Object.freeze({
  TEXT: 'text',
  UNCHANGED: 'unchanged',
  EOL_ONLY: 'eol-only',
  BINARY: 'binary',
  TOO_LARGE: 'too-large',
});

const UNAVAILABLE = Object.freeze({
  RESTARTED: 'restarted',
  EVICTED: 'evicted',
  UNKNOWN: 'unknown',
});

const UTF8 = new TextDecoder('utf-8');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** The line ending a text uses: 'crlf', 'lf', 'cr', 'mixed' or null for none. */
function dominantEnding(endings) {
  const kinds = new Set(endings.filter(Boolean));
  if (kinds.size === 0) return null;
  if (kinds.size > 1) return 'mixed';
  const [only] = kinds;
  return only === '\r\n' ? 'crlf' : only === '\r' ? 'cr' : 'lf';
}

/**
 * Compares two snapshots. `before` is null for a file the call created.
 * `limits.maxLines` bounds the diff; the sizes are what the store measured.
 */
function analyze(before, after, { maxLines = DEFAULT_MAX_LINES } = {}) {
  const created = before === null;
  const base = {
    created,
    beforeBytes: created ? 0 : before.length,
    afterBytes: after.length,
  };
  if ((!created && before.includes(0)) || after.includes(0)) {
    return { ...base, status: STATUS.BINARY, added: 0, removed: 0 };
  }
  const old = splitLines(created ? '' : UTF8.decode(before));
  const next = splitLines(UTF8.decode(after));
  if (old.lines.length > maxLines || next.lines.length > maxLines) {
    return { ...base, status: STATUS.TOO_LARGE, reason: 'lines', limitLines: maxLines, added: 0, removed: 0 };
  }
  const sameLines = old.lines.length === next.lines.length && old.lines.every((line, i) => line === next.lines[i]);
  if (sameLines) {
    if (!created && before.equals(after)) return { ...base, status: STATUS.UNCHANGED, added: 0, removed: 0 };
    if (!created) {
      const from = dominantEnding(old.endings);
      const to = dominantEnding(next.endings);
      const finalNewline = old.trailingNewline === next.trailingNewline
        ? null
        : next.trailingNewline ? 'added' : 'removed';
      return {
        ...base,
        status: STATUS.EOL_ONLY,
        added: 0,
        removed: 0,
        lineCount: next.lines.length,
        eolChange: from !== to && from && to ? { from, to } : null,
        finalNewline,
      };
    }
  }
  const { segments, approximate } = diffLines(old.lines, next.lines);
  const { added, removed } = countChanges(segments);
  return {
    ...base,
    status: STATUS.TEXT,
    added,
    removed,
    // Every old line went: the view says so instead of a wall of − then +.
    rewritten: !created && old.lines.length > 1 && next.lines.length > 1
      && !segments.some((run) => run.op === 'equal'),
    approximate,
    segments,
    beforeLines: old.lines,
    afterLines: next.lines,
  };
}

/** What the chat line needs of a change, without any content. */
function summaryOf(entry, analysis) {
  return {
    id: entry.id,
    relativePath: entry.relativePath,
    status: analysis.status,
    created: analysis.created,
    added: analysis.added,
    removed: analysis.removed,
  };
}

function createFileChangeRecorder({
  fs,
  maxBytesPerFile = DEFAULT_MAX_BYTES_PER_FILE,
  budgetBytes = DEFAULT_BUDGET_BYTES,
  maxLines = DEFAULT_MAX_LINES,
  bootId = randomBytes(4).toString('hex'),
} = {}) {
  /** id → entry, oldest first (Map keeps insertion order). */
  const entries = new Map();
  /** Ids that were dropped for memory, so they can be told apart. */
  const evicted = new Set();
  let sequence = 0;
  let heldBytes = 0;

  function bytesOf(entry) {
    return (entry.before?.length || 0) + (entry.after?.length || 0);
  }

  function evictOverBudget() {
    for (const [id, entry] of entries) {
      if (heldBytes <= budgetBytes || entries.size <= 1) break;
      entries.delete(id);
      heldBytes -= bytesOf(entry);
      evicted.add(id);
    }
  }

  /**
   * A writing tool wrote a file. `before` is the old content (a Buffer), null
   * for a new file; a file too large to read before has `before: null` and
   * its size in `beforeBytes`. `after` is what was written.
   * Returns the summary for the chat line.
   */
  function record({ relativePath, absPath, before = null, beforeBytes = null, after }) {
    sequence += 1;
    const id = `${bootId}-${sequence}`;
    const afterBuffer = Buffer.isBuffer(after) ? after : Buffer.from(String(after ?? ''), 'utf8');
    const beforeTooLarge = before === null && Number.isFinite(beforeBytes);
    const tooLarge = beforeTooLarge
      || (before && before.length > maxBytesPerFile)
      || afterBuffer.length > maxBytesPerFile;
    const entry = {
      id,
      sequence,
      relativePath: String(relativePath ?? ''),
      absPath,
      before: tooLarge ? null : before,
      after: tooLarge ? null : afterBuffer,
      created: before === null && !beforeTooLarge,
      tooLarge: Boolean(tooLarge),
      beforeBytes: beforeTooLarge ? beforeBytes : before ? before.length : 0,
      afterBytes: afterBuffer.length,
      afterHash: sha256(afterBuffer),
    };
    const analysis = entry.tooLarge
      ? tooLargeAnalysis(entry, entry)
      : analyze(entry.created ? null : entry.before, entry.after, { maxLines });
    entry.summary = summaryOf(entry, analysis);
    entries.set(id, entry);
    heldBytes += bytesOf(entry);
    evictOverBudget();
    return entry.summary;
  }

  function tooLargeAnalysis(first, last) {
    return {
      status: STATUS.TOO_LARGE,
      reason: 'bytes',
      created: first.created,
      beforeBytes: first.beforeBytes,
      afterBytes: last.afterBytes,
      limitBytes: maxBytesPerFile,
      added: 0,
      removed: 0,
    };
  }

  function unavailableReason(id) {
    if (evicted.has(id)) return UNAVAILABLE.EVICTED;
    if (typeof id === 'string' && !id.startsWith(`${bootId}-`) && /^[0-9a-f]+-\d+$/.test(id)) {
      return UNAVAILABLE.RESTARTED;
    }
    return UNAVAILABLE.UNKNOWN;
  }

  /** Has the file on disk moved on from what the last change wrote? */
  async function changedSince(entry) {
    if (!fs || !entry.absPath) return null;
    try {
      const read = await readRegularFile(fs, entry.absPath, { maxBytes: Math.max(entry.afterBytes, 1) });
      if (read.notFile || read.tooLarge) return 'changed';
      return sha256(read.buffer) === entry.afterHash ? null : 'changed';
    } catch (err) {
      return err && err.code === 'ENOENT' ? 'deleted' : null;
    }
  }

  /**
   * The change made by `ids` — one call, or several to the same file, which
   * are combined: the content before the first against the content after the
   * last. Resolves to `{ ok: true, … }` or `{ ok: false, reason }`.
   */
  async function describe(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS_PER_REQUEST) {
      return { ok: false, reason: 'invalid' };
    }
    const found = [];
    for (const id of ids) {
      const entry = typeof id === 'string' ? entries.get(id) : null;
      if (!entry) return { ok: false, reason: unavailableReason(id) };
      found.push(entry);
    }
    found.sort((a, b) => a.sequence - b.sequence);
    const first = found[0];
    const last = found[found.length - 1];
    if (found.some((entry) => entry.absPath !== first.absPath)) return { ok: false, reason: 'invalid' };

    const analysis = first.tooLarge || last.tooLarge
      ? tooLargeAnalysis(first, last)
      : analyze(first.created ? null : first.before, last.after, { maxLines });
    return {
      ok: true,
      relativePath: last.relativePath,
      calls: found.length,
      changedSince: await changedSince(last),
      ...analysis,
    };
  }

  return {
    record,
    describe,
    /** For tests and diagnostics. */
    stats: () => ({ entries: entries.size, heldBytes }),
  };
}

module.exports = {
  createFileChangeRecorder,
  analyze,
  FILE_CHANGE_STATUS: STATUS,
  FILE_CHANGE_UNAVAILABLE: UNAVAILABLE,
};
