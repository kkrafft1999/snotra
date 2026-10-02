// The content pane as host of the file views (#225).
//
// The file tree only says "show file X", "X changed", "X is gone". Everything
// the pane does with that lives here: reading the file, choosing a view from
// the registry, the header with name and size, the file info card as the last
// fallback, and the lifecycle of the active view — mount, update, unmount.
//
// **Unsaved changes.** An editor can hold changes that are not on disk. Every
// path that would replace or close it — another file, another folder, the file
// deleted — goes through `askToLeave()`, and only there. The answer comes from
// `confirmLeave({ file, reason })`, which resolves to 'save', 'discard' or
// 'cancel'. The dialog behind it belongs to the first editor — there is none:
// editing in the preview was dropped on 2026-09-26 (#226), the paths stay so
// that the question does not have to be reopened in the host. Until then the
// default keeps the buffer, because a lost edit is worse than a pane that
// stays where it is. Reasons: 'switch-file', 'switch-folder', 'file-removed'.
//
// Writing would go through the host as well, so that the host knows what is on
// disk after a save and does not hand it back to the editor as an external
// change.
//
// **Leaving the view from inside.** A view may point at another file — a link
// in a Markdown document (#344). It asks through `context.openFile(path)`; the
// host hands that to `openFile`, which the file tree provides, because only
// the tree knows the workspace, can select the file and can tell a file that
// is not there from one it just does not list. A `{ fragment }` next to the
// path stays with the host and reaches the view mounted for that path as
// `context.fragment` (#641) — the tree only ever opens the file.
//
// The interface of a view is documented in the header of `registry.js`.

import { t, onLocaleChange } from '../i18n.js';
import { formatSize, formatTimestamp, getExtension } from '../utils/helpers.js';
import { READ_FAILURES, readFailureMessageKey, readFailureOf } from './read-failures.js';
import { fileViews, readsText } from './registry.js';

const keepEditing = async () => 'cancel';

const noOpener = async () => ({ ok: false, reason: 'not-found' });

export function createFileViewHost({
  api,
  registry = fileViews,
  confirmLeave = keepEditing,
  openFile = noOpener,
  getWorkspaceRoot = () => null,
}) {
  const welcomeEl = document.getElementById('welcome');
  const filePreview = document.getElementById('file-preview');
  const previewFilename = document.getElementById('preview-filename');
  const previewTools = document.getElementById('preview-tools');
  const previewMeta = document.getElementById('preview-meta');
  const previewBody = document.getElementById('preview-body');
  const fileInfo = document.getElementById('file-info');
  const infoFilename = document.getElementById('info-filename');
  const infoSize = document.getElementById('info-size');
  const infoModified = document.getElementById('info-modified');
  const infoType = document.getElementById('info-type');
  const infoNote = document.getElementById('info-note');

  // What the pane shows, or null for the welcome screen:
  //   { item, file, view, instance, content, dirty, error, detail }
  // `view` without `instance` means a text view was chosen but the file could
  // not be read — the info card stands in, and a refresh tries again. `error`
  // is then a reason from `read-failures.js`, never a sentence.
  let current = null;
  // Every open() draws a number; a read that returns after a newer open() has
  // started is dropped instead of overwriting it.
  let generation = 0;
  let pendingAsk = null;
  // The `#section` a view's link asked for along with a file (#641): the
  // tree opens the file, and the next open() of that path hands it to the
  // view it mounts. Any other open() drops it.
  let pendingFragment = null;

  function teardown() {
    const shown = current;
    current = null;
    if (shown?.instance) {
      try {
        shown.instance.unmount();
      } catch (err) {
        console.warn(`File view "${shown.view.id}" failed to unmount:`, err?.message ?? err);
      }
    }
    previewBody.replaceChildren();
    setTools(null);
  }

  function setTools(nodes) {
    previewTools.replaceChildren(...(nodes ?? []));
    previewTools.hidden = previewTools.childElementCount === 0;
  }

  function showPane(which) {
    welcomeEl.classList.toggle('hidden', which !== 'welcome');
    filePreview.classList.toggle('hidden', which !== 'preview');
    fileInfo.classList.toggle('hidden', which !== 'info');
  }

  function showWelcome() {
    generation += 1;
    teardown();
    showPane('welcome');
  }

  function renderHeader() {
    previewFilename.textContent = current.file.name;
    // A long name gives way to the tool area and ends in an ellipsis (#344).
    previewFilename.title = current.file.name;
    const size = formatSize(current.file.size);
    previewMeta.textContent = current.detail ? `${size} · ${current.detail}` : size;
  }

  function renderInfo() {
    const { item, error } = current;
    infoFilename.textContent = item.name;
    infoSize.textContent = formatSize(item.size);
    infoModified.textContent = formatTimestamp(item.modified);
    infoType.textContent = getExtension(item.name) || t('fileInfo.type.unknown');
    // Why there is no preview, below the facts and in the interface language
    // (#641): main and a failed mount hand over a reason, not a sentence.
    infoNote.textContent = error ? t(readFailureMessageKey(error)) : '';
    infoNote.hidden = !error;
  }

  /** A read that failed: main's reason, and the size it measured, if any. */
  function showReadFailure(item, result, view) {
    const size = Number.isFinite(result?.size) ? result.size : item.size;
    showInfo({ ...item, size }, readFailureOf(result), view);
  }

  function showInfo(item, error, view) {
    teardown();
    current = {
      item,
      file: { path: item.path, name: item.name, ext: getExtension(item.name), size: item.size, modified: item.modified },
      view: view ?? null,
      instance: null,
      content: null,
      dirty: false,
      error: error ?? null,
    };
    showPane('info');
    renderInfo();
  }

  async function mountView(view, item, result, fragment = '') {
    teardown();
    const file = {
      path: item.path,
      name: item.name,
      ext: getExtension(item.name),
      size: result.size,
      modified: result.modified ?? item.modified,
    };
    const shown = {
      item, file, view, instance: null, content: result.content, dirty: false, error: null, detail: null,
    };
    current = shown;
    showPane('preview');
    renderHeader();

    // A fresh element per mount: nothing carries over from the previous view,
    // and a view that is still mounting when the pane has moved on writes into
    // a node that is no longer in the document.
    const hostEl = document.createElement('div');
    hostEl.className = 'file-view';
    hostEl.dataset.view = view.id;
    previewBody.append(hostEl);

    const context = {
      file: { ...file },
      content: result.content,
      fragment,
      api,
      workspaceRoot: getWorkspaceRoot() ?? null,
      openFile: (path, options) => (current === shown
        ? openFromView(path, options)
        : Promise.resolve({ ok: false, reason: 'stale' })),
      setTools: (nodes) => {
        if (current === shown) setTools(nodes);
      },
      setMeta: ({ size, detail } = {}) => {
        if (current !== shown) return;
        if (Number.isFinite(size)) shown.file = { ...shown.file, size };
        if (detail !== undefined) shown.detail = detail || null;
        renderHeader();
      },
      setDirty: (dirty) => {
        if (current === shown && view.kind === 'editor') shown.dirty = Boolean(dirty);
      },
    };

    let instance;
    try {
      instance = await view.mount(hostEl, context);
    } catch (err) {
      // The cause is for the console; the card says, in the user's language,
      // only that the file cannot be shown (#641).
      console.error(`File view "${view.id}" failed to mount:`, err);
      if (current === shown) showInfo(item, READ_FAILURES.VIEW_FAILED, view);
      return;
    }
    if (current !== shown) {
      instance?.unmount?.();
      return;
    }
    shown.instance = instance;
  }

  /**
   * Resolves to 'clean' (nothing unsaved), 'saved', 'discard' or 'keep'.
   * Asks only when an editor reports unsaved changes; two callers at the same
   * time share one question.
   */
  async function askToLeave(reason) {
    const shown = current;
    if (!shown?.instance || !shown.dirty) return 'clean';
    if (pendingAsk) return pendingAsk;
    pendingAsk = (async () => {
      let choice;
      try {
        choice = await confirmLeave({ file: { ...shown.file }, reason });
      } catch (err) {
        console.warn('Asking about unsaved changes failed:', err?.message ?? err);
        choice = 'cancel';
      }
      if (current !== shown || !shown.dirty) return 'clean';
      if (choice === 'discard') {
        shown.dirty = false;
        return 'discard';
      }
      if (choice === 'save') {
        let saved = false;
        try {
          saved = (await shown.instance.save?.()) === true;
        } catch (err) {
          console.warn(`File view "${shown.view.id}" failed to save:`, err?.message ?? err);
        }
        if (!saved) return 'keep';
        shown.dirty = false;
        return 'saved';
      }
      return 'keep';
    })();
    try {
      return await pendingAsk;
    } finally {
      pendingAsk = null;
    }
  }

  /**
   * Show a file from the tree (`{ path, name, size, modified }`). Resolves to
   * true when the pane now shows it, false when an editor kept the pane or a
   * newer open() overtook this one.
   */
  async function open(item) {
    // Only the open a view's link asked for gets the fragment it named.
    const fragment = pendingFragment?.path === item.path ? pendingFragment.fragment : '';
    pendingFragment = null;
    if (current?.file.path === item.path && current.view) {
      // The same file again: read it, but keep the view and whatever state it
      // has — scroll position, and in an editor the buffer. It still counts as
      // the latest click, so a read for another file must not overtake it.
      generation += 1;
      await refresh(item.path);
      return true;
    }
    const ticket = ++generation;
    if ((await askToLeave('switch-file')) === 'keep') return false;
    if (ticket !== generation) return false;

    const view = registry.resolve(item);
    if (!view) {
      showInfo(item);
      return true;
    }
    if (!readsText(view)) {
      // The view reads the file itself (#345); size and date come from the tree.
      await mountView(view, item, { content: null, size: item.size, modified: item.modified }, fragment);
      return ticket === generation;
    }
    const result = await api.readFile(item.path);
    if (ticket !== generation) return false;
    if (!result || result.error) {
      showReadFailure(item, result, view);
      return true;
    }
    await mountView(view, item, result, fragment);
    return ticket === generation;
  }

  /** A view's link to another file, perhaps with a `#section` in it (#641). */
  async function openFromView(path, { fragment = '' } = {}) {
    pendingFragment = fragment ? { path, fragment } : null;
    const result = await openFile(path);
    // Nothing was opened: the fragment must not wait for a later click.
    if (!result?.ok && pendingFragment?.path === path) pendingFragment = null;
    return result;
  }

  /**
   * The file changed on disk. Does nothing unless it is the one on show and a
   * view is responsible for it; a binary file on the info card has nothing to
   * reload.
   */
  async function refresh(path) {
    const shown = current;
    if (!shown || shown.file.path !== path || !shown.view) return;
    if (!readsText(shown.view)) {
      // Nothing to compare here: the view reads again and decides. One that is
      // still mounting is about to read the file anyway.
      await shown.instance?.update({});
      return;
    }
    const result = await api.readFile(path);
    if (current !== shown) return;
    if (!result || result.error) {
      // An editor's buffer outlives a file it can no longer read.
      if (shown.dirty) return;
      showReadFailure(shown.item, result, shown.view);
      return;
    }
    if (!shown.instance) {
      // Either the last read failed — try the view again — or it is still
      // mounting, and then it is about to show this very file.
      if (shown.error) await mountView(shown.view, shown.item, result);
      return;
    }
    shown.file = { ...shown.file, size: result.size, modified: result.modified ?? shown.file.modified };
    renderHeader();
    if (result.content === shown.content) {
      // The same text can point at images that changed (#640); a view that
      // shows such things checks them itself.
      await shown.instance.revalidate?.();
      return;
    }
    shown.content = result.content;
    await shown.instance.update({ content: result.content, size: result.size, modified: result.modified });
  }

  /**
   * Files changed in `directories`, none of them the one on show — the
   * watcher reported those folders. A view that shows other files, the
   * images of a Markdown document, checks the ones it has there (#640).
   * Never throws: it runs inside the tree's queue.
   */
  async function revalidate(directories) {
    const shown = current;
    if (typeof shown?.instance?.revalidate !== 'function') return;
    try {
      await shown.instance.revalidate({ directories: Array.isArray(directories) ? directories : [] });
    } catch (err) {
      console.warn(`File view "${shown.view.id}" failed to revalidate:`, err?.message ?? err);
    }
  }

  /**
   * Resolve unsaved changes before the caller does something that ends the
   * view — a folder switch, say. True when nothing unsaved is left; a
   * discarded buffer is closed right away, so that it cannot linger.
   */
  async function settleUnsaved(reason) {
    const answer = await askToLeave(reason);
    if (answer === 'keep') return false;
    if (answer === 'discard') showWelcome();
    return true;
  }

  /** Back to the welcome screen. False when an editor kept the pane. */
  async function close(reason) {
    if ((await askToLeave(reason)) === 'keep') return false;
    showWelcome();
    return true;
  }

  /**
   * Hands a command to the view on show — the menu shortcut that switches a
   * Markdown file between preview and source (#344). False when there is no
   * view, or the view does not know the command.
   */
  function runCommand(name) {
    const instance = current?.instance;
    if (!instance || typeof instance.command !== 'function') return false;
    try {
      return instance.command(name) === true;
    } catch (err) {
      console.warn(`File view "${current.view.id}" failed on command "${name}":`, err?.message ?? err);
      return false;
    }
  }

  // The info card's reason is a catalogue key since #641, so a language
  // switch only has to draw the card again; it no longer reads the file.
  const stopFollowingLocale = onLocaleChange(() => {
    if (!current) return;
    if (current.instance) renderHeader();
    else renderInfo();
  });

  return {
    open,
    refresh,
    revalidate,
    close,
    settleUnsaved,
    /** Back to the welcome screen without asking — for a caller that already settled. */
    clear: showWelcome,
    runCommand,
    openPath: () => current?.file.path ?? null,
    hasUnsavedChanges: () => Boolean(current?.dirty),
    /** Unmount the view and stop listening — for a pane that goes away. */
    dispose() {
      stopFollowingLocale();
      generation += 1;
      teardown();
    },
  };
}
