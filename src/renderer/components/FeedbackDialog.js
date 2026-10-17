/**
 * The feedback form (#1045): *Help › Send Feedback…* and the speech bubble at
 * the foot of the sidebar open it.
 *
 * A message goes to the endpoint on the website, which files it as a public
 * issue on GitHub. The form says so before anything is sent, shows the
 * diagnostics that would go along and lets them be unticked. Main sends the
 * request; this file only collects what the user typed and draws the states:
 * editing → sending → sent, or back to editing with an error.
 *
 * Nothing typed is lost: closing the dialog keeps the draft for the next
 * open, and a failure keeps the text and offers two ways round the endpoint —
 * copy the text, or open GitHub's own issue form prefilled.
 */

import contracts from '../generated/contracts.js';
import { t, tPlural, getLocale, onLocaleChange } from '../i18n.js';

const {
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_COUNTER_FROM,
  FEEDBACK_PRIVACY_URL,
  feedbackLength,
  isFeedbackEmail,
  formatFeedbackDiagnostics,
  buildFeedbackIssueUrl,
} = contracts;

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** How long "Text copied" stays. */
const COPIED_MS = 2000;
/** The failures after which the endpoint is not worth another try right now. */
const FALLBACK_REASONS = new Set(['rateLimited', 'timeout', 'network', 'server', 'invalid']);

export function initFeedbackDialog({ api, appStore }) {
  const root = document.getElementById('modal-feedback');
  const dialog = root?.querySelector('.feedback-dialog');
  if (!root || !dialog || !api?.sendFeedback) {
    return { open: () => {}, isOpen: () => false };
  }
  const $ = (id) => document.getElementById(id);
  const backdrop = $('modal-feedback-backdrop');
  const closeBtn = $('modal-feedback-close');
  const form = $('feedback-form');
  const kindInputs = Array.from(root.querySelectorAll('input[name="feedback-kind"]'));
  const messageEl = $('feedback-message');
  const messageError = $('feedback-message-error');
  const counterEl = $('feedback-message-counter');
  const emailEl = $('feedback-email');
  const emailError = $('feedback-email-error');
  const diagnosticsBox = $('feedback-diagnostics');
  const diagnosticsValues = $('feedback-diagnostics-values');
  const privacyLink = $('feedback-privacy-link');
  const statusEl = $('feedback-status');
  const fallbackEl = $('feedback-fallback');
  const copyBtn = $('feedback-copy');
  const githubBtn = $('feedback-github');
  const sentEl = $('feedback-sent');
  const sentBody = $('feedback-sent-body');
  const cancelBtn = $('feedback-cancel');
  const sendBtn = $('feedback-send');
  const openIssueBtn = $('feedback-open-issue');
  const doneBtn = $('feedback-done');

  /** 'editing' | 'sending' | 'sent' */
  let phase = 'editing';
  /** The reason of the last failure, redrawn on a language change. */
  let failure = null;
  /** 'copied' | 'copyFailed' | null — the fallback's own line. */
  let copyStatus = null;
  let copiedTimer = null;
  let diagnostics = null;
  let issueUrl = null;
  let lastFocused = null;

  function isOpen() {
    return !root.classList.contains('hidden');
  }

  function currentKind() {
    return kindInputs.find((input) => input.checked)?.value || 'idea';
  }

  function providerId() {
    const llm = appStore?.llmState;
    return llm?.chatTarget?.providerId || llm?.activeProvider || '';
  }

  function drawPlaceholder() {
    messageEl.placeholder = t(`feedback.message.placeholder.${currentKind()}`);
  }

  function drawCounter() {
    const length = feedbackLength(messageEl.value);
    const over = length - FEEDBACK_MESSAGE_MAX;
    counterEl.hidden = length < FEEDBACK_COUNTER_FROM;
    counterEl.classList.toggle('feedback-dialog__counter--over', over > 0);
    counterEl.textContent = over > 0
      ? tPlural('feedback.message.over', over, { count: over.toLocaleString(getLocale()) })
      : tPlural('feedback.message.left', -over, { count: (-over).toLocaleString(getLocale()) });
  }

  /** The error under a field, by key, so a language change can redraw it. */
  const fieldErrors = new Map();

  function setFieldError(field, errorEl, key) {
    fieldErrors.set(errorEl, key);
    errorEl.hidden = !key;
    errorEl.textContent = key ? t(key, { max: FEEDBACK_MESSAGE_MAX.toLocaleString(getLocale()) }) : '';
    if (key) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  }

  function drawDiagnostics() {
    diagnosticsValues.textContent = formatFeedbackDiagnostics(diagnostics);
  }

  /** The status line under the form: an error, "Sending…", or nothing. */
  function drawStatus() {
    statusEl.classList.toggle('feedback-dialog__status--error', Boolean(failure));
    if (phase === 'sending') statusEl.textContent = t('feedback.sending');
    else if (failure) statusEl.textContent = t(`feedback.error.${failure}`, { max: FEEDBACK_MESSAGE_MAX.toLocaleString(getLocale()) });
    else statusEl.textContent = '';
    fallbackEl.hidden = !(failure && FALLBACK_REASONS.has(failure));
    copyBtn.textContent = t(copyStatus === 'copied' ? 'feedback.fallback.copied' : 'feedback.fallback.copy');
    if (copyStatus === 'copyFailed') statusEl.textContent += ` ${t('feedback.fallback.copyFailed')}`;
  }

  function drawPhase() {
    const sending = phase === 'sending';
    const sent = phase === 'sent';
    root.classList.toggle('modal-feedback--busy', sending);
    form.hidden = sent;
    sentEl.hidden = !sent;
    for (const el of [...kindInputs, messageEl, emailEl, diagnosticsBox]) el.disabled = sending;
    cancelBtn.hidden = sent;
    cancelBtn.disabled = sending;
    sendBtn.hidden = sent;
    sendBtn.disabled = sending;
    sendBtn.textContent = t(sending ? 'feedback.sending' : 'feedback.send');
    sendBtn.setAttribute('aria-busy', sending ? 'true' : 'false');
    openIssueBtn.hidden = !sent || !issueUrl;
    doneBtn.hidden = !sent;
    if (sent) {
      const number = issueUrl?.match(/\/issues\/(\d+)$/)?.[1];
      sentBody.textContent = number
        ? t('feedback.sent.body', { number })
        : t('feedback.sent.bodyNoNumber');
    }
    drawStatus();
  }

  function clearCopiedTimer() {
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = null;
  }

  async function loadDiagnostics() {
    try {
      diagnostics = await api.getFeedbackDiagnostics?.(providerId());
    } catch {
      diagnostics = null;
    }
    drawDiagnostics();
  }

  function resetForm() {
    messageEl.value = '';
    emailEl.value = '';
    diagnosticsBox.checked = true;
    for (const input of kindInputs) input.checked = input.value === 'idea';
    setFieldError(messageEl, messageError, null);
    setFieldError(emailEl, emailError, null);
    failure = null;
    copyStatus = null;
    issueUrl = null;
    phase = 'editing';
  }

  function open() {
    if (phase === 'sent') resetForm();
    if (!isOpen()) {
      lastFocused = document.activeElement;
      root.classList.remove('hidden');
      root.setAttribute('aria-hidden', 'false');
    }
    drawPlaceholder();
    drawCounter();
    drawPhase();
    void loadDiagnostics();
    messageEl.focus();
  }

  function close() {
    if (!isOpen() || phase === 'sending') return;
    clearCopiedTimer();
    copyStatus = null;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    // A sent message is done with; a draft waits for the next open.
    if (phase === 'sent') resetForm();
    const back = lastFocused;
    lastFocused = null;
    if (back && back.isConnected) back.focus();
  }

  /** Checks the fields the way the endpoint will; focuses the first wrong one. */
  function validate() {
    const length = feedbackLength(messageEl.value);
    const email = emailEl.value.trim();
    let messageKey = null;
    if (length === 0) messageKey = 'feedback.error.emptyMessage';
    else if (length > FEEDBACK_MESSAGE_MAX) messageKey = 'feedback.error.tooLong';
    const emailKey = email && !isFeedbackEmail(email) ? 'feedback.error.invalidEmail' : null;
    setFieldError(messageEl, messageError, messageKey);
    setFieldError(emailEl, emailError, emailKey);
    if (messageKey) messageEl.focus();
    else if (emailKey) emailEl.focus();
    return !messageKey && !emailKey;
  }

  async function submit() {
    if (phase !== 'editing') return;
    failure = null;
    copyStatus = null;
    if (!validate()) {
      drawStatus();
      return;
    }
    phase = 'sending';
    drawPhase();
    let result;
    try {
      result = await api.sendFeedback({
        kind: currentKind(),
        message: messageEl.value,
        email: emailEl.value.trim(),
        includeDiagnostics: diagnosticsBox.checked,
        providerId: providerId(),
        locale: getLocale(),
      });
    } catch {
      result = { ok: false, reason: 'network' };
    }
    if (result?.ok) {
      phase = 'sent';
      issueUrl = result.issueUrl || null;
      drawPhase();
      doneBtn.focus();
      return;
    }
    phase = 'editing';
    const reason = result?.reason || 'server';
    // The two the user can fix sit at their field; everything else is a
    // failure of the way there, with the fallback under it.
    if (reason === 'invalidEmail') {
      setFieldError(emailEl, emailError, 'feedback.error.invalidEmail');
      drawPhase();
      emailEl.focus();
      return;
    }
    if (reason === 'emptyMessage' || reason === 'tooLong') {
      setFieldError(messageEl, messageError, `feedback.error.${reason}`);
      drawPhase();
      messageEl.focus();
      return;
    }
    failure = reason;
    drawPhase();
    (fallbackEl.hidden ? sendBtn : githubBtn).focus();
  }

  async function copyText() {
    let ok = false;
    try {
      const result = await api.writeClipboardText?.(messageEl.value.trim());
      ok = Boolean(api.writeClipboardText) && result?.ok !== false;
    } catch {
      ok = false;
    }
    clearCopiedTimer();
    copyStatus = ok ? 'copied' : 'copyFailed';
    drawStatus();
    if (ok) {
      copiedTimer = setTimeout(() => {
        copiedTimer = null;
        copyStatus = null;
        drawStatus();
      }, COPIED_MS);
    }
  }

  function openOnGitHub() {
    const url = buildFeedbackIssueUrl({
      kind: currentKind(),
      message: messageEl.value,
      diagnostics: diagnosticsBox.checked ? diagnostics : null,
    });
    void api.openExternal?.(url);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  // Cmd/Ctrl+Enter sends from the message field, as in the composer's habit
  // of other apps; a plain Enter is a new line.
  messageEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  });
  messageEl.addEventListener('input', () => {
    drawCounter();
    if (!messageError.hidden && feedbackLength(messageEl.value) > 0
      && feedbackLength(messageEl.value) <= FEEDBACK_MESSAGE_MAX) {
      setFieldError(messageEl, messageError, null);
    }
  });
  emailEl.addEventListener('input', () => {
    if (!emailError.hidden) setFieldError(emailEl, emailError, null);
  });
  for (const input of kindInputs) input.addEventListener('change', drawPlaceholder);
  privacyLink.addEventListener('click', (event) => {
    event.preventDefault();
    void api.openExternal?.(FEEDBACK_PRIVACY_URL);
  });
  copyBtn.addEventListener('click', copyText);
  githubBtn.addEventListener('click', openOnGitHub);
  openIssueBtn.addEventListener('click', () => {
    if (issueUrl) void api.openExternal?.(issueUrl);
  });
  doneBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  backdrop?.addEventListener('click', close);

  // Focus cage: Tab runs in a circle inside the dialog, Escape closes it.
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(dialog.querySelectorAll(FOCUSABLE))
      .filter((el) => !el.disabled && !el.closest('[hidden]') && !el.closest('.hidden')
        && !(el.type === 'radio' && !el.checked));
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  api.onOpenFeedback?.(() => open());

  // The static labels follow through data-i18n; what is set from here is
  // redrawn the same way.
  onLocaleChange(() => {
    if (!isOpen()) return;
    drawPlaceholder();
    drawCounter();
    drawPhase();
    setFieldError(messageEl, messageError, fieldErrors.get(messageError) || null);
    setFieldError(emailEl, emailError, fieldErrors.get(emailError) || null);
  });

  return { open, isOpen };
}
