'use strict';

/**
 * In-app feedback (#1045): the rules both sides share.
 *
 * The endpoint (kkrafft1999/snotra-promotion#153, `docs/feedback-endpoint.md`
 * there) files a message as a public issue in this repository. The renderer
 * counts and checks with the same rules the endpoint applies, so the form says
 * "too long" before the server does; main checks again, because it does not
 * trust what the window hands it.
 */

const FEEDBACK_KINDS = Object.freeze(['bug', 'idea', 'praise']);
const FEEDBACK_MESSAGE_MAX = 5000;
const FEEDBACK_EMAIL_MAX = 254;
/** From here on the form shows how many characters are left. */
const FEEDBACK_COUNTER_FROM = 4000;
/** What a prefilled GitHub form gets at most; a longer text is cut. */
const FEEDBACK_PREFILL_MAX = 1500;
const FEEDBACK_REPO_URL = 'https://github.com/kkrafft1999/snotra';
/** Section 7 of the privacy policy, the one about the feedback form. */
const FEEDBACK_PRIVACY_URL = 'https://snotra-ai.dev/datenschutz.html#feedback';

function isFeedbackKind(kind) {
  return FEEDBACK_KINDS.includes(kind);
}

/** Length as a person counts it: an emoji is one character, not two. */
function feedbackLength(text) {
  return [...String(text ?? '').trim()].length;
}

/** The endpoint's own check; an empty address counts as none. */
function isFeedbackEmail(email) {
  const value = String(email ?? '').trim();
  return value.length <= FEEDBACK_EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** "Snotra 1.25.0 · macOS 15.1 · arm64 · openai" — what the form shows. */
function formatFeedbackDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return '';
  const { appVersion, os, arch, provider } = diagnostics;
  return [appVersion && `Snotra ${appVersion}`, os, arch, provider].filter(Boolean).join(' · ');
}

function clip(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}\n\n[…]` : text;
}

/**
 * The way round the endpoint when it cannot take a message: GitHub's own issue
 * form, prefilled. Needs a GitHub account, which is why it is the fallback.
 * A bug goes into the bug template, an idea into the feature template, praise
 * into a blank issue. The text is cut at FEEDBACK_PREFILL_MAX characters so
 * the address stays short enough for every browser; the form's *Copy text*
 * button has the whole of it.
 */
function buildFeedbackIssueUrl({ kind, message, diagnostics } = {}) {
  const text = clip(String(message ?? '').trim(), FEEDBACK_PREFILL_MAX);
  const details = formatFeedbackDiagnostics(diagnostics);
  const params = new URLSearchParams();
  if (kind === 'bug') {
    params.set('template', 'bug_report.yml');
    params.set('description', text);
    if (diagnostics?.appVersion) params.set('version', diagnostics.appVersion);
    if (details) params.set('logs', details);
  } else if (kind === 'idea') {
    params.set('template', 'feature_request.yml');
    params.set('problem', text);
  } else {
    const firstLine = [...(text.split('\n')[0] || '')].slice(0, 72).join('');
    params.set('title', firstLine);
    params.set('body', details ? `${text}\n\n---\n${details}` : text);
  }
  return `${FEEDBACK_REPO_URL}/issues/new?${params.toString()}`;
}

module.exports = {
  FEEDBACK_KINDS,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_EMAIL_MAX,
  FEEDBACK_COUNTER_FROM,
  FEEDBACK_PREFILL_MAX,
  FEEDBACK_REPO_URL,
  FEEDBACK_PRIVACY_URL,
  isFeedbackKind,
  feedbackLength,
  isFeedbackEmail,
  formatFeedbackDiagnostics,
  buildFeedbackIssueUrl,
};
