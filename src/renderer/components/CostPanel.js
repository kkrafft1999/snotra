/**
 * Estimated cost of the chat (#949): a chip in the composer bar, next to the
 * token counter, and the popover it opens.
 *
 * The chip shows the sum over the whole chat, the popover splits it per model
 * and per kind of token. Everything here is an estimate — prices from a
 * public table, no special tiers — and says so. A model without a known price
 * shows `–`, never 0; a model on the user's own machine shows 0, because
 * there is no bill.
 *
 * The sum itself is kept by ChatStream (appStore.chatCost) and saved with the
 * chat; this file only draws it.
 */
import contracts from '../generated/contracts.js';
import { dismissOnFocusLeave, dismissOnOutsideClick } from '../utils/helpers.js';
import { getLocale, onLocaleChange, t } from '../i18n.js';
import { formatTokensShort } from './TokenBreakdownPanel.js';

const { COST_TOKEN_KINDS, PRICE_SOURCES, costEntryUsd, formatUsd, normalizeSessionCost, summarizeSessionCost } = contracts;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** The sum as the chip and the popover header write it: `~$0.42`, `–`. */
export function formatCostAmount(summary) {
  if (!summary || summary.usd === null) return t('cost.unknown');
  return formatEstimate(summary.usd, { partial: !summary.complete });
}

/**
 * `~$0.42` — the tilde marks the estimate. Below a cent `<$0.01` says that
 * already, and a tilde in front of it would only stutter.
 */
function formatEstimate(usd, { partial = false } = {}) {
  const amount = formatUsd(usd, getLocale());
  if (usd > 0 && usd < 0.01) return partial ? t('cost.amount.partialRaw', { amount }) : amount;
  return t(partial ? 'cost.amount.partial' : 'cost.amount', { amount });
}

const TOKEN_KIND_LABEL_KEYS = Object.freeze({
  input: 'cost.kind.input',
  cacheRead: 'cost.kind.cacheRead',
  cacheWrite: 'cost.kind.cacheWrite',
  output: 'cost.kind.output',
});

export function initCostPanel({ trigger, valueEl, panel, getCost, onOpenPriceSettings } = {}) {
  let open = false;
  let rendering = false;
  const wrap = trigger?.closest('.chat-cost-wrap') || null;

  function currentCost() {
    return normalizeSessionCost(typeof getCost === 'function' ? getCost() : null);
  }

  /** The chip: hidden until a round was spent, then the sum. */
  function syncChip() {
    if (!trigger) return;
    const cost = currentCost();
    if (wrap) wrap.hidden = !cost;
    if (!cost) {
      if (open) closePanel();
      return;
    }
    const summary = summarizeSessionCost(cost);
    const amount = formatCostAmount(summary);
    if (valueEl) valueEl.textContent = amount;
    const label = summary.usd === null
      ? t('cost.chip.label.unknown')
      : t(summary.complete ? 'cost.chip.label' : 'cost.chip.label.partial', { amount });
    trigger.setAttribute('aria-label', label);
    trigger.title = label;
  }

  function buildModel(entry) {
    const item = el('li', 'chat-cost__model');
    const head = el('div', 'chat-cost__model-head');
    const name = el('span', 'chat-cost__model-name', entry.model || entry.providerId);
    name.title = entry.model || entry.providerId;
    const usd = costEntryUsd(entry);
    const total = el('span', 'chat-cost__model-total', usd === null
      ? t('cost.unknown')
      : formatEstimate(usd, { partial: entry.unpricedRounds > 0 }));
    head.append(name, total);
    item.appendChild(head);

    if (entry.priceSource === PRICE_SOURCES.LOCAL && entry.unpricedRounds === 0) {
      item.appendChild(el('p', 'chat-cost__model-note', t('cost.model.local')));
    } else if (entry.priceSource === PRICE_SOURCES.OVERRIDE) {
      item.appendChild(el('p', 'chat-cost__model-note', t('cost.model.override')));
    }

    const table = el('table', 'chat-cost__rows');
    const caption = el('caption', 'visually-hidden', t('cost.rows.caption', { model: entry.model || entry.providerId }));
    table.appendChild(caption);
    const body = el('tbody');
    for (const kind of COST_TOKEN_KINDS) {
      const tokens = entry.tokens?.[kind] || 0;
      if (tokens <= 0) continue;
      const row = el('tr');
      let label = t(TOKEN_KIND_LABEL_KEYS[kind]);
      if (kind === 'output' && entry.tokens.reasoning > 0) {
        label = t('cost.kind.outputWithReasoning', { reasoning: formatTokensShort(entry.tokens.reasoning) });
      }
      row.appendChild(el('th', 'chat-cost__row-label', label)).setAttribute('scope', 'row');
      row.appendChild(el('td', 'chat-cost__row-tokens', formatTokensShort(tokens)));
      row.appendChild(el('td', 'chat-cost__row-usd', entry.usd
        ? formatUsd(entry.usd[kind] || 0, getLocale())
        : t('cost.unknown')));
      body.appendChild(row);
    }
    table.appendChild(body);
    item.appendChild(table);

    if (entry.unpricedRounds > 0) {
      const note = el('p', 'chat-cost__model-note chat-cost__model-note--unpriced');
      note.appendChild(document.createTextNode(
        entry.unpricedRounds === entry.rounds ? t('cost.model.unpriced') : t('cost.model.partlyUnpriced')
      ));
      if (typeof onOpenPriceSettings === 'function') {
        note.appendChild(document.createTextNode(' '));
        const link = el('button', 'chat-cost__link', t('cost.model.setPrice'));
        link.type = 'button';
        link.dataset.model = entry.model || '';
        note.appendChild(link);
      }
      item.appendChild(note);
    }
    return item;
  }

  function build() {
    const cost = currentCost();
    const summary = summarizeSessionCost(cost);
    panel.textContent = '';

    const header = el('div', 'chat-cost__header');
    const title = el('h2', 'chat-cost__title', t('cost.title'));
    title.id = 'chat-cost-breakdown-title';
    header.appendChild(title);
    header.appendChild(el('p', 'chat-cost__sum', t('cost.sum', {
      amount: formatCostAmount(summary),
      input: formatTokensShort(summary.tokens.input + summary.tokens.cacheRead + summary.tokens.cacheWrite),
      output: formatTokensShort(summary.tokens.output),
    })));
    panel.appendChild(header);

    if (!cost) {
      panel.appendChild(el('p', 'chat-cost__note', t('cost.empty')));
      return;
    }

    const list = el('ul', 'chat-cost__models');
    for (const entry of cost.models) list.appendChild(buildModel(entry));
    panel.appendChild(list);

    const foot = el('div', 'chat-cost__foot');
    const table = cost.priceTable;
    if (table) {
      foot.appendChild(el('p', 'chat-cost__note', t(
        table.origin === 'downloaded' ? 'cost.table.downloaded' : 'cost.table.bundled',
        { date: new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(new Date(`${table.date}T00:00:00`)) }
      )));
    }
    foot.appendChild(el('p', 'chat-cost__note', t('cost.note.estimate')));
    foot.appendChild(el('p', 'chat-cost__note', t('cost.note.notCounted')));
    panel.appendChild(foot);
  }

  function render() {
    const hadFocus = panel.contains(document.activeElement);
    rendering = true;
    try {
      build();
    } finally {
      rendering = false;
    }
    if (hadFocus) panel.focus();
  }

  function openPanel() {
    if (open || !currentCost()) return;
    open = true;
    render();
    panel.classList.remove('hidden');
    trigger?.setAttribute('aria-expanded', 'true');
    panel.focus();
  }

  function closePanel({ focusTrigger = false } = {}) {
    if (!open) return;
    open = false;
    panel.classList.add('hidden');
    panel.textContent = '';
    trigger?.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger?.focus();
  }

  function toggle() {
    if (open) closePanel({ focusTrigger: true });
    else openPanel();
  }

  /** New figures or another chat on screen. */
  function refresh() {
    syncChip();
    if (open) render();
  }

  onLocaleChange(refresh);

  dismissOnOutsideClick({
    isOpen: () => open,
    ownsTarget: (target) => !!target?.closest?.('.chat-cost-wrap'),
    onDismiss: () => closePanel(),
  });

  dismissOnFocusLeave({
    container: wrap,
    isOpen: () => open,
    isPaused: () => rendering,
    onDismiss: () => closePanel(),
  });

  trigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });

  panel?.addEventListener('click', (event) => {
    const link = event.target.closest?.('.chat-cost__link');
    if (!link) return;
    closePanel();
    onOpenPriceSettings?.(link.dataset.model || '');
  });

  for (const node of [panel, trigger]) {
    node?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        closePanel({ focusTrigger: true });
      }
    });
  }

  syncChip();
  return { isOpen: () => open, open: openPanel, close: closePanel, toggle, refresh };
}
