// What the sandbox refused during a message's shell and Python runs (#792):
// a box right under the tool log, open by default, with one line per blocked
// resource — what kind, which path or host, why — and the raw sandbox lines
// folded away. Decided on 2026-10-08 from a mockup with three variants
// (strip, marker in the row, box). The colour stays neutral: amber means
// "runs without isolation" and red a real error, and this is neither.
import contracts from '../generated/contracts.js';
import { toolLineText } from '../utils/tool-log-summary.js';
import { tildePath } from '../utils/program-allowance-view.js';
import { t, tPlural } from '../i18n.js';

const { normalizeSandboxBlocked } = contracts;

const SHIELD_OFF_ICON_HTML =
  '<svg class="chat-sandbox-blocked-icon" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M8 1.8 3.2 3.6v3.9c0 3 2.1 5.4 4.8 6.4 2.7-1 4.8-3.4 4.8-6.4V3.6z"/>'
  + '<path d="M2.6 2.6l10.8 10.8"/></svg>';

const DENY_LIST_REASON = 'host is on the deny list';

/** The runs of a trace that the sandbox refused something in, in order. */
export function blockedRunsOf(trace) {
  if (!Array.isArray(trace)) return [];
  const runs = [];
  for (const entry of trace) {
    const blocked = normalizeSandboxBlocked(entry?.sandboxBlocked);
    if (blocked) runs.push({ line: toolLineText(entry), blocked });
  }
  return runs;
}

function reasonOf(entry) {
  if (entry.kind === 'network' && entry.reason === DENY_LIST_REASON) return t('toolLog.sandbox.reason.networkDenied');
  return t(`toolLog.sandbox.reason.${entry.kind}`);
}

/**
 * `~/…` for a path in the home folder. Seatbelt reports the resolved path,
 * so a home under `/var` or `/tmp` (macOS links them into `/private`) comes
 * back as `/private/var/…`.
 */
function homePath(target, homeDir) {
  const shown = tildePath(target, homeDir);
  if (shown !== target || !/^\/(var|tmp)\//.test(homeDir)) return shown;
  return tildePath(target, `/private${homeDir}`);
}

/** "~/Library/Caches/pip/ · 37 paths", "example.com:443 · 3 times". */
function targetText(entry, homeDir) {
  const isPath = entry.kind === 'write' || entry.kind === 'read';
  const shown = isPath ? homePath(entry.target, homeDir) : entry.target;
  if (entry.folder) return `${shown}/ · ${tPlural('toolLog.sandbox.paths', entry.count, { count: entry.count })}`;
  if (!isPath && entry.count > 1) return `${shown} · ${tPlural('toolLog.sandbox.times', entry.count, { count: entry.count })}`;
  return shown;
}

function buildEntry(entry, homeDir) {
  const item = document.createElement('li');
  item.className = 'chat-sandbox-blocked-entry';
  item.dataset.kind = entry.kind;
  const kind = document.createElement('span');
  kind.className = 'chat-sandbox-blocked-kind';
  kind.textContent = t(`toolLog.sandbox.kind.${entry.kind}`);
  const target = document.createElement('span');
  target.className = 'chat-sandbox-blocked-target';
  target.textContent = targetText(entry, homeDir);
  if (entry.target !== target.textContent) target.title = entry.target;
  const reason = document.createElement('span');
  reason.className = 'chat-sandbox-blocked-reason';
  reason.textContent = reasonOf(entry);
  item.append(kind, target, reason);
  return item;
}

function buildRun(run, homeDir, { withLine }) {
  const part = document.createDocumentFragment();
  if (withLine) {
    const line = document.createElement('p');
    line.className = 'chat-sandbox-blocked-run';
    line.textContent = run.line;
    part.append(line);
  }
  const list = document.createElement('ul');
  list.className = 'chat-sandbox-blocked-list';
  for (const entry of run.blocked.entries) list.append(buildEntry(entry, homeDir));
  if (run.blocked.moreEntries > 0) {
    const more = document.createElement('li');
    more.className = 'chat-sandbox-blocked-more';
    more.textContent = t('toolLog.sandbox.more', { count: run.blocked.moreEntries });
    list.append(more);
  }
  part.append(list);
  if (run.blocked.raw.length) {
    const raw = document.createElement('details');
    raw.className = 'chat-sandbox-blocked-raw';
    const summary = document.createElement('summary');
    summary.textContent = t('toolLog.sandbox.raw');
    const pre = document.createElement('pre');
    pre.textContent = run.blocked.raw.join('\n');
    // It scrolls past a dozen lines, so it takes the keyboard too.
    pre.tabIndex = 0;
    raw.append(summary, pre);
    part.append(raw);
  }
  return part;
}

let boxIds = 0;

/**
 * The box for `runs` (from `blockedRunsOf`), or null when nothing was
 * blocked. One run names its command in the title; several get a line each.
 */
export function buildSandboxBlockedBox(runs, { homeDir = '' } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const box = document.createElement('div');
  box.className = 'chat-sandbox-blocked';
  box.setAttribute('role', 'group');
  const titleId = `chat-sandbox-blocked-title-${(boxIds += 1)}`;
  box.setAttribute('aria-labelledby', titleId);

  const resources = runs.reduce((sum, run) => sum + run.blocked.entries.length + run.blocked.moreEntries, 0);
  const title = document.createElement('p');
  title.className = 'chat-sandbox-blocked-title';
  title.id = titleId;
  title.insertAdjacentHTML('afterbegin', SHIELD_OFF_ICON_HTML);
  const heading = document.createElement('span');
  heading.className = 'chat-sandbox-blocked-heading';
  heading.textContent = tPlural('toolLog.sandbox.title', resources, { count: resources });
  title.append(heading);
  const context = document.createElement('span');
  context.className = 'chat-sandbox-blocked-context';
  context.textContent = runs.length === 1 ? `· ${runs[0].line}` : `· ${t('toolLog.sandbox.inRuns', { count: runs.length })}`;
  title.append(context);
  box.append(title);

  for (const run of runs) box.append(buildRun(run, homeDir, { withLine: runs.length > 1 }));
  return box;
}

/**
 * Puts the box right under the tool log of `messageEl`, or takes it away.
 * It comes before the changed files and the generated images: it explains
 * the steps above it.
 */
export function syncSandboxBlocked(messageEl, trace, { homeDir = '' } = {}) {
  if (!messageEl) return;
  const log = messageEl.querySelector(':scope > .chat-tool-log');
  const old = messageEl.querySelector(':scope > .chat-sandbox-blocked');
  const runs = log ? blockedRunsOf(trace) : [];
  const box = buildSandboxBlockedBox(runs, { homeDir });
  if (!box) {
    old?.remove();
    return;
  }
  // Keep a raw view the reader opened open across a redraw.
  if (old) {
    const opened = [...old.querySelectorAll('.chat-sandbox-blocked-raw')].map((d) => d.open);
    box.querySelectorAll('.chat-sandbox-blocked-raw').forEach((d, i) => { d.open = opened[i] === true; });
    old.replaceWith(box);
  } else {
    log.after(box);
  }
}
