// What the sandbox refused during a message's shell and Python runs (#792):
// a box right under the tool log, open by default, with one line per blocked
// resource — what kind, which path or host, why — and the raw sandbox lines
// folded away. Decided on 2026-10-08 from a mockup with three variants
// (strip, marker in the row, box). The colour stays neutral: amber means
// "runs without isolation" and red a real error, and this is neither.
//
// A box in which every question was answered — a path outside the open
// folder (#792, step 4), a refusal after a run, a connection while it waited
// — has nothing left to warn about: it folds to one line and holds, open,
// what the decided approval card said as well, so that the card is not a
// second box next to it (2026-10-11). The box is drawn from the stored tool
// trace, which is why it outlives the card: it is still there after the next
// turn and after a restart.
import contracts from '../generated/contracts.js';
import { toolLineText } from '../utils/tool-log-summary.js';
import { sandboxPath } from '../utils/program-allowance-view.js';
import { APP_LOCALES, t, tPlural } from '../i18n.js';

const { normalizeSandboxBlocked, normalizeSandboxDecision, normalizeSandboxLive, normalizeSandboxOutside } = contracts;

const SHIELD_OFF_ICON_HTML =
  '<svg class="chat-sandbox-blocked-icon" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M8 1.8 3.2 3.6v3.9c0 3 2.1 5.4 4.8 6.4 2.7-1 4.8-3.4 4.8-6.4V3.6z"/>'
  + '<path d="M2.6 2.6l10.8 10.8"/></svg>';

const CHEVRON_ICON_HTML =
  '<svg class="chat-sandbox-blocked-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

const DENY_LIST_REASON = 'host is on the deny list';
const USER_DENIED_REASON = 'user denied';
const NO_ENTRIES = Object.freeze({ entries: [], moreEntries: 0, total: 0, raw: [] });

/**
 * The runs of a trace that the sandbox refused something in, held a
 * connection of until the user decided, or asked about before a file tool
 * reached outside the open folder (#792), in order.
 */
export function blockedRunsOf(trace) {
  if (!Array.isArray(trace)) return [];
  const runs = [];
  for (const entry of trace) {
    const blocked = normalizeSandboxBlocked(entry?.sandboxBlocked);
    const live = normalizeSandboxLive(entry?.sandboxLive) || [];
    // A denied connection is among the refusals already; the allowed ones are not.
    const allowed = live.filter((d) => d.outcome === 'allowed');
    const outside = normalizeSandboxOutside(entry?.sandboxOutside) || [];
    if (!blocked && allowed.length === 0 && outside.length === 0) continue;
    runs.push({
      line: toolLineText(entry),
      tool: typeof entry?.tool === 'string' ? entry.tool : '',
      blocked: blocked || NO_ENTRIES,
      decision: blocked ? normalizeSandboxDecision(entry?.sandboxDecision) : null,
      allowed,
      outside,
    });
  }
  return runs;
}

/** A path outside the open folder the user was asked about before the call (#792, step 4), as one line. */
function buildOutsideEntry(decision, homeDir) {
  const item = document.createElement('li');
  item.className = 'chat-sandbox-blocked-entry';
  item.dataset.kind = decision.kind;
  item.dataset.outcome = decision.outcome;
  const kind = document.createElement('span');
  kind.className = 'chat-sandbox-blocked-kind';
  kind.textContent = t(`toolLog.sandbox.kind.${decision.kind}`);
  const target = document.createElement('span');
  target.className = 'chat-sandbox-blocked-target';
  const shown = sandboxPath(decision.target, homeDir);
  target.textContent = decision.outcome === 'allowed' && decision.pattern !== decision.target
    ? `${shown} · ${sandboxPath(decision.pattern, homeDir)}`
    : shown;
  if (target.textContent !== decision.target) target.title = decision.target;
  const reason = document.createElement('span');
  reason.className = 'chat-sandbox-blocked-reason';
  reason.textContent = t(decision.outcome === 'allowed'
    ? `toolLog.sandbox.outside.${decision.duration}`
    : 'toolLog.sandbox.outside.denied');
  item.append(kind, target, reason);
  if (decision.sensitive) {
    const badge = document.createElement('span');
    badge.className = 'chat-sandbox-blocked-badge';
    badge.textContent = t('approval.badge.sensitive');
    badge.title = t('approval.badge.sensitive.title');
    reason.append(badge);
  }
  return item;
}

/** The sentence the card asked — which tool wants what — with the tool as code, wherever the language puts it. */
function buildOutsideAsk(run) {
  const decisions = run.outside;
  const key = decisions.length > 1
    ? 'approval.sandbox.headline.outsideSeveral'
    : decisions[0].kind === 'write'
      ? 'approval.sandbox.headline.outsideWrite'
      : decisions[0].folder ? 'approval.sandbox.headline.outsideReadFolder' : 'approval.sandbox.headline.outsideRead';
  const ask = document.createElement('p');
  ask.className = 'chat-sandbox-blocked-ask';
  for (const part of t(key).split(/(\{tool\})/)) {
    if (!part) continue;
    if (part === '{tool}') {
      const tool = document.createElement('code');
      tool.className = 'chat-sandbox-blocked-tool';
      tool.lang = APP_LOCALES.EN;
      tool.textContent = run.tool || t('tools.line.generic.fallbackName');
      ask.append(tool);
    } else {
      ask.append(part);
    }
  }
  return ask;
}

/** What the answer means and why the card was there, below the paths — as the card said when it was decided. */
function buildOutsideNotes(run) {
  const first = run.outside[0];
  const consequence = first.outcome === 'denied'
    ? 'approval.outcome.outsideDenied.detail'
    : first.duration === 'session' ? 'approval.outcome.outsideSession.detail' : 'approval.outcome.outsideAllowed.detail';
  const notes = [t(consequence)];
  if (run.outside.some((decision) => decision.outcome === 'allowed' && decision.sensitive)) {
    notes.push(t('approval.reason.sensitiveAccess.plain'));
  }
  notes.push(t('approval.sandbox.reason.outside'));
  return notes.map((text) => {
    const note = document.createElement('p');
    note.className = 'chat-sandbox-blocked-note';
    note.textContent = text;
    return note;
  });
}

const isUserDenied = (entry) => entry.kind === 'network' && entry.reason === USER_DENIED_REASON;
const isAnswer = (decision) => decision?.outcome === 'allowed' || decision?.outcome === 'denied';

/**
 * Whether the user was asked about everything the sandbox refused in `run`
 * and answered: the card after the run, without a second refusal, or a
 * connection they turned down while it waited. Connections let through and
 * paths outside were answers anyway.
 */
function isAnswered(run) {
  if (run.decision) return isAnswer(run.decision) && !run.decision.retry?.blocked;
  return run.blocked.moreEntries === 0 && run.blocked.entries.every(isUserDenied);
}

/** Every answer the user gave in `runs`, as 'allowed' or 'denied'. */
function answersOf(runs) {
  return runs.flatMap((run) => [
    ...(run.decision && isAnswer(run.decision) ? [run.decision.outcome] : run.blocked.entries.filter(isUserDenied).map(() => 'denied')),
    ...(run.allowed || []).map(() => 'allowed'),
    ...(run.outside || []).map((decision) => decision.outcome),
  ]);
}

/** "allowed", "denied" or "partly allowed" — the answer to everything this box was asked. */
function answerSummary(answers) {
  const allowed = answers.filter((answer) => answer === 'allowed').length;
  return t(`toolLog.sandbox.outside.summary.${allowed === answers.length ? 'allowed' : allowed === 0 ? 'denied' : 'mixed'}`);
}

/**
 * What the answers about a run meant, as the card said when it was decided:
 * the connection went through or stayed closed, the command was not run
 * again. That it ran again, and how, the decision line says.
 */
function buildAnswerNotes(run) {
  const keys = [];
  if (run.decision?.outcome === 'denied') keys.push('approval.outcome.sandboxDenied.detail');
  if (run.allowed?.length) keys.push('approval.outcome.sandboxConnected.detail');
  if (!run.decision && run.blocked.entries.some(isUserDenied)) keys.push('approval.outcome.sandboxConnectionDenied.detail');
  return keys.map((key) => {
    const note = document.createElement('p');
    note.className = 'chat-sandbox-blocked-note';
    note.textContent = t(key);
    return note;
  });
}

/** "Opened: ~/Library/Caches/prisma/engines (Write)" — what the card after the run opened. */
function openedText(decision, homeDir) {
  const paths = (decision.paths || []).map((grant) => {
    const shown = grant.kind === 'network' ? grant.path : sandboxPath(grant.path, homeDir);
    return `${shown} (${t(`toolLog.sandbox.kind.${grant.kind}`)})`;
  });
  return paths.length ? t('toolLog.sandbox.decision.opened', { paths: paths.join(', ') }) : '';
}

function reasonOf(entry) {
  if (entry.kind === 'network' && entry.reason === DENY_LIST_REASON) return t('toolLog.sandbox.reason.networkDenied');
  if (entry.kind === 'network' && entry.reason === USER_DENIED_REASON) return t('toolLog.sandbox.reason.networkUserDenied');
  return t(`toolLog.sandbox.reason.${entry.kind}`);
}

/** A connection the user let through while the command waited (#792), as one line. */
function buildAllowedEntry(decision) {
  const item = document.createElement('li');
  item.className = 'chat-sandbox-blocked-entry';
  item.dataset.kind = 'network';
  item.dataset.outcome = 'allowed';
  const kind = document.createElement('span');
  kind.className = 'chat-sandbox-blocked-kind';
  kind.textContent = t('toolLog.sandbox.kind.network');
  const target = document.createElement('span');
  target.className = 'chat-sandbox-blocked-target';
  target.textContent = decision.pattern !== decision.target ? `${decision.target} · ${decision.pattern}` : decision.target;
  const reason = document.createElement('span');
  reason.className = 'chat-sandbox-blocked-reason';
  reason.textContent = t(`toolLog.sandbox.live.${decision.duration}`);
  item.append(kind, target, reason);
  return item;
}

/** "~/Library/Caches/pip/ · 37 paths", "example.com:443 · 3 times". */
function targetText(entry, homeDir) {
  const isPath = entry.kind === 'write' || entry.kind === 'read';
  const shown = isPath ? sandboxPath(entry.target, homeDir) : entry.target;
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

/** What the user decided on the run's sandbox card (#792), as one line. */
function decisionText(decision) {
  if (decision.outcome !== 'allowed') return t(`toolLog.sandbox.decision.${decision.outcome}`);
  const code = decision.retry?.exitCode;
  return Number.isInteger(code)
    ? t(`toolLog.sandbox.decision.${decision.duration}`, { code })
    : t(`toolLog.sandbox.decision.${decision.duration}NoCode`);
}

function buildRun(run, homeDir, { withLine }) {
  const part = document.createDocumentFragment();
  if (withLine) {
    const line = document.createElement('p');
    line.className = 'chat-sandbox-blocked-run';
    line.textContent = run.line;
    part.append(line);
  }
  if (run.outside?.length) part.append(buildOutsideAsk(run));
  const list = document.createElement('ul');
  list.className = 'chat-sandbox-blocked-list';
  for (const entry of run.blocked.entries) list.append(buildEntry(entry, homeDir));
  if (run.blocked.moreEntries > 0) {
    const more = document.createElement('li');
    more.className = 'chat-sandbox-blocked-more';
    more.textContent = t('toolLog.sandbox.more', { count: run.blocked.moreEntries });
    list.append(more);
  }
  for (const decision of run.allowed || []) list.append(buildAllowedEntry(decision));
  for (const decision of run.outside || []) list.append(buildOutsideEntry(decision, homeDir));
  part.append(list);
  if (run.outside?.length) part.append(...buildOutsideNotes(run));
  if (run.decision) {
    const decision = document.createElement('p');
    decision.className = 'chat-sandbox-blocked-decision';
    decision.dataset.outcome = run.decision.outcome;
    decision.textContent = decisionText(run.decision);
    part.append(decision);
    const opened = run.decision.outcome === 'allowed' ? openedText(run.decision, homeDir) : '';
    if (opened) {
      const note = document.createElement('p');
      note.className = 'chat-sandbox-blocked-note';
      note.textContent = opened;
      part.append(note);
    }
    const again = run.decision.retry?.blocked;
    if (again) {
      const lead = document.createElement('p');
      lead.className = 'chat-sandbox-blocked-run';
      lead.textContent = t('toolLog.sandbox.decision.retryBlocked');
      const second = document.createElement('ul');
      second.className = 'chat-sandbox-blocked-list';
      for (const entry of again.entries) second.append(buildEntry(entry, homeDir));
      part.append(lead, second);
    }
  }
  part.append(...buildAnswerNotes(run));
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

// Messages whose folded box the reader opened, by their tool trace — a stable
// object across redraws, so a new turn or a language change keeps it open.
const openBoxes = new WeakSet();

/**
 * The box for `runs` (from `blockedRunsOf`), or null when nothing was
 * blocked. One run names its command in the title; several get a line each.
 * A box in which the user answered every question folds to its title line;
 * `open` says whether it starts open and `onToggle` hears when the reader
 * changes that.
 */
export function buildSandboxBlockedBox(runs, { homeDir = '', open = false, onToggle = null } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const box = document.createElement('div');
  box.className = 'chat-sandbox-blocked';
  box.setAttribute('role', 'group');
  const id = (boxIds += 1);
  const titleId = `chat-sandbox-blocked-title-${id}`;
  box.setAttribute('aria-labelledby', titleId);

  const resources = runs.reduce((sum, run) => sum + run.blocked.entries.length + run.blocked.moreEntries, 0);
  const asked = runs.reduce((sum, run) => sum + (run.allowed?.length || 0), 0);
  const outside = runs.reduce((sum, run) => sum + (run.outside?.length || 0), 0);
  // Every question answered: nothing is left to warn about, only to read.
  const answers = answersOf(runs);
  const foldable = answers.length > 0 && runs.every(isAnswered);
  const title = document.createElement(foldable ? 'button' : 'p');
  title.className = foldable ? 'chat-sandbox-blocked-title chat-sandbox-blocked-toggle' : 'chat-sandbox-blocked-title';
  title.id = titleId;
  if (foldable) title.insertAdjacentHTML('afterbegin', CHEVRON_ICON_HTML);
  title.insertAdjacentHTML('beforeend', SHIELD_OFF_ICON_HTML);
  const heading = document.createElement('span');
  heading.className = 'chat-sandbox-blocked-heading';
  // Nothing refused, only connections let through on the card (#792).
  heading.textContent = resources > 0
    ? tPlural('toolLog.sandbox.title', resources, { count: resources })
    : asked > 0
      ? tPlural('toolLog.sandbox.titleAllowed', asked, { count: asked })
      : tPlural('toolLog.sandbox.titleOutside', outside, { count: outside });
  const context = document.createElement('span');
  context.className = 'chat-sandbox-blocked-context';
  context.textContent = runs.length === 1 ? `· ${runs[0].line}` : `· ${t('toolLog.sandbox.inRuns', { count: runs.length })}`;
  if (foldable) {
    // One piece of text next to the icons: folded it is cut at the end of
    // the line, open it wraps as a sentence does.
    const summary = document.createElement('span');
    summary.className = 'chat-sandbox-blocked-summary';
    summary.textContent = `· ${answerSummary(answers)}`;
    const line = document.createElement('span');
    line.className = 'chat-sandbox-blocked-line';
    line.append(heading, summary, context);
    title.append(line);
  } else {
    title.append(heading, context);
  }
  box.append(title);

  const parts = runs.map((run) => buildRun(run, homeDir, { withLine: runs.length > 1 }));
  if (!foldable) {
    box.append(...parts);
    return box;
  }
  box.classList.add('chat-sandbox-blocked--foldable');
  const body = document.createElement('div');
  body.className = 'chat-sandbox-blocked-body';
  body.id = `chat-sandbox-blocked-body-${id}`;
  body.append(...parts);
  title.type = 'button';
  title.setAttribute('aria-controls', body.id);
  const show = (opened) => {
    title.setAttribute('aria-expanded', String(opened));
    body.hidden = !opened;
  };
  show(open === true);
  title.addEventListener('click', () => {
    const opened = title.getAttribute('aria-expanded') !== 'true';
    show(opened);
    if (typeof onToggle === 'function') onToggle(opened);
  });
  box.append(body);
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
  const traceKey = trace && typeof trace === 'object' ? trace : null;
  const box = buildSandboxBlockedBox(runs, {
    homeDir,
    open: traceKey ? openBoxes.has(traceKey) : false,
    onToggle: (opened) => {
      if (!traceKey) return;
      if (opened) openBoxes.add(traceKey);
      else openBoxes.delete(traceKey);
    },
  });
  if (!box) {
    old?.remove();
    return;
  }
  // Keep a raw view the reader opened open across a redraw.
  if (old) {
    const opened = [...old.querySelectorAll('.chat-sandbox-blocked-raw')].map((d) => d.open);
    box.querySelectorAll('.chat-sandbox-blocked-raw').forEach((d, i) => { d.open = opened[i] === true; });
    // The line that was in focus is drawn again: the focus follows it.
    const refocus = old.contains(document.activeElement) && document.activeElement.classList.contains('chat-sandbox-blocked-title');
    old.replaceWith(box);
    if (refocus) box.querySelector('.chat-sandbox-blocked-title')?.focus({ preventScroll: true });
  } else {
    log.after(box);
  }
}
