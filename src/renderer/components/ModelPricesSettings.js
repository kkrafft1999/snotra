/**
 * *Settings › Models › Prices for the cost estimate* (#949).
 *
 * Shows which price table is in use, updates it on request, and lets the
 * user set a price of their own per model — for a discount, an Azure
 * deployment or a self-hosted model the table does not know. Like the web
 * search key, every change here is saved at once and does not wait for the
 * dialog's Apply: a price is not a draft of the model list.
 *
 * Prices are shown and entered **per million tokens**; main keeps them per
 * token, the unit of the table.
 */
import contracts from '../generated/contracts.js';
import { getLocale, onLocaleChange, t } from '../i18n.js';

const { PRICE_SOURCES } = contracts;

const PER_MILLION = 1_000_000;
const PRICE_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
const REQUIRED_FIELDS = new Set(['input', 'output']);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function perMillion(value) {
  return Number(value) * PER_MILLION;
}

function formatPerMillion(value) {
  return new Intl.NumberFormat(getLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(perMillion(value));
}

/** "1.75", "1,75" and "" alike; null for anything that is not a price. */
export function parsePriceInput(raw) {
  const text = String(raw ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!text) return undefined;
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function fieldValue(value) {
  if (value === undefined || value === null) return '';
  // As many places as the price needs, without a float tail.
  return String(Number(perMillion(value).toFixed(6)));
}

export function initModelPricesSettings({ root, api, getModels } = {}) {
  if (!root) return { refresh: async () => {}, reveal: () => {} };
  const tableLine = root.querySelector('#model-prices-table');
  const updateButton = root.querySelector('#btn-model-prices-update');
  const status = root.querySelector('#model-prices-status');
  const list = root.querySelector('#model-prices-list');
  const empty = root.querySelector('#model-prices-empty');

  let state = null;
  let editing = '';
  let generation = 0;

  function modelsToDescribe() {
    const seen = new Set();
    const out = [];
    for (const entry of (typeof getModels === 'function' ? getModels() : []) || []) {
      const model = typeof entry?.model === 'string' ? entry.model.trim() : '';
      if (!model) continue;
      const key = `${entry.providerId}\u0000${model.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ providerId: entry.providerId || '', model, baseUrl: entry.baseUrl || '' });
    }
    return out;
  }

  async function refresh() {
    const mine = ++generation;
    let next;
    try {
      next = await api.describeModelPrices(modelsToDescribe());
    } catch {
      next = null;
    }
    if (mine !== generation) return;
    state = next;
    render();
  }

  function describeTable(table) {
    if (!table?.date) return t('settings.prices.table.none');
    const date = new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(new Date(`${table.date}T00:00:00`));
    return t(table.origin === 'downloaded' ? 'settings.prices.table.downloaded' : 'settings.prices.table.bundled', {
      date,
      count: new Intl.NumberFormat(getLocale()).format(table.modelCount || 0),
    });
  }

  function sourceLabel(row) {
    switch (row.priceSource) {
      case PRICE_SOURCES.OVERRIDE: return t('settings.prices.source.override');
      case PRICE_SOURCES.TABLE: return t('settings.prices.source.table');
      case PRICE_SOURCES.LOCAL: return t('settings.prices.source.local');
      default: return t('settings.prices.source.none');
    }
  }

  function priceSummary(price) {
    if (!price) return '';
    return t('settings.prices.summary', {
      input: formatPerMillion(price.input),
      output: formatPerMillion(price.output),
    });
  }

  function renderForm(row) {
    const form = el('form', 'model-prices__form');
    form.noValidate = true;
    form.dataset.model = row.model;
    const start = row.override || row.tablePrice || null;
    const grid = el('div', 'model-prices__fields');
    for (const field of PRICE_FIELDS) {
      const id = `model-price-${field}-${CSS.escape(row.model).replace(/[^a-z0-9_-]/gi, '_')}`;
      const wrap = el('div', 'modal-field-group model-prices__field');
      const label = el('label', 'modal-field-label', t(`settings.prices.field.${field}`));
      label.htmlFor = id;
      const input = el('input', 'modal-input model-prices__input');
      input.id = id;
      input.name = field;
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.value = fieldValue(start?.[field]);
      if (REQUIRED_FIELDS.has(field)) input.required = true;
      else input.placeholder = t('settings.prices.field.optional');
      wrap.append(label, input);
      grid.appendChild(wrap);
    }
    form.appendChild(grid);
    form.appendChild(el('p', 'modal-hint', t('settings.prices.form.hint')));
    const error = el('p', 'model-prices__error hidden');
    error.setAttribute('role', 'alert');
    form.appendChild(error);
    const actions = el('div', 'model-prices__actions');
    const save = el('button', 'btn-primary', t('settings.prices.form.save'));
    save.type = 'submit';
    actions.appendChild(save);
    if (row.override) {
      const reset = el('button', 'btn-secondary', t('settings.prices.form.reset'));
      reset.type = 'button';
      reset.dataset.action = 'reset';
      actions.appendChild(reset);
    }
    const cancel = el('button', 'btn-secondary', t('settings.prices.form.cancel'));
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    actions.appendChild(cancel);
    form.appendChild(actions);
    return form;
  }

  function render() {
    if (tableLine) tableLine.textContent = state ? describeTable(state.table) : t('settings.prices.table.unreadable');
    if (!list) return;
    const hadFocus = list.contains(document.activeElement);
    list.textContent = '';
    const rows = state?.models || [];
    empty?.classList.toggle('hidden', rows.length > 0);
    for (const row of rows) {
      const item = el('li', 'model-prices__row');
      item.dataset.model = row.model;
      const main = el('div', 'model-prices__main');
      const name = el('span', 'model-prices__name', row.model);
      name.title = row.model;
      const detail = el('span', 'model-prices__detail');
      const source = el('span', `model-prices__source model-prices__source--${row.priceSource || 'none'}`, sourceLabel(row));
      detail.appendChild(source);
      const summary = priceSummary(row.price);
      if (summary) detail.appendChild(el('span', 'model-prices__summary', summary));
      main.append(name, detail);
      item.appendChild(main);
      const edit = el('button', 'btn-secondary model-prices__edit', t(row.override ? 'settings.prices.edit' : 'settings.prices.set'));
      edit.type = 'button';
      edit.dataset.action = 'edit';
      edit.setAttribute('aria-expanded', editing === row.model ? 'true' : 'false');
      edit.setAttribute('aria-label', t(row.override ? 'settings.prices.edit.label' : 'settings.prices.set.label', { model: row.model }));
      item.appendChild(edit);
      if (editing === row.model) item.appendChild(renderForm(row));
      list.appendChild(item);
    }
    if (hadFocus && editing) list.querySelector(`.model-prices__row[data-model="${CSS.escape(editing)}"] input`)?.focus();
  }

  function setStatus(text, { error = false } = {}) {
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  async function update() {
    if (!updateButton || updateButton.disabled) return;
    updateButton.disabled = true;
    updateButton.setAttribute('aria-busy', 'true');
    setStatus(t('settings.prices.update.running'));
    let result;
    try {
      result = await api.updateModelPrices();
    } catch {
      result = { ok: false, code: 'network' };
    }
    updateButton.disabled = false;
    updateButton.removeAttribute('aria-busy');
    if (result?.ok) {
      setStatus(t('settings.prices.update.done', {
        count: new Intl.NumberFormat(getLocale()).format(result.modelCount || 0),
      }));
    } else {
      const key = result?.code === 'invalid'
        ? 'settings.prices.update.invalid'
        : result?.code === 'write' ? 'settings.prices.update.write' : 'settings.prices.update.network';
      setStatus(t(key), { error: true });
    }
    await refresh();
  }

  async function saveForm(form) {
    const model = form.dataset.model;
    const error = form.querySelector('.model-prices__error');
    const price = {};
    let invalid = null;
    for (const field of PRICE_FIELDS) {
      const input = form.elements.namedItem(field);
      const value = parsePriceInput(input?.value);
      input?.removeAttribute('aria-invalid');
      if (value === null || (value === undefined && REQUIRED_FIELDS.has(field))) {
        invalid = invalid || input;
        input?.setAttribute('aria-invalid', 'true');
        continue;
      }
      if (value !== undefined) price[field] = value / PER_MILLION;
    }
    if (invalid) {
      error.textContent = t('settings.prices.form.invalid');
      error.classList.remove('hidden');
      invalid.focus();
      return;
    }
    const result = await api.setModelPriceOverride(model, price);
    if (!result?.ok) {
      error.textContent = t('settings.prices.form.failed');
      error.classList.remove('hidden');
      return;
    }
    editing = '';
    setStatus(t('settings.prices.saved', { model }));
    await refresh();
    focusEdit(model);
  }

  function focusEdit(model) {
    list?.querySelector(`.model-prices__row[data-model="${CSS.escape(model)}"] .model-prices__edit`)?.focus();
  }

  list?.addEventListener('click', async (event) => {
    const button = event.target.closest?.('button[data-action]');
    if (!button || !list.contains(button)) return;
    const model = button.closest('.model-prices__row')?.dataset.model || '';
    const action = button.dataset.action;
    if (action === 'edit') {
      editing = editing === model ? '' : model;
      render();
      if (editing) list.querySelector(`.model-prices__row[data-model="${CSS.escape(model)}"] input`)?.focus();
      else focusEdit(model);
    } else if (action === 'cancel') {
      editing = '';
      render();
      focusEdit(model);
    } else if (action === 'reset') {
      const result = await api.setModelPriceOverride(model, null);
      if (result?.ok) {
        editing = '';
        setStatus(t('settings.prices.reset', { model }));
        await refresh();
        focusEdit(model);
      }
    }
  });

  list?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveForm(event.target);
  });

  list?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !editing) return;
    event.stopPropagation();
    const model = editing;
    editing = '';
    render();
    focusEdit(model);
  });

  updateButton?.addEventListener('click', () => void update());
  onLocaleChange(render);

  /** From the cost popover: open the form of this model. */
  function reveal(model) {
    if (model && state?.models?.some((row) => row.model === model)) {
      editing = model;
      render();
      list.querySelector(`.model-prices__row[data-model="${CSS.escape(model)}"] input`)?.focus();
    }
  }

  return { refresh, reveal, render };
}
