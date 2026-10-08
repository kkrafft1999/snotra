// The sandbox card (#792) as the interface shows it: what was blocked, how
// the run went, what can be opened and for how long. Pure functions over the
// DTO from main, like tool-approval-view.js for the other cards; the DOM is
// built in ToolApprovalCard.js. Laid out after the mockup decided on
// 2026-10-07 (variant B, a card in the chat).
import contracts from '../generated/contracts.js';
import { t, tPlural, getLocale } from '../i18n.js';
import { sandboxPath } from './program-allowance-view.js';

const { APPROVAL_RESPONSES } = contracts;

const DENY_LIST_REASON = 'host is on the deny list';

/** "2.4 s" / "2,4 Sek.", "340 ms" — in the language of the interface. */
export function formatRunDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = ms >= 1000;
  return new Intl.NumberFormat(getLocale(), {
    style: 'unit',
    unit: seconds ? 'second' : 'millisecond',
    unitDisplay: 'short',
    maximumFractionDigits: seconds ? 1 : 0,
  }).format(seconds ? ms / 1000 : ms);
}

/** How the run the sandbox refused something in went. */
export function describeSandboxRun(run) {
  const duration = formatRunDuration(run?.durationMs);
  if (run?.timedOut) return t('approval.sandbox.run.timedOut', { duration });
  if (!Number.isInteger(run?.exitCode) || !duration) return t('approval.sandbox.run.unknown');
  if (run.exitCode === 0) return t('approval.sandbox.run.ok', { duration });
  return t('approval.sandbox.run.failed', { code: run.exitCode, duration });
}

/** The first line of a command, for the headline; the whole one stands below. */
function headlineCommand(command) {
  const first = String(command || '').split('\n')[0].trim();
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

function reasonOf(kind, reason) {
  if (kind === 'network' && reason === DENY_LIST_REASON) return t('toolLog.sandbox.reason.networkDenied');
  return t(`toolLog.sandbox.reason.${kind}`);
}

/**
 * @param {object} dto  a tool approval request with `checkpoint: 'sandbox'`
 * @returns {null|object} the view, or null when the DTO carries no sandbox card
 */
export function buildSandboxCardView(dto, { homeDir = '' } = {}) {
  const sandbox = dto?.checkpoint === 'sandbox' ? dto.sandbox : null;
  if (!sandbox || !Array.isArray(sandbox.entries) || sandbox.entries.length === 0) return null;
  const show = (p) => sandboxPath(p, homeDir);
  const kinds = new Set(sandbox.entries.map((e) => e.kind));
  const headlineKey = kinds.size > 1
    ? 'approval.sandbox.headline.both'
    : kinds.has('read') ? 'approval.sandbox.headline.read' : 'approval.sandbox.headline.write';
  return {
    kind: 'sandbox',
    title: t('approval.sandbox.title'),
    badge: t('approval.sandbox.badge'),
    // `{command}` is rendered as code, wherever the language puts it.
    headline: { template: t(headlineKey), command: headlineCommand(sandbox.command) },
    entries: sandbox.entries.map((entry) => ({
      kind: entry.kind,
      kindLabel: t(`toolLog.sandbox.kind.${entry.kind}`),
      target: show(entry.target),
      title: entry.target,
      detail: entry.folder ? tPlural('toolLog.sandbox.paths', entry.count, { count: entry.count }) : '',
      legend: t(`approval.sandbox.scope.legend.${entry.kind}`),
      options: entry.allow.map((path, i) => ({
        value: path,
        label: show(path),
        hint: t(i === 0 ? 'approval.sandbox.scope.exact' : 'approval.sandbox.scope.wider'),
      })),
    })),
    others: (sandbox.others || []).map((other) => ({
      kindLabel: t(`toolLog.sandbox.kind.${other.kind}`),
      target: other.kind === 'write' || other.kind === 'read' ? show(other.target) : other.target,
    })),
    command: sandbox.command,
    run: describeSandboxRun(sandbox.run),
    reason: [...kinds].map((kind) => reasonOf(kind)).join(' '),
    output: sandbox.output,
    raw: Array.isArray(sandbox.raw) ? sandbox.raw.join('\n') : '',
    // "For this session" only where the mode keeps approvals at all.
    durations: dto.sessionAllowed === true
      ? [
          { value: 'run', label: t('approval.sandbox.duration.run') },
          { value: 'session', label: t('approval.sandbox.duration.session') },
        ]
      : [],
    warning: t('approval.sandbox.warning'),
    // The card's buttons, in the shape the other cards use, so the shared
    // code can switch them off and on; "once" — the primary button — answers once or for the
    // session, as the duration says.
    actions: {
      once: { response: APPROVAL_RESPONSES.ALLOW_ONCE, label: t('approval.sandbox.action.allow'), enabled: true },
      deny: { response: APPROVAL_RESPONSES.DENY, label: t('approval.action.deny'), enabled: true },
    },
    actionOrder: ['once', 'deny'],
  };
}

/** What a resolved sandbox card says (#792), or null for any other card. */
export function describeSandboxOutcome({ response, invalidated, aborted } = {}) {
  if (aborted === true || invalidated === true) return null;
  if (response === APPROVAL_RESPONSES.DENY) {
    return { status: 'denied', label: t('approval.outcome.denied.label'), detail: t('approval.outcome.sandboxDenied.detail') };
  }
  if (response === APPROVAL_RESPONSES.ALLOW_SESSION) {
    return { status: 'allowed', label: t('approval.outcome.sandboxSession.label'), detail: t('approval.outcome.sandboxAllowed.detail') };
  }
  if (response === APPROVAL_RESPONSES.ALLOW_ONCE) {
    return { status: 'allowed', label: t('approval.outcome.sandboxRun.label'), detail: t('approval.outcome.sandboxAllowed.detail') };
  }
  return null;
}
