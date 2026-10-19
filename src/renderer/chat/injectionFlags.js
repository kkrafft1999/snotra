// Tool results that looked like a prompt injection (#1011, AR-36): a box
// right under a message's tool log, one part per flagged result — which
// step, what kind of text, a short excerpt — and one sentence on what it
// means: nothing about what the agent may do has changed.
//
// It follows the box of what the sandbox refused (#792), decided on
// 2026-10-08, and stays neutral like it: amber means "runs without
// isolation" and red a real error, and a flag is neither — it is a hint that
// can be wrong both ways. The box is drawn from the stored tool trace, so it
// is still there after the next turn and after a restart.
import contracts from '../generated/contracts.js';
import { toolLineText } from '../utils/tool-log-summary.js';
import { settingsHelpTarget } from '../manual/settings-help-links.js';
import { getLocale, t, tPlural } from '../i18n.js';

const { normalizeInjectionFlag } = contracts;

/** Where the box's help link lands, in `settings-help-links.js`. */
export const INJECTION_HELP_KEY = 'chat.injectionFlag';

/**
 * Asked for by the box's help link and answered by the app: open the manual
 * page on it. An event, because the box is drawn inside the chat, which
 * holds no reference to the help window.
 */
export const INJECTION_HELP_EVENT = 'snotra:open-injection-help';

// A speech bubble with an exclamation mark: text that speaks to the agent.
const ICON_HTML =
  '<svg class="chat-injection-flag-icon" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7l-3 2.5V11h-.5a1 1 0 0 1-1-1z"/>'
  + '<path d="M8 4.8v3"/><path d="M8 9.6v.01"/></svg>';

let boxIds = 0;

/**
 * The flagged results of a trace, in order.
 *
 * @returns {Array<{ line: string, tool: string, flag: { signals: Array<{ kind: string, excerpt: string }>, sources: string[] } }>}
 */
export function flaggedResultsOf(trace) {
  if (!Array.isArray(trace)) return [];
  const out = [];
  for (const entry of trace) {
    if (!entry || typeof entry !== 'object') continue;
    const flag = normalizeInjectionFlag(entry.injectionFlag);
    if (!flag) continue;
    out.push({ line: toolLineText(entry), tool: typeof entry.tool === 'string' ? entry.tool : '', flag });
  }
  return out;
}

/** One signal: what kind of text, then the excerpt as a quote. */
function buildSignal(signal) {
  const item = document.createElement('li');
  item.className = 'chat-injection-flag-signal';
  item.dataset.kind = signal.kind;
  const kind = document.createElement('span');
  kind.className = 'chat-injection-flag-kind';
  kind.textContent = t(`toolLog.injection.kind.${signal.kind}`);
  item.append(kind);
  if (signal.excerpt) {
    // Foreign text, shown as text: it is never parsed as markup.
    const quote = document.createElement('q');
    quote.className = 'chat-injection-flag-excerpt';
    quote.textContent = signal.excerpt;
    item.append(quote);
  }
  return item;
}

/** One flagged result: its tool line (when there are several), then its signals. */
function buildResult(result, { withLine }) {
  const part = document.createElement('div');
  part.className = 'chat-injection-flag-result';
  if (withLine) {
    const line = document.createElement('p');
    line.className = 'chat-injection-flag-run';
    line.textContent = result.line;
    part.append(line);
  }
  const list = document.createElement('ul');
  list.className = 'chat-injection-flag-signals';
  list.append(...result.flag.signals.map(buildSignal));
  part.append(list);
  return part;
}

/**
 * The box for `results` (from `flaggedResultsOf`), or null when nothing was
 * flagged. One result names its step in the title; several get a line each.
 */
export function buildInjectionFlagBox(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const box = document.createElement('div');
  box.className = 'chat-injection-flag';
  box.setAttribute('role', 'group');
  boxIds += 1;
  const titleId = `chat-injection-flag-title-${boxIds}`;
  box.setAttribute('aria-labelledby', titleId);

  const title = document.createElement('p');
  title.className = 'chat-injection-flag-title';
  title.id = titleId;
  title.insertAdjacentHTML('afterbegin', ICON_HTML);
  const heading = document.createElement('span');
  heading.className = 'chat-injection-flag-heading';
  heading.textContent = tPlural('toolLog.injection.title', results.length, { count: results.length });
  title.append(heading);
  if (results.length === 1) {
    const context = document.createElement('span');
    context.className = 'chat-injection-flag-context';
    context.textContent = `· ${results[0].line}`;
    title.append(context);
  }
  box.append(title);

  box.append(...results.map((result) => buildResult(result, { withLine: results.length > 1 })));

  const note = document.createElement('p');
  note.className = 'chat-injection-flag-note';
  note.textContent = t('toolLog.injection.note');
  box.append(note);

  const footer = document.createElement('p');
  footer.className = 'chat-injection-flag-footer';
  const hint = document.createElement('span');
  hint.textContent = t('toolLog.injection.hint');
  footer.append(hint, ' ');
  if (settingsHelpTarget(INJECTION_HELP_KEY, getLocale())) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'chat-injection-flag-help';
    link.textContent = t('toolLog.injection.help');
    link.addEventListener('click', () => {
      link.dispatchEvent(new CustomEvent(INJECTION_HELP_EVENT, { bubbles: true }));
    });
    footer.append(link);
  }
  box.append(footer);
  return box;
}

/**
 * Puts the box under the tool log of `messageEl`, or takes it away. It comes
 * after what the sandbox refused, which stands right under the log, and
 * before the changed files and the generated images: like the sandbox box,
 * it is about the steps above it.
 */
export function syncInjectionFlags(messageEl, trace) {
  if (!messageEl) return;
  const log = messageEl.querySelector(':scope > .chat-tool-log');
  const old = messageEl.querySelector(':scope > .chat-injection-flag');
  const box = log ? buildInjectionFlagBox(flaggedResultsOf(trace)) : null;
  if (!box) {
    old?.remove();
    return;
  }
  if (old) {
    // The help link that was in focus is drawn again: the focus follows it.
    const refocus = old.contains(document.activeElement);
    old.replaceWith(box);
    if (refocus) box.querySelector('.chat-injection-flag-help')?.focus({ preventScroll: true });
  } else {
    (messageEl.querySelector(':scope > .chat-sandbox-blocked') || log).after(box);
  }
}

/** Opens the manual page the help link names, in the help window. */
export function openInjectionHelp(api) {
  const target = settingsHelpTarget(INJECTION_HELP_KEY, getLocale());
  if (!target || typeof api?.openManual !== 'function') return;
  void Promise.resolve(api.openManual({ slug: target.slug, fragment: target.fragment })).catch(() => {
    // Nothing to tell: a help link that does not open leaves the chat as it
    // was, and the warning it belongs to is already on screen.
  });
}
