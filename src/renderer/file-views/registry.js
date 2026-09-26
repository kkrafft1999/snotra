// File views: what the content pane shows for a file (#225).
//
// A *file view* turns one file into something on screen. It is either a
// **viewer**, which only shows, or an **editor**, which can also hold changes
// that are not on disk yet. Both go through the same registry and the same
// host (`host.js`); the only thing the host treats differently is that an
// editor may refuse to be closed while it holds unsaved changes.
//
// The registry is DOM-free: which view is responsible for which file can be
// decided and tested without a single node.
//
// ── Descriptor: what a view registers ──────────────────────────────────────
//
//   {
//     id: 'plain-text',               // unique and stable, e.g. for a later
//                                     // "open with" switch between candidates
//     kind: 'viewer' | 'editor',
//     canHandle(file) → boolean,      // file: { name, ext, size, mime }
//     mount(hostEl, context) → instance | Promise<instance>,
//   }
//
// `ext` is `getExtension(name)` — lower case, empty for `Makefile`, `LICENSE`
// and the like, which `canHandle` has to recognise by name. `mime` is always
// `undefined` today: the main process does not deliver one, the field is there
// so that it can be added later without changing the signature.
//
// ── Context: what the host hands to `mount` ────────────────────────────────
//
//   {
//     file: { path, name, ext, size, modified },
//     content,              // the file as UTF-8 text, read by the host
//     api,                  // window.electronAPI, for views that need more
//     workspaceRoot,        // the open folder, or null
//     openFile(path) → Promise<{ ok, reason? }>,
//                           // show another file of the workspace and select
//                           // it in the tree; reason 'outside' or 'not-found'
//     setTools(nodes),      // fill the tool area in the header (right-hand
//                           // side, next to the size); [] or null clears it
//     setDirty(dirty),      // editors only: "my buffer differs from the file"
//   }
//
// The header itself (file name, size) belongs to the pane, not to the view —
// it looks the same for every type. A view only ever touches `hostEl`, and the
// tool area through `setTools`.
//
// ── Instance: what `mount` returns ─────────────────────────────────────────
//
//   {
//     update({ content, size, modified }),  // the file changed on disk
//     unmount(),                            // remove listeners and timers;
//                                           // the host empties hostEl after it
//     save() → Promise<boolean>,            // editors only; false = failed,
//                                           // the editor stays open
//     command(name) → boolean,              // optional: a command from the
//                                           // menu, e.g. 'toggle-source';
//                                           // true when the view handled it
//   }
//
// Rules the host relies on:
//
//   * `update` is only called when the text on disk actually differs from what
//     the view was last given. A save of its own therefore does not come back
//     as an external change, and a viewer keeps its scroll position and text
//     selection when a neighbouring file is written.
//   * An **editor with unsaved changes must not drop them in `update`**. It
//     decides how to show the conflict; the host does not overwrite a buffer.
//   * `setDirty` is ignored for viewers — a viewer can never keep the user
//     from leaving a file.
//   * A fresh `mount` gets a fresh `hostEl` content: nothing, including the
//     scroll position, is inherited from the previous view.
//
// Every view reads text today. A view for images or PDFs (#345, #346) will
// read through its own channel; the descriptor then gets a way to say "don't
// read me as text", with text staying the default.

import { getExtension } from '../utils/helpers.js';
import { markdownView } from './markdown-view.js';
import { plainTextView } from './plain-text-view.js';

const KINDS = new Set(['viewer', 'editor']);

function assertDescriptor(view) {
  if (!view || typeof view.id !== 'string' || !view.id) {
    throw new TypeError('A file view needs a non-empty string id.');
  }
  if (!KINDS.has(view.kind)) {
    throw new TypeError(`File view "${view.id}" has kind "${view.kind}", expected viewer or editor.`);
  }
  for (const method of ['canHandle', 'mount']) {
    if (typeof view[method] !== 'function') {
      throw new TypeError(`File view "${view.id}" is missing ${method}().`);
    }
  }
}

/** What `canHandle` gets to see of a file — the same shape for every view. */
export function describeFile({ name, size } = {}) {
  const fileName = typeof name === 'string' ? name : '';
  return { name: fileName, ext: getExtension(fileName), size, mime: undefined };
}

/**
 * A registry over an explicit order: the first view that can handle a file
 * wins, unless the caller asks for a specific one among the candidates.
 */
export function createFileViewRegistry(views) {
  const ordered = [...views];
  const ids = new Set();
  for (const view of ordered) {
    assertDescriptor(view);
    if (ids.has(view.id)) throw new TypeError(`File view id "${view.id}" is registered twice.`);
    ids.add(view.id);
  }
  Object.freeze(ordered);

  /** Every view that can handle the file, in registry order. */
  function candidatesFor(file) {
    const described = describeFile(file);
    return ordered.filter((view) => view.canHandle(described));
  }

  /**
   * The view that shows the file, or null — then the pane falls back to the
   * file info card. `preferredId` picks one of the candidates (a remembered
   * "open with"); an id that cannot handle the file is ignored.
   */
  function resolve(file, preferredId) {
    const candidates = candidatesFor(file);
    if (preferredId) {
      const preferred = candidates.find((view) => view.id === preferredId);
      if (preferred) return preferred;
    }
    return candidates[0] ?? null;
  }

  return { views: ordered, candidatesFor, resolve };
}

/**
 * The views of the app. Order matters: specialised views go before
 * `plain-text`, which takes every text file nobody else claims.
 */
export const fileViews = createFileViewRegistry([markdownView, plainTextView]);
