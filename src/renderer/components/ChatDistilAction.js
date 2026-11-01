import { onLocaleChange, t } from '../i18n.js';

/**
 * The room the chat title keeps beside the labelled button; with less, the
 * button shows only its icon (#1317).
 *
 * Measured in the real app (e2e/manual-distil-action.mjs): the labelled button
 * is 174 px wide in English and 188 px in German, the kind pill beside the
 * title 106 px ("Unclassified") or 138 px ("Nicht eingeordnet"). A fixed panel
 * width cannot serve both: the label fits from about 560 px in English, from
 * about 640 px in German, and longer kinds move it again. So the breakpoint is
 * measured where it falls — the label shows while the title keeps at least
 * this much room, enough for two or three words.
 */
export const DISTIL_MIN_TITLE_ROOM_PX = 130;

/** Icon, gap and the button's own padding and border around the label. */
const LABELLED_CHROME_PX = 14 + 6 + 10 + 12 + 2;

/**
 * "Distil into knowledge…" in the chat header (#1317, mockup variant A).
 *
 * A click sends a visible request in the interface language; snotra-memory
 * answers it with one approval card per item (#1316). The button cannot run
 * while an answer is on its way or before the chat has a question, and then
 * says why: it is `aria-disabled`, not `disabled`, so it keeps its tooltip and
 * its place in the tab order, and the reason is its description.
 *
 * @param {{
 *   appStore: { chatMessages?: any[], chatInFlight?: boolean },
 *   send: (text: string) => unknown,
 * }} deps
 */
export function initChatDistilAction({ appStore, send }) {
  const button = document.getElementById('btn-chat-distil');
  const reason = document.getElementById('chat-distil-reason');
  const header = document.getElementById('chat-header');
  if (!button || !reason) return { sync() {}, state: () => 'missing' };
  const label = button.querySelector('.chat-distil-label');

  /** 'running', 'empty' or 'ready' — the first two say why it cannot run. */
  function state() {
    if (appStore.chatInFlight) return 'running';
    const messages = Array.isArray(appStore.chatMessages) ? appStore.chatMessages : [];
    const asked = messages.some((m) => m && m.role === 'user' && !m.greeting);
    return asked ? 'ready' : 'empty';
  }

  /**
   * Whether the title would keep less than DISTIL_MIN_TITLE_ROOM_PX beside the
   * labelled button. Read from the header as it stands; the label's
   * scrollWidth is its full width even while it is clipped.
   */
  function tooNarrow() {
    if (!header || !label) return false;
    const width = header.clientWidth;
    if (!width) return false;
    const style = getComputedStyle(header);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const gap = parseFloat(style.columnGap) || 0;
    const dot = document.getElementById('chat-live-dot');
    const kindWrap = document.getElementById('chat-kind-wrap');
    const kindPill = document.getElementById('btn-chat-kind');
    const meta = header.querySelector('.chat-header-meta');
    const metaGap = meta ? parseFloat(getComputedStyle(meta).columnGap) || 0 : 0;
    const dotWidth = dot ? dot.getBoundingClientRect().width + metaGap : 0;
    // The pill's natural width, also while the labelled button squeezes it:
    // its word is cut inside the label span, which keeps the full width as
    // its scrollWidth.
    const kindLabel = document.getElementById('chat-kind-label');
    const kindWidth = kindWrap && kindPill && !kindWrap.classList.contains('hidden')
      ? kindPill.scrollWidth + 2 + metaGap + (kindLabel ? kindLabel.scrollWidth - kindLabel.clientWidth : 0)
      : 0;
    const labelled = label.scrollWidth + LABELLED_CHROME_PX;
    const room = width - padding - gap - labelled - dotWidth - kindWidth;
    return room < DISTIL_MIN_TITLE_ROOM_PX;
  }

  function sync() {
    const current = state();
    const text = current === 'running'
      ? t('chat.distil.running')
      : current === 'empty' ? t('chat.distil.empty') : t('chat.distil.description');
    if (current === 'ready') button.removeAttribute('aria-disabled');
    else button.setAttribute('aria-disabled', 'true');
    button.dataset.state = current;
    reason.textContent = text;
    const compact = tooNarrow();
    button.classList.toggle('chat-distil--compact', compact);
    // Without its label the tooltip has to name the action as well.
    button.title = compact ? `${t('chat.distil.label')}\n${text}` : text;
  }

  button.addEventListener('click', () => {
    if (state() !== 'ready') return;
    // sendChatMessage records its own refusals; what throws past it is said here.
    Promise.resolve()
      .then(() => send(t('chat.distil.prompt')))
      .catch((error) => console.warn('[distil] the request was not sent:', error));
  });

  // The panel's width, and the kind pill coming, going or changing its word.
  if (header && typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => sync());
    observer.observe(header);
    const kindWrap = document.getElementById('chat-kind-wrap');
    if (kindWrap) observer.observe(kindWrap);
  }
  // After applyTranslations has put the new label in: its width changes too.
  onLocaleChange(() => {
    sync();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => sync());
  });
  sync();
  return { sync, state };
}
