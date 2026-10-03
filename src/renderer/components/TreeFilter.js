import { t, tPlural, onLocaleChange } from '../i18n.js';
import { formatCount, svgFile, svgFolder } from '../utils/helpers.js';
import { mentionMatchRanges, rankMentionCandidates } from '../chat/mentionAutocomplete.js';

// How many matches are drawn. The count says how many there are; whoever
// needs one further down types a letter more rather than scrolling past
// hundreds.
const MAX_SHOWN = 200;
// A watcher report while the filter is open fetches the list anew; a burst of
// them — a checkout, a build — fetches it once.
const REFRESH_DELAY_MS = 250;
// As in the tree (#639): a quicker list would only make the state flicker.
const LOADING_STATE_DELAY_MS = 150;

/**
 * The tree's filter (#350). A field above the tree, opened from the `⋯`
 * menu in its header (#676), with Cmd/Ctrl+P from anywhere, or by typing into
 * the focused tree. As soon as it holds a query, a flat list of the matches
 * takes the tree's place: the same path list and the same ranking as the `@`
 * menu, so both find the same files in the same order.
 *
 * The tree underneath stays as it is — open folders, selection, scroll — and
 * the watcher keeps drawing it; closing the filter brings it back. What was
 * opened from the list is revealed in it on the way, like a link from the
 * preview.
 *
 * The field is a combobox: the focus stays in it, the arrows move through
 * the list (aria-activedescendant), Enter opens, Escape closes.
 *
 * @param {object} deps
 * @param {object} deps.appStore
 * @param {{ load: Function, invalidate: Function }} deps.paths shared with the `@` menu
 * @param {(entry: {path: string, kind: string}) => Promise<unknown>} deps.openEntry
 * @param {(relPath: string) => boolean} deps.isHidden whether the tree dims the entry (#436)
 * @param {() => HTMLElement | null} deps.treeFocusTarget the row Tab would enter the tree on
 */
export function initTreeFilter({ appStore, paths, openEntry, isHidden = () => false, treeFocusTarget, fallbackFocus }) {
  const bar = document.getElementById('tree-filter');
  const input = document.getElementById('tree-filter-input');
  const btnClose = document.getElementById('btn-tree-filter-close');
  const results = document.getElementById('tree-filter-results');
  const status = document.getElementById('tree-filter-status');
  const treeContainer = document.getElementById('tree-container');
  const inactive = { open() {}, close() {}, refresh() {}, isOpen: () => false, setAvailable() {}, shortcut: () => '' };
  if (!bar || !input || !results || !status || !treeContainer) return inactive;

  let shown = []; // the entries drawn, in order
  let total = 0;
  let truncated = false;
  let searched = 0; // entries in the list, the cap when it is truncated
  let selectedIndex = 0;
  let updateSeq = 0;
  let refreshTimer = null;
  let loadingTimer = null;
  // Where the focus was before the filter took it; it goes back there.
  let returnFocus = null;

  const isOpen = () => !bar.hidden;
  const query = () => input.value.trim();

  function shortcut() {
    return navigator.userAgent.includes('Mac') ? '⌘P' : t('tree.filter.shortcut');
  }

  function renderLabels() {
    if (btnClose) btnClose.title = `${t('tree.filter.close')} (Esc)`;
  }

  /** Only while a folder is open; the menu entry follows it (#676). */
  function setAvailable(available) {
    if (!available) close({ restoreFocus: false });
  }

  function open(initial = null) {
    if (!appStore.rootPath) return false;
    if (!isOpen()) {
      const active = document.activeElement;
      returnFocus = active && active !== document.body && !bar.contains(active) ? active : null;
      bar.hidden = false;
    }
    if (typeof initial === 'string') {
      input.value = initial;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    } else {
      // A second Cmd/Ctrl+P takes the field again, ready to be typed over.
      input.focus();
      input.select();
    }
    void update();
    return true;
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    updateSeq += 1;
    clearTimeout(refreshTimer);
    refreshTimer = null;
    stopLoading();
    const hadFocus = bar.contains(document.activeElement);
    input.value = '';
    showResults(false);
    bar.hidden = true;
    const target = returnFocus;
    returnFocus = null;
    if (!restoreFocus || !hadFocus) return;
    // Back into the tree when it came from there — onto the row Tab would
    // take, which is what was just opened, if anything was. Elsewhere back to
    // where it was, as long as that is still on screen.
    const treeRow = !target || treeContainer.contains(target) ? treeFocusTarget?.() : null;
    if (treeRow) {
      treeRow.focus();
      treeRow.scrollIntoView?.({ block: 'nearest' });
    } else if (target?.isConnected && target.getClientRects().length > 0) {
      target.focus();
    } else {
      fallbackFocus?.()?.focus();
    }
  }

  /** The list in the tree's place, or the tree back. */
  function showResults(visible) {
    results.hidden = !visible;
    // While the list stands, renderStatus decides: no count, no line.
    if (!visible) status.hidden = true;
    treeContainer.hidden = visible;
    input.setAttribute('aria-expanded', visible && shown.length > 0 ? 'true' : 'false');
    if (!visible) {
      results.innerHTML = '';
      status.textContent = '';
      shown = [];
      input.removeAttribute('aria-activedescendant');
    }
  }

  function stopLoading() {
    clearTimeout(loadingTimer);
    loadingTimer = null;
    results.removeAttribute('aria-busy');
  }

  async function update({ keepSelection = false } = {}) {
    const seq = ++updateSeq;
    const q = query();
    if (!isOpen() || !q) {
      stopLoading();
      showResults(false);
      return;
    }
    const keepPath = keepSelection ? shown[selectedIndex]?.path : null;
    results.setAttribute('aria-busy', 'true');
    if (!loadingTimer) {
      loadingTimer = setTimeout(() => {
        if (seq !== updateSeq) return;
        renderMessage(t('tree.filter.loading'), 'tree-filter-message--loading');
        status.hidden = true;
        showResults(true);
      }, LOADING_STATE_DELAY_MS);
    }
    const list = await paths.load();
    if (seq !== updateSeq) return; // typed on meanwhile — the newer call takes over
    stopLoading();

    const ranked = rankMentionCandidates(list.entries, q);
    total = ranked.length;
    truncated = list.truncated === true;
    searched = list.entries.length;
    shown = ranked.slice(0, MAX_SHOWN);
    const kept = keepPath ? shown.findIndex((entry) => entry.path === keepPath) : -1;
    selectedIndex = kept >= 0 ? kept : 0;
    showResults(true);
    render(q);
  }

  function renderMessage(text, className) {
    results.innerHTML = '';
    const message = document.createElement('div');
    message.className = `tree-filter-message ${className}`;
    message.textContent = text;
    results.appendChild(message);
    input.removeAttribute('aria-activedescendant');
  }

  function render(q) {
    if (shown.length === 0) {
      renderMessage(t('tree.filter.empty', { query: q }), 'tree-filter-message--empty');
    } else {
      results.innerHTML = '';
      shown.forEach((entry, index) => results.appendChild(buildOption(entry, index, q)));
      markSelected({ scroll: true });
    }
    renderStatus();
  }

  function renderStatus() {
    const lines = [];
    if (total > 0) {
      lines.push(total > shown.length
        ? t('tree.filter.countCapped', { shown: formatCount(shown.length), count: formatCount(total) })
        : tPlural('tree.filter.count', total, { count: formatCount(total) }));
    }
    if (truncated) lines.push(t('tree.filter.truncated', { count: formatCount(searched) }));
    status.textContent = lines.join(' ');
    status.hidden = results.hidden || lines.length === 0;
  }

  /** Text with the matched characters in <mark>, from `offset` of the path on. */
  function highlighted(text, ranges, offset) {
    const fragment = document.createDocumentFragment();
    let pos = 0;
    for (const [from, to] of ranges) {
      const start = Math.max(from - offset, 0);
      const end = Math.min(to - offset, text.length);
      if (end <= start) continue;
      if (start > pos) fragment.append(text.slice(pos, start));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(start, end);
      fragment.append(mark);
      pos = end;
    }
    if (pos < text.length) fragment.append(text.slice(pos));
    return fragment;
  }

  function buildOption(entry, index, q) {
    const isDirectory = entry.kind === 'directory';
    const slash = entry.path.lastIndexOf('/');
    const name = entry.path.slice(slash + 1);
    const dir = slash >= 0 ? entry.path.slice(0, slash) : '';
    const ranges = mentionMatchRanges(entry.path, q);

    const option = document.createElement('div');
    option.className = 'tree-filter-option';
    if (isHidden(entry.path)) option.classList.add('tree-filter-option--hidden');
    option.id = `tree-filter-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.dataset.index = String(index);
    option.dataset.path = entry.path;
    option.dataset.kind = isDirectory ? 'directory' : 'file';
    // The name alone would not tell two files of the same name apart.
    option.setAttribute('aria-label', dir ? `${name}, ${dir}` : name);
    option.title = entry.path;

    const icon = document.createElement('span');
    icon.className = 'tree-filter-icon';
    icon.innerHTML = isDirectory ? svgFolder() : svgFile(name);
    option.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'tree-filter-text';
    const nameEl = document.createElement('span');
    nameEl.className = 'tree-filter-name';
    nameEl.append(highlighted(name, ranges, slash + 1));
    text.appendChild(nameEl);
    if (dir) {
      const dirEl = document.createElement('span');
      dirEl.className = 'tree-filter-dir';
      dirEl.append(highlighted(dir, ranges, 0));
      text.appendChild(dirEl);
    }
    option.appendChild(text);
    return option;
  }

  function markSelected({ scroll = false } = {}) {
    const options = results.querySelectorAll('.tree-filter-option');
    options.forEach((el, i) => el.setAttribute('aria-selected', i === selectedIndex ? 'true' : 'false'));
    const current = options[selectedIndex];
    if (!current) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', current.id);
    if (scroll) current.scrollIntoView?.({ block: 'nearest' });
  }

  function move(delta) {
    if (shown.length === 0) return;
    selectedIndex = Math.min(Math.max(selectedIndex + delta, 0), shown.length - 1);
    markSelected({ scroll: true });
  }

  /**
   * A file opens in the preview and the list stays, for the next one. A
   * folder has nothing to preview: the filter closes and the tree shows it,
   * unfolded and selected, with the focus on it.
   */
  async function activate(index = selectedIndex) {
    const entry = shown[index];
    if (!entry) return;
    selectedIndex = index;
    markSelected();
    if (entry.kind === 'directory') {
      returnFocus = treeContainer;
      await openEntry(entry);
      close();
      return;
    }
    await openEntry(entry);
  }

  /**
   * The workspace changed underneath — a watcher report, the agent's write, a
   * move in the tree, hidden files switched. The list is fetched anew, and an
   * open filter shows what is there now, keeping the selected entry if it
   * still is.
   */
  function refresh() {
    paths.invalidate();
    if (!isOpen() || !query()) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void update({ keepSelection: true });
    }, REFRESH_DELAY_MS);
  }

  input.addEventListener('input', () => {
    void update();
  });

  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowUp':
        move(-1);
        break;
      case 'PageDown':
        move(10);
        break;
      case 'PageUp':
        move(-10);
        break;
      case 'Enter':
        if (plain) void activate();
        else handled = false;
        break;
      case 'Escape':
        close();
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  });

  // Escape from the close button closes as well; from anywhere else in the
  // bar it would otherwise reach the document and nothing would happen.
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.target === input) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });

  // The focus stays in the field; a click on an option must not take it.
  results.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tree-filter-option')) e.preventDefault();
  });
  results.addEventListener('click', (e) => {
    const option = e.target.closest('.tree-filter-option');
    if (!option) return;
    void activate(Number(option.dataset.index));
  });
  results.addEventListener('mousemove', (e) => {
    const option = e.target.closest('.tree-filter-option');
    if (!option) return;
    const index = Number(option.dataset.index);
    if (!Number.isInteger(index) || index === selectedIndex) return;
    selectedIndex = index;
    markSelected();
  });

  btnClose?.addEventListener('click', () => close());

  onLocaleChange(() => {
    renderLabels();
    if (!isOpen() || results.hidden) return;
    const q = query();
    if (shown.length === 0) renderMessage(t('tree.filter.empty', { query: q }), 'tree-filter-message--empty');
    renderStatus();
  });
  renderLabels();

  return {
    /** Opens the filter, optionally with what was typed into the tree. */
    open,
    close,
    refresh,
    isOpen,
    setAvailable,
    /** The key that opens it, as the menu shows it. */
    shortcut,
  };
}
