// The default view: a text file as it is, character for character (#225).
//
// It takes every file `isTextFile` recognises and nobody further up in the
// registry claims. The interface it implements is documented in the header of
// `registry.js`.
//
// Source text is coloured by its file name (#745, syntax-language.js). The
// colours are spans around the same characters: selecting and copying still
// gives the file as it is. A file up to COLOUR_AT_ONCE_LIMIT is shown coloured
// right away; a larger one first as plain text and coloured once the pane has
// been drawn, so that opening it never waits on the highlighter; beyond
// COLOUR_LIMIT it stays plain.

import { isTextFile } from '../utils/helpers.js';
import { syntaxLanguageFor } from './syntax-language.js';
import { highlightToFragment } from './syntax-highlight.js';

export const COLOUR_AT_ONCE_LIMIT = 64 * 1024;
export const COLOUR_LIMIT = 512 * 1024;

/** After the next frame has been drawn — not merely before it. */
function afterPaint(fn) {
  let timer = 0;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(fn, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

export const plainTextView = {
  id: 'plain-text',
  kind: 'viewer',

  canHandle({ name }) {
    return isTextFile(name);
  },

  mount(hostEl, { content, file }) {
    const pre = document.createElement('pre');
    pre.id = 'preview-content';
    const language = syntaxLanguageFor(file?.name);
    if (language) pre.dataset.language = language;
    hostEl.append(pre);

    let cancelPending = () => {};

    // Same node, new children: the scroll position is carried over by hand,
    // which is what a reload of the same file wants.
    function replace(fragmentOrText) {
      const { scrollTop, scrollLeft } = pre;
      if (typeof fragmentOrText === 'string') pre.textContent = fragmentOrText;
      else pre.replaceChildren(fragmentOrText);
      pre.scrollTop = scrollTop;
      pre.scrollLeft = scrollLeft;
    }

    function show(text) {
      cancelPending();
      cancelPending = () => {};
      const colourable = !!language && text.length <= COLOUR_LIMIT;
      const atOnce = colourable && text.length <= COLOUR_AT_ONCE_LIMIT ? highlightToFragment(text, language) : null;
      replace(atOnce ?? text);
      pre.dataset.highlighted = String(!!atOnce);
      if (atOnce || !colourable || text.length <= COLOUR_AT_ONCE_LIMIT) return;
      cancelPending = afterPaint(() => {
        const fragment = highlightToFragment(text, language);
        if (!fragment) return;
        replace(fragment);
        pre.dataset.highlighted = 'true';
      });
    }

    show(content ?? '');

    return {
      update({ content: next }) {
        show(next ?? '');
      },
      unmount() {
        cancelPending();
      },
    };
  },
};
