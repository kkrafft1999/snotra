/**
 * The search field of the help window (#847).
 *
 * It sits at the top of the chapters. While a query is typed the results take
 * the chapters' place; Escape brings them back. The field is a combobox over
 * the result list: ↑ and ↓ choose, Enter opens the page at the section the
 * words were found in. The index is built the first time it is needed, from
 * every page of the current language, and again after a language change.
 *
 * The results are drawn a moment after the last keystroke. ↑, ↓ and Enter
 * always act on the results for what is in the field: a key pressed before
 * they are drawn runs the search first (#854), and until then the list is
 * `aria-busy`.
 */

import { t, tPlural } from '../i18n.js';
import { headingSlug } from '../file-views/markdown-document.js';
import { buildSearchIndex, queryTerms, searchManual } from './manual-search.js';

const INPUT_DELAY_MS = 60;

export function createManualSearch({ els, api, getLocale, chapterLabel, onOpen }) {
  const { searchInput: input, searchKey: key, resultsPanel: panel, resultsCount: count, results: list, nav } = els;
  let index = null;
  let indexLocale = null;
  let building = null;
  let results = [];
  let active = -1;
  let currentSlug = null;
  let timer = 0;
  /** Typed since the results were last drawn. */
  let pending = false;
  let generation = 0;
  /** The query the results on screen belong to. */
  let drawnFor = '';
  /** The search started last, while it runs. */
  let searching = null;

  key.textContent = /Mac/.test(navigator.userAgent ?? '') ? '⌘F' : 'Ctrl+F';

  async function ensureIndex() {
    const locale = getLocale();
    if (index && indexLocale === locale) return index;
    if (!building || building.locale !== locale) {
      const promise = api.pages(locale).then((pages) => {
        const built = buildSearchIndex(pages, { lexer: (text) => window.marked.lexer(text), slugify: headingSlug });
        if (building?.promise === promise) {
          index = built;
          indexLocale = locale;
          building = null;
        }
        return built;
      });
      building = { locale, promise };
    }
    return building.promise;
  }

  function showChapters() {
    results = [];
    active = -1;
    panel.hidden = true;
    nav.hidden = false;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  async function run() {
    pending = false;
    const query = input.value;
    key.hidden = query !== '';
    const run = ++generation;
    if (queryTerms(query).length === 0) {
      showChapters();
      drawn(query);
      return;
    }
    const built = await ensureIndex();
    if (run !== generation) return;
    results = searchManual(built, query);
    active = results.length ? 0 : -1;
    render();
    drawn(query);
  }

  function drawn(query) {
    drawnFor = query;
    list.removeAttribute('aria-busy');
  }

  /** Resolves once the results on screen are those for the field's value. */
  function settled() {
    if (drawnFor === input.value) return Promise.resolve();
    if (pending) {
      clearTimeout(timer);
      searching = run();
    }
    return searching ?? Promise.resolve();
  }

  function render() {
    nav.hidden = true;
    panel.hidden = false;
    input.setAttribute('aria-expanded', String(results.length > 0));
    count.textContent = results.length
      ? tPlural('manual.search.results', results.length, { count: results.length })
      : t('manual.search.empty');
    list.replaceChildren(...results.map((result, i) => option(result, i)));
    renderActive();
  }

  function option(result, i) {
    const li = document.createElement('li');
    li.id = `manual-result-${i}`;
    li.className = 'manual-result';
    li.setAttribute('role', 'option');
    li.dataset.index = String(i);
    if (result.slug === currentSlug) li.classList.add('manual-result--current');

    const title = document.createElement('span');
    title.className = 'manual-result__title';
    title.textContent = result.title;

    const where = document.createElement('span');
    where.className = 'manual-result__where';
    where.textContent = [result.chapter ? chapterLabel(result.chapter) : '', result.heading ?? '']
      .filter(Boolean).join(' › ');

    const excerpt = document.createElement('span');
    excerpt.className = 'manual-result__excerpt';
    for (const part of result.excerpt) {
      if (part.match) {
        const mark = document.createElement('mark');
        mark.textContent = part.text;
        excerpt.append(mark);
      } else {
        excerpt.append(part.text);
      }
    }

    li.append(title);
    if (where.textContent) li.append(where);
    if (excerpt.textContent) li.append(excerpt);
    return li;
  }

  function renderActive() {
    for (const li of list.children) {
      const selected = Number(li.dataset.index) === active;
      li.setAttribute('aria-selected', String(selected));
      if (selected) li.scrollIntoView({ block: 'nearest' });
    }
    if (active >= 0) input.setAttribute('aria-activedescendant', `manual-result-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function open(i) {
    const result = results[i];
    if (!result) return;
    active = i;
    renderActive();
    onOpen(result);
  }

  function clear() {
    clearTimeout(timer);
    pending = false;
    generation += 1;
    input.value = '';
    key.hidden = false;
    showChapters();
    drawn('');
  }

  input.addEventListener('input', () => {
    pending = true;
    list.setAttribute('aria-busy', 'true');
    clearTimeout(timer);
    timer = setTimeout(() => { searching = run(); }, INPUT_DELAY_MS);
  });
  // The first focus builds the index, so that the first letters find it ready.
  input.addEventListener('focus', () => { void ensureIndex().catch(() => {}); });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const current = drawnFor === input.value;
      if (current && !results.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // Typed a moment ago: choose among the results for the whole query, not
      // among those still on screen for the first letters (#854).
      void settled().then(() => {
        if (!results.length) return;
        active = Math.min(results.length - 1, Math.max(0, active + step));
        renderActive();
      });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (drawnFor === input.value) {
        open(active);
        return;
      }
      // Enter right after typing: search first, then open the best hit.
      void settled().then(() => open(Math.max(active, 0)));
    } else if (event.key === 'Escape' && input.value) {
      // The first Escape empties the field; the next one closes the contents.
      event.preventDefault();
      event.stopPropagation();
      clear();
    }
  });

  list.addEventListener('click', (event) => {
    const li = event.target.closest?.('[role="option"]');
    if (li) open(Number(li.dataset.index));
  });
  // Keep the focus in the field: a click on a result must not blur it first.
  list.addEventListener('mousedown', (event) => event.preventDefault());

  return {
    focus() {
      input.focus();
      input.select();
    },
    clear,
    /** Marks the result of the page on show. */
    markCurrent(slug) {
      currentSlug = slug;
      for (const li of list.children) {
        li.classList.toggle('manual-result--current', results[Number(li.dataset.index)]?.slug === slug);
      }
    },
    /** After a language change: a new index, and the query run again on it. */
    refreshLocale() {
      index = null;
      indexLocale = null;
      building = null;
      if (input.value) void run();
    },
  };
}
