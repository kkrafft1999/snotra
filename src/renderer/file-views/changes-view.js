// "Show changes": what the agent changed in a file, as a line diff (#348).
//
// Decided with a mockup on 2026-10-02: the diff opens in this column, as one
// column of `−`/`+` lines with three unchanged lines around each change, and
// added lines on a blue ground, removed ones on a grey one. The `+`/`−` sign
// and the bar at the edge carry the meaning; the colour only adds to it.
//
// The view is not part of the registry: no file *is* a diff. The host mounts
// it on request, with the ids of the changes to show in `context.changes`
// (`{ ids, selected }`, oldest first), and puts its own "Content | Changes"
// switch next to the tools set here. Every text goes in as `textContent`.

import { t, tPlural } from '../i18n.js';
import { formatSize } from '../utils/helpers.js';
import { buildDiffRows } from './diff-model.js';

/** Line rows rendered at once; the rest follow on request. */
const ROWS_PER_CHUNK = 2000;
/** A load that answers within this shows no loading line at all. */
const LOADING_DELAY_MS = 150;

const ALL = 'all';

const INFO_ICON =
  '<svg class="changes-banner-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4"/><path d="M8 4.8v.01"/></svg>';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** What the size pill says for a result. */
const SHORT_KEYS = {
  'eol-only': 'changes.short.eol',
  binary: 'changes.short.binary',
  'too-large': 'changes.short.tooLarge',
  unchanged: 'changes.short.unchanged',
};

export function changesMetaText(result) {
  if (!result?.ok) return t('changes.short.unavailable');
  if (result.status !== 'text') return t(SHORT_KEYS[result.status] || 'changes.short.unavailable');
  if (result.created) return `${t('changes.meta.created')} · +${result.added}`;
  return `+${result.added} −${result.removed}`;
}

function eolName(kind) {
  return t(`changes.eol.${kind}`);
}

/** Title and detail of a result that has no lines to show, or null. */
export function describeChangeState(result) {
  if (!result) return { title: t('changes.state.failed.title'), detail: t('changes.state.failed.detail') };
  if (!result.ok) {
    const reason = ['restarted', 'evicted'].includes(result.reason) ? result.reason : 'unknown';
    return { title: t('changes.state.unavailable.title'), detail: t(`changes.state.unavailable.${reason}`) };
  }
  switch (result.status) {
    case 'binary':
      return {
        title: t('changes.state.binary.title'),
        detail: result.created
          ? t('changes.state.binary.created', { after: formatSize(result.afterBytes) })
          : t('changes.state.binary.detail', { before: formatSize(result.beforeBytes), after: formatSize(result.afterBytes) }),
      };
    case 'too-large':
      return {
        title: t('changes.state.tooLarge.title'),
        detail: result.reason === 'lines'
          ? t('changes.state.tooLarge.lines', { limit: (result.limitLines || 0).toLocaleString() })
          : t('changes.state.tooLarge.bytes', {
            size: formatSize(Math.max(result.beforeBytes || 0, result.afterBytes || 0)),
            limit: formatSize(result.limitBytes || 0),
          }),
      };
    case 'unchanged':
      return { title: t('changes.state.unchanged.title'), detail: t('changes.state.unchanged.detail') };
    case 'eol-only': {
      let detail;
      if (result.eolChange) {
        detail = tPlural('changes.state.eol.lines', result.lineCount || 0, {
          count: result.lineCount || 0,
          from: eolName(result.eolChange.from),
          to: eolName(result.eolChange.to),
        });
      } else if (result.finalNewline) {
        detail = t(`changes.state.eol.final.${result.finalNewline === 'added' ? 'added' : 'removed'}`);
      } else {
        detail = t('changes.state.eol.invisible');
      }
      return { title: t('changes.state.eol.title'), detail };
    }
    case 'text':
      if (result.created && result.added === 0) {
        return { title: t('changes.state.createdEmpty.title'), detail: t('changes.state.createdEmpty.detail') };
      }
      return null;
    default:
      return { title: t('changes.state.failed.title'), detail: t('changes.state.failed.detail') };
  }
}

/** The notes above the diff: the file moved on, or everything changed. */
function bannerTexts(result) {
  const texts = [];
  if (result?.ok && result.changedSince === 'deleted') texts.push(t('changes.banner.deletedSince'));
  else if (result?.ok && result.changedSince === 'changed') texts.push(t('changes.banner.changedSince'));
  if (result?.ok && result.status === 'text') {
    if (result.approximate) texts.push(t('changes.banner.approximate'));
    else if (result.rewritten) texts.push(t('changes.banner.rewritten'));
  }
  return texts;
}

function buildBanners(result) {
  const box = element('div', 'changes-banners');
  for (const text of bannerTexts(result)) {
    const banner = element('div', 'changes-banner');
    banner.setAttribute('role', 'note');
    banner.insertAdjacentHTML('afterbegin', INFO_ICON);
    banner.append(element('span', 'changes-banner-text', text));
    box.append(banner);
  }
  return box;
}

function buildLineRow(line) {
  const row = element('tr', `diff-row diff-row--${line.type}`);
  row.append(
    element('td', 'diff-num diff-num--old', line.oldNo === null ? '' : String(line.oldNo)),
    element('td', 'diff-num diff-num--new', line.newNo === null ? '' : String(line.newNo)),
  );
  const mark = element('td', 'diff-mark');
  const sign = line.type === 'insert' ? '+' : line.type === 'delete' ? '−' : '';
  mark.append(element('span', '', sign));
  mark.firstChild.setAttribute('aria-hidden', 'true');
  const kind = line.type === 'insert' ? 'added' : line.type === 'delete' ? 'removed' : 'unchanged';
  mark.append(element('span', 'sr-only', t(`changes.kind.${kind}`)));
  row.append(mark, element('td', 'diff-text', line.text));
  return row;
}

export const changesView = {
  id: 'changes',
  kind: 'viewer',
  reads: 'none',

  canHandle() {
    return false;
  },

  async mount(hostEl, { file, api, changes, setTools, setMeta }) {
    const ids = Array.isArray(changes?.ids) ? changes.ids.filter((id) => typeof id === 'string') : [];
    let selected = changes?.selected && ids.includes(changes.selected) ? changes.selected : ALL;
    let alive = true;
    let ticket = 0;
    let shownResult = null;

    const root = element('div', 'changes-view');
    root.tabIndex = -1;
    hostEl.append(root);

    let select = null;
    if (ids.length > 1) {
      select = element('select', 'changes-select');
      select.addEventListener('change', () => {
        selected = select.value;
        void load();
      });
    }
    function renderSelect() {
      if (!select) return;
      select.setAttribute('aria-label', t('changes.select.label'));
      const options = [{ value: ALL, text: t('changes.select.all', { count: ids.length }) }]
        .concat(ids.map((id, index) => ({ value: id, text: t('changes.select.one', { index: index + 1, count: ids.length }) })));
      select.replaceChildren(...options.map(({ value, text }) => {
        const option = element('option', '', text);
        option.value = value;
        return option;
      }));
      select.value = selected;
    }
    renderSelect();
    setTools(select ? [select] : []);

    const idsToLoad = () => (selected === ALL ? ids : [selected]);

    async function fetchResult() {
      try {
        return await api.getFileChanges(idsToLoad());
      } catch (err) {
        console.warn('Changes could not be loaded:', err?.message ?? err);
        return null;
      }
    }

    function renderState(state) {
      const box = element('div', 'changes-state');
      box.append(element('strong', 'changes-state-title', state.title));
      if (state.detail) box.append(element('p', 'changes-state-detail', state.detail));
      return box;
    }

    function renderTable(result) {
      const rows = buildDiffRows(result);
      const table = element('table', 'diff-table');
      table.setAttribute('aria-label', t('changes.table.label', { name: file.name }));
      const head = element('thead', 'sr-only');
      const headRow = element('tr');
      for (const key of ['old', 'new', 'kind', 'text']) headRow.append(element('th', '', t(`changes.col.${key}`)));
      head.append(headRow);
      const body = element('tbody');
      // Fixed widths up front: with `table-layout: fixed` the first row sets
      // them, and that row may be a gap spanning all four columns.
      const columns = element('colgroup');
      for (const name of ['old', 'new', 'mark', 'text']) columns.append(element('col', `diff-col diff-col--${name}`));
      table.append(columns, head, body);

      // Rendered in chunks: a rewritten 20,000-line file is 40,000 rows.
      let next = 0;
      let moreRow = null;
      function renderChunk() {
        moreRow?.remove();
        moreRow = null;
        let lineCount = 0;
        while (next < rows.length && lineCount < ROWS_PER_CHUNK) {
          const row = rows[next];
          next += 1;
          if (row.kind === 'gap') body.append(buildGapRow(row));
          else {
            body.append(buildLineRow(row));
            lineCount += 1;
          }
        }
        if (next < rows.length) {
          const remaining = rows.slice(next).reduce((sum, row) => sum + (row.kind === 'gap' ? 0 : 1), 0);
          moreRow = buildActionRow(
            tPlural('changes.more', Math.min(remaining, ROWS_PER_CHUNK), { count: Math.min(remaining, ROWS_PER_CHUNK) }),
            () => {
              renderChunk();
              root.focus({ preventScroll: true });
            }
          );
          body.append(moreRow);
        }
      }
      function buildGapRow(gap) {
        const row = buildActionRow(
          tPlural('changes.expand', gap.lines.length, { count: gap.lines.length }),
          () => {
            const fragment = document.createDocumentFragment();
            for (const line of gap.lines) fragment.append(buildLineRow(line));
            // The button goes with its row: keep the focus in the view.
            const following = row.nextElementSibling?.querySelector('button');
            row.replaceWith(fragment);
            (following || root).focus({ preventScroll: true });
          }
        );
        row.classList.add('diff-gap');
        return row;
      }
      renderChunk();
      return table;
    }

    function buildActionRow(label, onClick) {
      const row = element('tr', 'diff-action');
      const cell = element('td');
      cell.colSpan = 4;
      const button = element('button', 'diff-action-button', label);
      button.type = 'button';
      button.addEventListener('click', onClick);
      cell.append(button);
      row.append(cell);
      return row;
    }

    function render(result) {
      shownResult = result;
      setMeta({ text: changesMetaText(result) });
      const state = describeChangeState(result);
      const parts = [buildBanners(result)];
      parts.push(state ? renderState(state) : renderTable(result));
      root.replaceChildren(...parts);
    }

    async function load() {
      const mine = ++ticket;
      const loadingTimer = setTimeout(() => {
        if (alive && mine === ticket) root.replaceChildren(element('p', 'changes-loading', t('changes.loading')));
      }, LOADING_DELAY_MS);
      const result = await fetchResult();
      clearTimeout(loadingTimer);
      if (!alive || mine !== ticket) return;
      render(result);
      hostEl.scrollTop = 0;
    }

    await load();

    return {
      // The file changed on disk: only the note about it can be different.
      async update() {
        const mine = ++ticket;
        const result = await fetchResult();
        if (!alive || mine !== ticket || !result?.ok || !shownResult?.ok) return;
        if (result.changedSince === shownResult.changedSince) return;
        shownResult = { ...shownResult, changedSince: result.changedSince };
        root.querySelector('.changes-banners')?.replaceWith(buildBanners(shownResult));
      },
      applyLabels() {
        renderSelect();
        if (shownResult !== null) render(shownResult);
      },
      unmount() {
        alive = false;
      },
    };
  },
};
