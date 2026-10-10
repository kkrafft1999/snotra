/**
 * "Information" for an entry in the file tree (#849, before that #123).
 *
 * Main gathers the facts and pushes them over fs:show-info, already worded in
 * the interface language — field names, the type, the size and the dates come
 * from `services/file-info.js`, the label of "Reveal" from the platform. This
 * file only draws them and handles the three things that can be done from
 * here: copy the path, reveal the entry, close.
 *
 * The dialog is rebuilt on every open, like the native one before it; a
 * language change while it is up changes its own labels, not the facts.
 */

import { t, onLocaleChange } from '../i18n.js';

const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** How long the check mark stays on the copy button. */
const COPIED_MS = 2000;

export function initFileInfoDialog({ api }) {
  const root = document.getElementById('modal-file-info');
  const backdrop = document.getElementById('modal-file-info-backdrop');
  const dialog = root?.querySelector('.file-info-dialog');
  const nameEl = document.getElementById('modal-file-info-name');
  const summaryEl = document.getElementById('modal-file-info-summary');
  const pathEl = document.getElementById('modal-file-info-path');
  const copyBtn = document.getElementById('modal-file-info-copy');
  const detailsEl = document.getElementById('modal-file-info-details');
  const revealBtn = document.getElementById('modal-file-info-reveal');
  const revealLabelEl = document.getElementById('modal-file-info-reveal-label');
  const statusEl = document.getElementById('modal-file-info-status');
  const okBtn = document.getElementById('modal-file-info-ok');
  const closeBtn = document.getElementById('modal-file-info-close');

  if (!root || !dialog || !api?.onFsShowInfo) {
    return { show: () => {}, isOpen: () => false };
  }

  let current = null;
  let lastFocused = null;
  let copiedTimer = null;
  /** null | 'copied' | 'copyFailed' | 'revealFailed' — redrawn on a language change. */
  let status = null;

  function isOpen() {
    return !root.classList.contains('hidden');
  }

  function setStatus(next) {
    status = next;
    statusEl.textContent = next ? t(`fileInfoDialog.${next}`) : '';
    statusEl.classList.toggle('file-info-dialog__status--error', next === 'copyFailed' || next === 'revealFailed');
    const done = next === 'copied';
    copyBtn.classList.toggle('file-info-dialog__copy--done', done);
    const label = t(done ? 'fileInfoDialog.copied' : 'fileInfoDialog.copyPath');
    copyBtn.setAttribute('aria-label', label);
    copyBtn.setAttribute('title', label);
  }

  function clearCopiedTimer() {
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = null;
  }

  function render(info) {
    dialog.classList.toggle('file-info-dialog--folder', info.kind === 'folder');
    nameEl.textContent = info.name || '';
    // Type and short size on one line; either may be missing (a folder that
    // could not be read has no count).
    summaryEl.textContent = [info.type, info.summary].filter(Boolean).join(' · ');
    pathEl.textContent = info.path || '';
    detailsEl.replaceChildren();
    for (const [label, value] of Array.isArray(info.details) ? info.details : []) {
      const dt = document.createElement('dt');
      dt.textContent = String(label);
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      detailsEl.append(dt, dd);
    }
    revealLabelEl.textContent = info.revealLabel || '';
    revealBtn.classList.toggle('hidden', !info.revealLabel || !api.revealItem);
    copyBtn.disabled = !info.path || !api.writeClipboardText;
    clearCopiedTimer();
    setStatus(null);
  }

  function show(info) {
    if (!info || typeof info !== 'object') return;
    current = info;
    render(info);
    if (!isOpen()) {
      lastFocused = document.activeElement;
      root.classList.remove('hidden');
      root.setAttribute('aria-hidden', 'false');
    }
    okBtn.focus();
  }

  function close() {
    if (!isOpen()) return;
    clearCopiedTimer();
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    current = null;
    const back = lastFocused;
    lastFocused = null;
    if (back && back.isConnected) back.focus();
  }

  async function copyPath() {
    if (!current?.path) return;
    const shown = current;
    let ok = false;
    try {
      const result = await api.writeClipboardText(current.path);
      ok = result?.ok !== false;
    } catch {
      ok = false;
    }
    // Closed or replaced while the clipboard was busy: nothing to report on.
    if (current !== shown) return;
    clearCopiedTimer();
    setStatus(ok ? 'copied' : 'copyFailed');
    if (ok) {
      copiedTimer = setTimeout(() => {
        copiedTimer = null;
        if (status === 'copied') setStatus(null);
      }, COPIED_MS);
    }
  }

  async function reveal() {
    if (!current?.itemPath || !api.revealItem) return;
    const shown = current;
    let ok = false;
    try {
      const result = await api.revealItem(current.itemPath);
      ok = Boolean(result) && !result.error;
    } catch {
      ok = false;
    }
    if (current !== shown) return;
    if (ok) close();
    else setStatus('revealFailed');
  }

  api.onFsShowInfo((payload) => show(payload));

  copyBtn.addEventListener('click', copyPath);
  revealBtn.addEventListener('click', reveal);
  okBtn.addEventListener('click', close);
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
      .filter((el) => !el.disabled && !el.closest('.hidden'));
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

  // The static labels follow through data-i18n; the copy button and the
  // status line are set from here and redrawn the same way.
  onLocaleChange(() => {
    if (isOpen()) setStatus(status);
  });

  return { show, isOpen };
}
