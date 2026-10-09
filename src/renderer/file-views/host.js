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
// **History (#822).** Every file the pane shows is a step in
// `preview-history.js`, whichever way it came; ‹ › in the header, the menu
// shortcuts and the mouse's side buttons walk it. Going back goes through
// `openFile` like a link, so the tree selects the file as well, and the view
// mounted for it gets back what it reported as it was left (`viewState`).
//
// The interface of a view is documented in the header of `registry.js`.

import { t, onLocaleChange } from '../i18n.js';
import { formatSize, formatTimestamp, getExtension } from '../utils/helpers.js';
import { READ_FAILURES, readFailureMessageKey, readFailureOf } from './read-failures.js';
import { fileViews, readsText } from './registry.js';
import { changesView } from './changes-view.js';
import { buildSegmentedSwitch } from './mode-switch.js';
import { createPreviewHistory } from './preview-history.js';

const keepEditing = async () => 'cancel';

const noOpener = async () => ({ ok: false, reason: 'not-found' });

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent ?? '');

const isInside = (child, dir) => typeof child === 'string' && typeof dir === 'string' && dir !== ''
  && child.length > dir.length && child.startsWith(dir) && (child[dir.length] === '/' || child[dir.length] === '\\');

const ARROWS = {
  back: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  forward: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export function createFileViewHost({
  api,
  registry = fileViews,
  confirmLeave = keepEditing,
  openFile = noOpener,
  getWorkspaceRoot = () => null,
  // The ids of what the agent changed in a file, in the conversation on
  // screen, oldest first (#348). A file with any gets "Content | Changes".
  changesFor = () => [],
  // The menu of the entries behind ‹ or › (#822): main shows it and answers
  // through `chooseFromHistory`. Without one, a right click does nothing.
  showHistoryMenu = null,
}) {
  const welcomeEl = document.getElementById('welcome');
  const filePreview = document.getElementById('file-preview');
  const previewLead = document.getElementById('preview-lead');
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
  // A step the history asked for (#822): `{ path, index, state }`. Like the
  // fragment, only the next open() of that path takes it.
  let pendingStep = null;
  const history = createPreviewHistory();
  // Every menu shown draws a number; an answer for an older one is dropped.
  let historyMenuToken = 0;
  const historyNav = buildHistoryNav();

  function teardown() {
    const shown = current;
    current = null;
    if (shown?.instance && shown.view !== changesView) rememberViewState(shown);
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
    if (current) current.toolNodes = nodes ?? [];
    const own = current?.changesSwitch ? [current.changesSwitch.element] : [];
    previewTools.replaceChildren(...(nodes ?? []), ...own);
    previewTools.hidden = previewTools.childElementCount === 0;
  }

  /**
   * "Content | Changes" in the header (#348), for a file the agent changed in
   * the conversation on screen. The view keeps its own tools; this one stands
   * after them, in the same place for every type.
   */
  function syncChangesSwitch(shown, { focus = false } = {}) {
    if (current !== shown || !shown.view) return;
    const ids = shown.view === changesView ? shown.changes?.ids || [] : idsFor(shown.file.path);
    if (ids.length === 0) {
      if (shown.changesSwitch) {
        shown.changesSwitch = null;
        setTools(shown.toolNodes);
      }
      return;
    }
    const mode = shown.view === changesView ? 'changes' : 'content';
    if (!shown.changesSwitch) {
      shown.changesSwitch = buildSegmentedSwitch({
        labelKey: 'changes.mode.label',
        options: [
          { value: 'content', labelKey: 'changes.mode.content' },
          { value: 'changes', labelKey: 'changes.mode.changes' },
        ],
        selected: mode,
        onChange: (next) => {
          if (current !== shown) return;
          const options = next === 'changes'
            ? { changes: { ids: idsFor(shown.file.path) }, focusSwitch: true }
            : { content: true, focusSwitch: true };
          void open(shown.item, options);
        },
      });
      setTools(shown.toolNodes);
    } else {
      shown.changesSwitch.select(mode);
    }
    if (focus) shown.changesSwitch.element.querySelector(':checked')?.focus();
  }

  /** What the view reports about where the reader is, kept with its entry. */
  function rememberViewState(shown) {
    if (typeof shown.instance.viewState !== 'function') return;
    try {
      history.saveState(shown.file.path, shown.instance.viewState() ?? null);
    } catch (err) {
      console.warn(`File view "${shown.view.id}" failed to report its state:`, err?.message ?? err);
    }
  }

  function buildHistoryNav() {
    const group = document.createElement('div');
    group.className = 'preview-history';
    group.setAttribute('role', 'group');
    const make = (direction) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preview-history__button';
      button.dataset.direction = direction;
      button.innerHTML = ARROWS[direction];
      button.setAttribute('aria-keyshortcuts', isMac()
        ? (direction === 'back' ? 'Meta+BracketLeft' : 'Meta+BracketRight')
        : (direction === 'back' ? 'Alt+ArrowLeft' : 'Alt+ArrowRight'));
      button.addEventListener('click', () => {
        void (direction === 'back' ? goBack() : goForward());
      });
      // Right click, or Shift+F10 and the menu key on the focused button:
      // the entries on that side, as in a browser.
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (!button.disabled) openHistoryMenu(direction, button);
      });
      return button;
    };
    const back = make('back');
    const forward = make('forward');
    group.append(back, forward);
    return { group, back, forward };
  }

  function shortcutOf(direction) {
    if (isMac()) return direction === 'back' ? '\u2318[' : '\u2318]';
    return t(direction === 'back' ? 'preview.history.back.shortcut' : 'preview.history.forward.shortcut');
  }

  /** ‹ and ›: on or off, and named after the file they lead to. */
  function renderHistoryNav() {
    const focused = ['back', 'forward'].find((direction) => document.activeElement === historyNav[direction]);
    for (const direction of ['back', 'forward']) {
      const button = historyNav[direction];
      const step = history.step(direction === 'back' ? -1 : 1);
      const name = step ? baseName(step.entry.path) : '';
      button.disabled = !step;
      const label = name
        ? t(`preview.history.${direction}.to`, { name })
        : t(`preview.history.${direction}`);
      button.setAttribute('aria-label', label);
      button.title = `${label} (${shortcutOf(direction)})`;
    }
    historyNav.group.setAttribute('aria-label', t('preview.history.label'));
    // A button that has just been disabled hands the focus to its partner,
    // or the keyboard would be left on nothing.
    if (focused && historyNav[focused].disabled) {
      const other = historyNav[focused === 'back' ? 'forward' : 'back'];
      if (!other.disabled) other.focus();
      else historyNav[focused].blur();
    }
  }

  function baseName(path) {
    const parts = String(path).split(/[\\/]/);
    return parts[parts.length - 1] || String(path);
  }

  /** The nav belongs to whichever of the two panes shows a file. */
  function placeHistoryNav(which) {
    // Moved only when it has to: moving a node takes the focus off it.
    const home = which === 'preview' ? previewLead : which === 'info' ? fileInfo : null;
    if (!home) historyNav.group.remove();
    else if (home.firstElementChild !== historyNav.group) home.prepend(historyNav.group);
    historyNav.group.classList.toggle('preview-history--card', which === 'info');
    renderHistoryNav();
  }

  /**
   * One step back (-1) or forward (+1). A file that is gone is skipped, and
   * marked so in the menu; a folder switched meanwhile ends the walk.
   */
  async function walk(direction) {
    for (;;) {
      const step = history.step(direction);
      if (!step) return false;
      const outcome = await goToEntry(step.index, step.entry);
      if (outcome !== 'gone') return outcome === 'shown';
    }
  }

  async function goToEntry(index, entry) {
    pendingStep = { path: entry.path, index, state: entry.state };
    // A position the view reported wins over the heading the link named.
    pendingFragment = !entry.state && entry.fragment ? { path: entry.path, fragment: entry.fragment } : null;
    let result;
    try {
      result = await openFile(entry.path);
    } catch (err) {
      console.warn('History step failed:', err?.message ?? err);
      result = { ok: false };
    }
    if (result?.ok) return 'shown';
    if (pendingStep?.path === entry.path) pendingStep = null;
    if (pendingFragment?.path === entry.path) pendingFragment = null;
    if (result?.reason === 'not-found') {
      history.markGone(entry.path);
      renderHistoryNav();
      return 'gone';
    }
    return 'failed';
  }

  const goBack = () => walk(-1);
  const goForward = () => walk(1);

  function openHistoryMenu(direction, button) {
    if (typeof showHistoryMenu !== 'function') return;
    const entries = history.list(direction === 'back' ? -1 : 1).map((entry) => ({
      index: entry.index,
      name: baseName(entry.path),
      folder: folderLabel(entry.path),
      gone: entry.gone,
    }));
    if (entries.length === 0) return;
    const box = button.getBoundingClientRect();
    const token = ++historyMenuToken;
    Promise.resolve(showHistoryMenu({
      token,
      entries,
      position: { x: Math.round(box.left), y: Math.round(box.bottom) },
    })).catch((err) => console.warn('History menu failed:', err?.message ?? err));
  }

  /** The folder of a path, relative to the open one; '' at its top. */
  function folderLabel(path) {
    const root = getWorkspaceRoot();
    const dir = String(path).replace(/[\\/][^\\/]*$/, '');
    if (!root || dir === root || !isInside(dir, root)) return '';
    return dir.slice(root.length + 1).replaceAll('\\', '/');
  }

  /** Main's answer to the menu: the entry picked, for the menu `token`. */
  async function chooseFromHistory(token, index) {
    if (token !== historyMenuToken || !Number.isInteger(index)) return false;
    historyMenuToken += 1;
    const entry = history.entryAt(index);
    if (!entry || entry.gone) return false;
    return (await goToEntry(index, entry)) === 'shown';
  }

  function idsFor(path) {
    try {
      const ids = changesFor(path);
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  }

  function showPane(which) {
    welcomeEl.classList.toggle('hidden', which !== 'welcome');
    filePreview.classList.toggle('hidden', which !== 'preview');
    fileInfo.classList.toggle('hidden', which !== 'info');
    placeHistoryNav(which);
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
    if (current.metaText) {
      previewMeta.textContent = current.metaText;
      return;
    }
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

  async function mountView(view, item, result, fragment = '', { changes = null, focusSwitch = false, viewState = null } = {}) {
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
      changes, changesSwitch: null, toolNodes: [], metaText: null,
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
      viewState,
      api,
      workspaceRoot: getWorkspaceRoot() ?? null,
      openFile: (path, options) => (current === shown
        ? openFromView(path, options)
        : Promise.resolve({ ok: false, reason: 'stale' })),
      setTools: (nodes) => {
        if (current === shown) setTools(nodes);
      },
      setMeta: ({ size, detail, text } = {}) => {
        if (current !== shown) return;
        if (Number.isFinite(size)) shown.file = { ...shown.file, size };
        if (detail !== undefined) shown.detail = detail || null;
        // The whole pill, for a view that is not about the file's size (#348).
        if (text !== undefined) shown.metaText = text || null;
        renderHeader();
      },
      changes,
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
    syncChangesSwitch(shown, { focus: focusSwitch });
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
  async function open(item, options = {}) {
    // Only the open a view's link asked for gets the fragment it named, and
    // only the open the history asked for is a step back or forward.
    const fragment = pendingFragment?.path === item.path ? pendingFragment.fragment : '';
    pendingFragment = null;
    const step = pendingStep?.path === item.path ? pendingStep : null;
    pendingStep = null;
    const shown = await show(item, options, fragment, step);
    if (shown && current?.file.path === item.path) {
      history.visit(item.path, { workspaceRoot: getWorkspaceRoot() ?? null, target: step?.index ?? null });
      if (fragment) history.saveFragment(item.path, fragment);
      renderHistoryNav();
    }
    return shown;
  }

  async function show(item, { changes = null, content = false, focusSwitch = false } = {}, fragment = '', step = null) {
    const viewState = step?.state ?? null;
    // The same file again is a refresh — unless the other side of
    // "Content | Changes" is asked for (#348).
    const switching = Boolean(changes) || (content && current?.view === changesView);
    if (current?.file.path === item.path && current.view && !switching) {
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

    if (changes) {
      await mountView(changesView, item, { content: null, size: item.size, modified: item.modified }, '', { changes, focusSwitch });
      return ticket === generation;
    }
    const view = registry.resolve(item);
    if (!view) {
      showInfo(item);
      return true;
    }
    if (!readsText(view)) {
      // The view reads the file itself (#345); size and date come from the tree.
      await mountView(view, item, { content: null, size: item.size, modified: item.modified }, fragment, { focusSwitch, viewState });
      return ticket === generation;
    }
    const result = await api.readFile(item.path);
    if (ticket !== generation) return false;
    if (!result || result.error) {
      showReadFailure(item, result, view);
      return true;
    }
    await mountView(view, item, result, fragment, { focusSwitch, viewState });
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
    renderHistoryNav();
    if (!current) return;
    current.changesSwitch?.applyLabels();
    if (current.view === changesView) current.instance?.applyLabels?.();
    if (current.instance) renderHeader();
    else renderInfo();
  });

  return {
    open,
    /** Opens a file through the tree, with a `#fragment` for its view (#479). */
    openFromLink: openFromView,
    refresh,
    revalidate,
    close,
    settleUnsaved,
    /** Back to the welcome screen without asking — for a caller that already settled. */
    clear: showWelcome,
    runCommand,
    /** The agent changed a file (#348): the switch may be due on the one on show. */
    syncChanges: () => {
      if (current) syncChangesSwitch(current);
    },
    /** Is the diff on show, rather than the file? */
    showsChanges: () => current?.view === changesView,
    openPath: () => current?.file.path ?? null,
    /** Back and forward through what the pane showed (#822). */
    goBack,
    goForward,
    canGoBack: () => history.canGo(-1),
    canGoForward: () => history.canGo(1),
    chooseFromHistory,
    /** The tree renamed or moved `oldPath`: the history follows. */
    renamePath(oldPath, newPath) {
      history.rename(oldPath, newPath, isInside);
      renderHistoryNav();
    },
    /** `path` — a file, or a folder and all in it — was deleted. */
    forgetPath(path) {
      history.markGoneUnder(path, isInside);
      renderHistoryNav();
    },
    /** Another folder: its history starts empty. */
    resetHistory() {
      history.reset();
      renderHistoryNav();
    },
    hasUnsavedChanges: () => Boolean(current?.dirty),
    /** Unmount the view and stop listening — for a pane that goes away. */
    dispose() {
      stopFollowingLocale();
      generation += 1;
      teardown();
    },
  };
}
