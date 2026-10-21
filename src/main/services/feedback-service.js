'use strict';

/**
 * Sends the feedback form (#1045) to the endpoint on the website, which files
 * it as a public issue in this repository (kkrafft1999/snotra-promotion#153,
 * contract in `docs/feedback-endpoint.md` there).
 *
 * This is not telemetry: nothing goes out unless the user presses *Send*, and
 * what goes out is what the form showed — the message, an address if one was
 * typed, and the four diagnostic values if the box stayed ticked. Chat
 * contents, paths and keys never reach this service.
 *
 * The window is not trusted with the request: it hands over what the user
 * typed, and main checks it again, picks the diagnostics itself and decides
 * where it goes. The answer comes back as a reason the form puts into words,
 * never as the server's text.
 */

const {
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_REPO_URL,
  isFeedbackKind,
  feedbackLength,
  isFeedbackEmail,
} = require('../../shared/contracts/feedback');

const FEEDBACK_ENDPOINT = 'https://snotra-ai.dev/api/feedback';
/** Set to a loopback address, the e2e tests send to a fake endpoint instead. */
const FEEDBACK_ENDPOINT_ENV = 'SNOTRA_FEEDBACK_ENDPOINT';
const FEEDBACK_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** @type {Record<string, string>} */
const OS_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
/** The endpoint takes each diagnostic value as one line of at most 100 characters. */
const DIAGNOSTIC_MAX = 100;
const ISSUE_URL_PREFIX = `${FEEDBACK_REPO_URL}/issues/`;

/**
 * Only a loopback address may replace the real endpoint.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveFeedbackEndpoint(env = process.env) {
  const raw = typeof env?.[FEEDBACK_ENDPOINT_ENV] === 'string' ? env[FEEDBACK_ENDPOINT_ENV].trim() : '';
  if (!raw) return FEEDBACK_ENDPOINT;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.toString();
  } catch {
    // fall through to the real one
  }
  return FEEDBACK_ENDPOINT;
}

/** @param {unknown} value */
function diagnosticValue(value) {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim();
  return [...line].slice(0, DIAGNOSTIC_MAX).join('');
}

/**
 * @param {unknown} locale
 * @returns {locale is string}
 */
function isLocaleTag(locale) {
  return typeof locale === 'string'
    && locale.length <= 35
    && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(locale);
}

/**
 * What the window hands over; it comes over IPC, so every field is checked.
 *
 * @typedef {{ kind?: unknown, message?: unknown, email?: unknown, includeDiagnostics?: unknown,
 *   providerId?: unknown, locale?: unknown }} FeedbackInput
 */

/**
 * What the form is told when a message did not go out; `reason` is a key it puts into words.
 *
 * @typedef {{ ok: true, issueUrl: string | null }
 *   | { ok: false, reason: string, retryAfter?: number | null }} FeedbackResult
 */

/**
 * @param {string} reason
 * @param {{ retryAfter?: number | null }} [extra]
 * @returns {FeedbackResult}
 */
function failure(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

/**
 * @param {Response} response
 * @returns {Promise<{ retryAfter?: unknown, issueUrl?: unknown, error?: unknown }|null>}
 */
async function readJson(response) {
  try {
    const json = await response.json();
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/**
 * @param {Response} response
 * @param {{ retryAfter?: unknown }|null} body
 */
function retryAfterSeconds(response, body) {
  const fromBody = Number(body?.retryAfter);
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const fromHeader = Number(response.headers?.get?.('retry-after'));
  return Number.isFinite(fromHeader) && fromHeader > 0 ? Math.ceil(fromHeader) : null;
}

/**
 * The version of the operating system, as the form names it: Electron's
 * `process.getSystemVersion()` (macOS 15.1, not the Darwin kernel), and the
 * kernel release where there is no such call — plain Node, in tests.
 *
 * @param {{ getSystemVersion?: () => string }} proc  `process`
 * @param {{ release: () => string }} os
 * @returns {() => string}
 */
function osVersionReader(proc, os) {
  return () => (typeof proc.getSystemVersion === 'function' ? proc.getSystemVersion() : os.release());
}

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetchImpl
 * @param {() => string} deps.getAppVersion
 * @param {string} deps.platform           `process.platform`
 * @param {string} deps.arch               `process.arch`
 * @param {() => string} deps.getOsVersion e.g. `process.getSystemVersion()`
 * @param {(id: string) => boolean} deps.isKnownProvider  only a built-in provider is named
 * @param {string} [deps.endpoint]
 * @param {number} [deps.timeoutMs]
 */
function createFeedbackService({
  fetchImpl,
  getAppVersion,
  platform,
  arch,
  getOsVersion,
  isKnownProvider,
  endpoint = FEEDBACK_ENDPOINT,
  timeoutMs = FEEDBACK_TIMEOUT_MS,
}) {
  /**
   * The four values the form shows and may send. A provider the user set up
   * under a name of their own is not named — only a built-in one is.
   */
  /** @param {unknown} providerId */
  function getDiagnostics(providerId) {
    let osVersion = '';
    try {
      osVersion = getOsVersion?.() || '';
    } catch {
      osVersion = '';
    }
    const known = typeof providerId === 'string' && providerId && isKnownProvider?.(providerId);
    return {
      appVersion: diagnosticValue(getAppVersion?.()),
      os: diagnosticValue([OS_NAMES[platform] || platform, osVersion].filter(Boolean).join(' ')),
      arch: diagnosticValue(arch),
      provider: known ? diagnosticValue(providerId) : '',
    };
  }

  /**
   * Checks the form's input; null when it holds, else the reason.
   *
   * @param {FeedbackInput|null|undefined} input
   */
  function invalidReason(input) {
    if (!input || typeof input !== 'object') return 'invalid';
    if (!isFeedbackKind(input.kind)) return 'invalid';
    if (typeof input.message !== 'string' || feedbackLength(input.message) === 0) return 'emptyMessage';
    if (feedbackLength(input.message) > FEEDBACK_MESSAGE_MAX) return 'tooLong';
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    if (input.email != null && typeof input.email !== 'string') return 'invalid';
    if (email && !isFeedbackEmail(email)) return 'invalidEmail';
    return null;
  }

  /** @param {FeedbackInput} input  already through `invalidReason` */
  function buildBody(input) {
    /** @type {{ kind: string, message: string, email?: string, diagnostics?: Record<string, string>, locale?: string }} */
    const body = { kind: String(input.kind), message: String(input.message).trim() };
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    if (email) body.email = email;
    if (input.includeDiagnostics === true) {
      const diagnostics = Object.fromEntries(
        Object.entries(getDiagnostics(input.providerId)).filter(([, value]) => value)
      );
      if (Object.keys(diagnostics).length) body.diagnostics = diagnostics;
    }
    if (isLocaleTag(input.locale)) body.locale = input.locale;
    return body;
  }

  /**
   * @param {FeedbackInput} input
   * @returns {Promise<FeedbackResult>}
   *   reason: emptyMessage, tooLong, invalidEmail, duplicate, rateLimited,
   *   timeout, network, server or invalid.
   */
  async function send(input) {
    const invalid = invalidReason(input);
    if (invalid) return failure(invalid);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(buildBody(input)),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      clearTimeout(timer);
      return failure(timedOut ? 'timeout' : 'network');
    }

    try {
      const body = await readJson(response);
      if (response.status === 201) {
        const reported = body?.issueUrl;
        const issueUrl = typeof reported === 'string' && reported.startsWith(ISSUE_URL_PREFIX) ? reported : null;
        return { ok: true, issueUrl };
      }
      if (response.status === 409) return failure('duplicate');
      if (response.status === 413) return failure('tooLong');
      if (response.status === 429) return failure('rateLimited', { retryAfter: retryAfterSeconds(response, body) });
      if (response.status === 400 && body?.error === 'invalid_email') return failure('invalidEmail');
      return failure(response.status >= 400 && response.status < 500 && response.status !== 408 ? 'invalid' : 'server');
    } catch {
      return failure(timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  return { getDiagnostics, send };
}

module.exports = {
  FEEDBACK_ENDPOINT,
  FEEDBACK_ENDPOINT_ENV,
  createFeedbackService,
  osVersionReader,
  resolveFeedbackEndpoint,
};
