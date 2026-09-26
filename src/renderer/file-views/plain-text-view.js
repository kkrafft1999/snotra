// The default view: a text file as it is, character for character (#225).
//
// It takes every file `isTextFile` recognises and nobody further up in the
// registry claims. The interface it implements is documented in the header of
// `registry.js`.

import { isTextFile } from '../utils/helpers.js';

export const plainTextView = {
  id: 'plain-text',
  kind: 'viewer',

  canHandle({ name }) {
    return isTextFile(name);
  },

  mount(hostEl, { content }) {
    const pre = document.createElement('pre');
    pre.id = 'preview-content';
    pre.textContent = content;
    hostEl.append(pre);

    return {
      // Same node, new text: the browser keeps the scroll position as far as
      // the new length allows, which is what a reload of the same file wants.
      update({ content: next }) {
        pre.textContent = next;
      },
      unmount() {},
    };
  },
};
