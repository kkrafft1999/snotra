/**
 * The dictation inside the chat input (#859).
 *
 * While a recording runs, what is said goes straight into the input field,
 * where the caret was, and stays editable. The text comes in turns: a turn
 * grows word by word while it is spoken and is settled once the speaker pauses.
 * A settled turn is written into the field once and then belongs to the user —
 * a misheard word can be put right while the recording goes on. The turn still
 * being spoken is rewritten with every word and cannot be edited; an edit that
 * would touch it is refused.
 *
 * Until the recording ends, the whole dictation is shown grey and in italics.
 * A textarea cannot style part of its text, so it draws its text transparent
 * and a mirror behind it, laid out the same way, draws the text instead. Inter
 * has no italic face here; the browser slants the upright one, which keeps
 * every glyph's width — so caret and selection still line up with the mirror.
 *
 * Positions are offsets into `input.value`:
 *
 *   ...typed before | settled dictation | provisional turn | typed after...
 *                   ^ start             ^ liveStart        ^ liveStart + live.length
 */

const needsSpaceAfter = (char) => char !== undefined && !/\s/.test(char);
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function createDictationField({ input, mirror, onInputChanged = () => {} }) {
  const field = mirror.parentElement;
  let active = false;
  let start = 0;
  let liveStart = 0;
  let live = '';
  // How many turns are already in the field as settled text.
  let settledTurns = 0;
  // Whether begin() put a space between the dictation and the text after it.
  let spacer = false;
  // The selection before an edit, read back once the edit happened.
  let pending = null;

  function render() {
    if (!active) {
      mirror.replaceChildren();
      return;
    }
    const { value } = input;
    const end = liveStart + live.length;
    const dictation = document.createElement('span');
    dictation.className = 'chat-dictation';
    dictation.textContent = value.slice(start, end);
    // A trailing line break only counts as a line once something follows it.
    const after = value.slice(end) + (value.endsWith('\n') ? '​' : '');
    mirror.replaceChildren(value.slice(0, start), dictation, after);
    mirror.scrollTop = input.scrollTop;
  }

  /** Writes `next` into the field and moves the selection along with `map`. */
  function setValue(next, map) {
    const { selectionStart, selectionEnd, selectionDirection } = input;
    input.value = next;
    input.setSelectionRange(map(selectionStart), map(selectionEnd), selectionDirection || 'none');
    onInputChanged();
  }

  /**
   * Finds the dictation again after the field was changed behind its back —
   * an `@` mention or a skill put in by their menus.
   */
  function resync() {
    const { value } = input;
    if (value.slice(liveStart, liveStart + live.length) === live && liveStart <= value.length) return;
    const at = live ? value.lastIndexOf(live) : -1;
    if (at >= 0) {
      start = Math.max(0, Math.min(start + (at - liveStart), at));
      liveStart = at;
      return;
    }
    live = '';
    liveStart = Math.min(liveStart, value.length);
    start = Math.min(start, liveStart);
  }

  function begin() {
    const at = Math.min(input.selectionEnd ?? input.value.length, input.value.length);
    active = true;
    start = at;
    liveStart = at;
    live = '';
    settledTurns = 0;
    spacer = needsSpaceAfter(input.value[at]);
    if (spacer) {
      const { value } = input;
      setValue(`${value.slice(0, at)} ${value.slice(at)}`, (p) => (p > at ? p + 1 : p));
    }
    field.dataset.dictating = 'true';
    render();
  }

  /** Takes the turns so far, `{ text, final }` in spoken order. */
  function update(turns) {
    if (!active || !Array.isArray(turns)) return;
    resync();
    const { value } = input;
    let next = settledTurns;
    let insert = '';
    const charBefore = () => (insert ? insert[insert.length - 1] : value[liveStart - 1]);
    while (next < turns.length && turns[next]?.final) {
      const text = clean(turns[next].text);
      if (text) insert += (needsSpaceAfter(charBefore()) ? ' ' : '') + text;
      next += 1;
    }
    settledTurns = next;
    const spoken = turns.slice(next).map((turn) => clean(turn?.text)).filter(Boolean).join(' ');
    const nextLive = spoken ? (needsSpaceAfter(charBefore()) ? ' ' : '') + spoken : '';
    rewrite(insert, nextLive);
  }

  /**
   * Takes the turn being spoken out of the field — the fallback hears its
   * audio again (#859).
   */
  function dropLive() {
    if (!active) return;
    resync();
    rewrite('', '');
  }

  /** Puts text heard some other way in as settled — the fallback's. */
  function appendSettled(text) {
    if (!active) return;
    resync();
    const words = clean(text);
    if (!words) return;
    rewrite((needsSpaceAfter(input.value[liveStart - 1]) ? ' ' : '') + words, '');
  }

  /** Writes `insert` as settled text and `nextLive` as the turn being spoken. */
  function rewrite(insert, nextLive) {
    if (!insert && nextLive === live) return;
    const { value } = input;
    const oldStart = liveStart;
    const oldEnd = liveStart + live.length;
    const newStart = liveStart + insert.length;
    const newEnd = newStart + nextLive.length;
    // A caret at the end of the dictation follows it; one inside the turn being
    // spoken goes to its end; one in front of it stays where the user put it.
    setValue(
      value.slice(0, oldStart) + insert + nextLive + value.slice(oldEnd),
      (p) => (p >= oldEnd ? p + (newEnd - oldEnd) : p > oldStart ? newEnd : p),
    );
    liveStart = newStart;
    live = nextLive;
    render();
  }

  /**
   * Ends the dictation; everything in the field is plain text from now on.
   * Returns whether anything was dictated (or typed into the dictation).
   */
  function end() {
    if (!active) return false;
    resync();
    const said = liveStart > start || live.length > 0;
    if (spacer && !said && input.value[start] === ' ') {
      const { value } = input;
      setValue(value.slice(0, start) + value.slice(start + 1), (p) => (p > start ? p - 1 : p));
    }
    active = false;
    live = '';
    delete field.dataset.dictating;
    render();
    return said;
  }

  input.addEventListener('beforeinput', (event) => {
    if (!active) return;
    const { selectionStart: from, selectionEnd: to } = input;
    const liveEnd = liveStart + live.length;
    if (live) {
      const type = event.inputType || '';
      const deleting = type.startsWith('delete');
      const forward = type.endsWith('Forward');
      const touchesLive = from === to
        ? (from > liveStart && from < liveEnd)
          || (deleting && forward && from === liveStart)
          || (deleting && !forward && from === liveEnd)
        : from < liveEnd && to > liveStart;
      if (touchesLive) {
        event.preventDefault();
        return;
      }
    }
    pending = { from, to, length: input.value.length, type: event.inputType || '' };
  });

  input.addEventListener('input', () => {
    if (!active) return;
    const edit = pending;
    pending = null;
    if (edit) {
      const delta = input.value.length - edit.length;
      let { from, to } = edit;
      // A collapsed delete took its characters from one side of the caret.
      if (from === to && delta < 0) {
        if (edit.type.endsWith('Backward')) from = to + delta;
        else to = from - delta;
      }
      const inserted = to - from + delta;
      if (to <= start) {
        // In front of the dictation: it moves along.
        start += delta;
        liveStart += delta;
      } else if (from <= liveStart) {
        // In the settled part, or at its end — the user's correction is part
        // of the dictation.
        if (from < start) start = from;
        liveStart = to >= liveStart ? from + inserted : liveStart + delta;
      }
      // Behind the dictation nothing moves.
    }
    render();
  });

  input.addEventListener('scroll', () => {
    if (active) mirror.scrollTop = input.scrollTop;
  });

  return {
    begin,
    update,
    dropLive,
    appendSettled,
    end,
    isActive: () => active,
  };
}
