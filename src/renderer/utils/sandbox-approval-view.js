// The sandbox card (#792) as the interface shows it: what was blocked, how
// the run went, what can be opened and for how long. Pure functions over the
// DTO from main, like tool-approval-view.js for the other cards; the DOM is
// built in ToolApprovalCard.js. Laid out after the mockup decided on
// 2026-10-07 (variant B, a card in the chat).
import contracts from '../generated/contracts.js';
import { t, tPlural, getLocale } from '../i18n.js';
import { sandboxPath } from './program-allowance-view.js';

const { APPROVAL_RESPONSES, PERMISSION_DENIAL_REASONS } = contracts;

/** "0:07", "1:23", "12:05" — how long a connection has waited (#792). */
export function formatWaited(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** `example.com:443` → its host and port; the port alone says which protocol it likely is. */
function splitTarget(target) {
  const m = /^(.+):(\d{1,5})$/.exec(String(target || ''));
  return m ? { host: m[1], port: Number(m[2]) } : { host: String(target || ''), port: null };
}

/** "Connection · HTTPS" for port 443, "Connection · HTTP" for 80, "Connection" otherwise. */
function networkKindLabel(target) {
  const { port } = splitTarget(target);
  if (port === 443) return t('approval.sandbox.kind.https');
  if (port === 80) return t('approval.sandbox.kind.http');
  return t('toolLog.sandbox.kind.network');
}

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

/** How long a connection has been waiting while its command runs (#792). */
export function describeLiveRun(waitedMs) {
  return t('approval.sandbox.run.waiting', { time: formatWaited(waitedMs) });
}

/** How long it waited in the end, once the card is decided or expired. */
export function describeLiveWaited(waitedMs) {
  return t('approval.sandbox.run.waited', { time: formatWaited(waitedMs) });
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

function reasonOf(kind) {
  return t(`toolLog.sandbox.reason.${kind}`);
}

/**
 * @param {object} dto  a tool approval request with `checkpoint: 'sandbox'`
 * @returns {null|object} the view, or null when the DTO carries no sandbox card
 */
export function buildSandboxCardView(dto, { homeDir = '' } = {}) {
  const sandbox = dto?.checkpoint === 'sandbox' ? dto.sandbox : null;
  if (!sandbox || !Array.isArray(sandbox.entries) || sandbox.entries.length === 0) return null;
  const live = sandbox.live === true;
  const isPath = (kind) => kind === 'write' || kind === 'read';
  const show = (p, kind) => (isPath(kind) ? sandboxPath(p, homeDir) : p);
  const kinds = new Set(sandbox.entries.map((e) => e.kind));
  const headlineKey = live
    ? 'approval.sandbox.headline.live'
    : kinds.size > 1
      ? (kinds.has('network') ? 'approval.sandbox.headline.several' : 'approval.sandbox.headline.both')
      : `approval.sandbox.headline.${[...kinds][0]}`;
  // `{scope}` hints: a path is exact or one folder up, a host exact or its whole domain.
  const hint = (kind, i) => {
    if (kind === 'network') return t(i === 0 ? 'approval.sandbox.scope.exactHost' : 'approval.sandbox.scope.domain');
    return t(i === 0 ? 'approval.sandbox.scope.exact' : 'approval.sandbox.scope.wider');
  };
  return {
    kind: 'sandbox',
    live,
    title: t(live ? 'approval.sandbox.title.live' : 'approval.sandbox.title'),
    badge: t('approval.sandbox.badge'),
    // `{command}` and `{host}` are rendered as code, wherever the language puts them.
    headline: {
      template: t(headlineKey),
      command: headlineCommand(sandbox.command),
      host: live ? splitTarget(sandbox.entries[0].target).host : '',
    },
    entries: sandbox.entries.map((entry) => ({
      kind: entry.kind,
      kindLabel: entry.kind === 'network' ? networkKindLabel(entry.target) : t(`toolLog.sandbox.kind.${entry.kind}`),
      target: show(entry.target, entry.kind),
      title: entry.target,
      detail: entry.folder ? tPlural('toolLog.sandbox.paths', entry.count, { count: entry.count }) : '',
      legend: t(`approval.sandbox.scope.legend.${entry.kind}`),
      options: entry.allow.map((value, i) => ({
        value,
        label: show(value, entry.kind),
        hint: hint(entry.kind, i),
      })),
    })),
    // The hosts the run may reach already, on the card about a waiting connection.
    domains: live && Array.isArray(sandbox.domains) ? sandbox.domains : [],
    waitedMs: live && Number.isFinite(sandbox.waitedMs) ? sandbox.waitedMs : 0,
    others: (sandbox.others || []).map((other) => ({
      kindLabel: t(`toolLog.sandbox.kind.${other.kind}`),
      target: show(other.target, other.kind),
    })),
    command: sandbox.command,
    run: live ? describeLiveRun(sandbox.waitedMs) : describeSandboxRun(sandbox.run),
    reason: [...kinds].map((kind) => reasonOf(kind)).join(' '),
    // While the command waits, its output is what it printed so far.
    outputLabel: t(live ? 'approval.sandbox.output.sofar' : 'approval.sandbox.output'),
    outputEmpty: t(live ? 'approval.sandbox.output.waiting' : 'approval.sandbox.output.empty'),
    output: sandbox.output,
    raw: Array.isArray(sandbox.raw) ? sandbox.raw.join('\n') : '',
    // "For this session" only where the mode keeps approvals at all.
    durations: dto.sessionAllowed === true
      ? [
          { value: 'run', label: t('approval.sandbox.duration.run') },
          { value: 'session', label: t('approval.sandbox.duration.session') },
        ]
      : [],
    warning: t(live ? 'approval.sandbox.warning.live' : 'approval.sandbox.warning'),
    // The card's buttons, in the shape the other cards use, so the shared
    // code can switch them off and on; "once" — the primary button — answers once or for the
    // session, as the duration says.
    actions: {
      once: {
        response: APPROVAL_RESPONSES.ALLOW_ONCE,
        label: t(live ? 'approval.sandbox.action.connect' : 'approval.sandbox.action.allow'),
        enabled: true,
      },
      deny: { response: APPROVAL_RESPONSES.DENY, label: t('approval.action.deny'), enabled: true },
    },
    actionOrder: ['once', 'deny'],
  };
}

/**
 * What a resolved sandbox card says (#792), or null for any other card. The
 * card about a waiting connection (`live`) lets the command carry on rather
 * than run it again, and expires on its own when the command gives up.
 */
export function describeSandboxOutcome({ response, invalidated, reason, aborted } = {}, { live = false } = {}) {
  if (aborted === true) return null;
  if (invalidated === true) {
    if (live && reason === PERMISSION_DENIAL_REASONS.SANDBOX_RUN_ENDED) {
      return { status: 'invalidated', label: t('approval.outcome.sandboxGaveUp.label'), detail: t('approval.outcome.sandboxGaveUp.detail') };
    }
    return null;
  }
  const allowed = t(live ? 'approval.outcome.sandboxConnected.detail' : 'approval.outcome.sandboxAllowed.detail');
  if (response === APPROVAL_RESPONSES.DENY) {
    return {
      status: 'denied',
      label: t('approval.outcome.denied.label'),
      detail: t(live ? 'approval.outcome.sandboxConnectionDenied.detail' : 'approval.outcome.sandboxDenied.detail'),
    };
  }
  if (response === APPROVAL_RESPONSES.ALLOW_SESSION) {
    return { status: 'allowed', label: t('approval.outcome.sandboxSession.label'), detail: allowed };
  }
  if (response === APPROVAL_RESPONSES.ALLOW_ONCE) {
    return { status: 'allowed', label: t('approval.outcome.sandboxRun.label'), detail: allowed };
  }
  return null;
}
