// Settings › Knowledge (#1278, mockup variant A): besides the procedures
// (skills) and the facts (memory), which keep their own components, the rules
// files of both levels, the AGENTS.md files found, and the agent's last
// changes to knowledge files with Undo. A folder file that showed a covert
// signal (#1280) is marked with the words of the context breakdown.

import { t } from '../i18n.js';

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A tag in the row, as the skills list shows its badges. */
function badge(text, warn = false) {
  return el('span', `settings-tool-item__badge knowledge-badge${warn ? ' knowledge-badge--warn' : ''}`, text);
}

/** The words of the context breakdown for a covert signal (#1280). */
function covertNote(kinds) {
  const box = el('p', 'knowledge-covert');
  box.appendChild(el('strong', null, t('context.covert.title')));
  box.append(' ', kinds.map((kind) => t(`context.covert.kind.${kind}`)).join(' · '));
  return box;
}

/** @param {number} chars */
function charCount(chars) {
  return t('settings.knowledge.chars', { count: Number(chars || 0).toLocaleString(document.documentElement.lang || undefined) });
}

/**
 * @param {{ api: any }} deps
 */
export function initKnowledgePanel({ api } = {}) {
  const rulesRoot = document.getElementById('settings-knowledge-rules');
  const agentsRoot = document.getElementById('settings-knowledge-agents');
  const journalRoot = document.getElementById('settings-knowledge-journal');
  const factsSection = document.getElementById('knowledge-section-facts');
  if (!rulesRoot || !agentsRoot || !journalRoot || !api?.getKnowledgeState) return { refresh: async () => {} };

  /** @type {any} */
  let state = null;
  const status = el('p', 'knowledge-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  function say(text) {
    status.textContent = text || '';
  }

  /** @param {any} result */
  function take(result) {
    if (result?.ok === false || result?.error) {
      say(typeof result.error === 'string' ? result.error : t(result.error?.key || 'settings.knowledge.error.invalid', result.error?.params));
      return false;
    }
    if (result?.state) {
      state = result.state;
      render();
    }
    return true;
  }

  function switchInput(label, checked, onChange) {
    const input = el('input', 'ds-switch');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.checked = checked;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  }

  function openButton(file) {
    const button = el('button', 'btn-secondary knowledge-open', t('settings.knowledge.open'));
    button.type = 'button';
    button.setAttribute('aria-label', t('settings.knowledge.open.label', { path: file.path }));
    button.addEventListener('click', async () => take(await api.openKnowledgeFile(file.request)));
    return button;
  }

  function renderRule(level, file) {
    const row = el('li', 'knowledge-row');
    row.appendChild(switchInput(t('settings.knowledge.rule.switch', { name: file.name }), file.on, async (enabled) => {
      take(await api.setRuleSwitch({ key: file.key, enabled }));
    }));
    const body = el('div', 'knowledge-row__body');
    const head = el('div', 'knowledge-row__head');
    head.appendChild(el('code', 'knowledge-row__name', file.name));
    if (file.always) head.appendChild(badge(t('settings.knowledge.badge.always')));
    if (file.descriptionDerived) head.appendChild(badge(t('settings.knowledge.badge.derived')));
    if (file.truncated) head.appendChild(badge(t('settings.knowledge.badge.truncated'), true));
    if (file.overBudget) head.appendChild(badge(t('settings.knowledge.badge.overBudget'), true));
    if (file.givenWay) head.appendChild(badge(t('settings.knowledge.badge.givenWay'), true));
    if (file.shadowed) head.appendChild(badge(t('settings.knowledge.badge.shadowed')));
    body.appendChild(head);
    body.appendChild(el('p', 'knowledge-row__desc', file.description || ''));
    body.appendChild(el('p', 'knowledge-row__meta', `${file.path} · ${charCount(file.chars)}`));
    if (file.covert?.length) body.appendChild(covertNote(file.covert));
    row.appendChild(body);
    row.appendChild(openButton({ path: file.path, request: { kind: 'rule', source: file.source, name: file.name } }));
    if (!level.enabled) row.classList.add('knowledge-row--off');
    return row;
  }

  function renderNewRuleForm(level, container, trigger) {
    const form = el('form', 'knowledge-new');
    const id = `knowledge-new-${level.level}`;
    const nameLabel = el('label', 'modal-field-label', t('settings.knowledge.new.name'));
    nameLabel.htmlFor = `${id}-name`;
    const name = el('input', 'modal-input');
    name.id = `${id}-name`;
    name.required = true;
    name.pattern = '[a-z0-9-]{1,64}';
    name.placeholder = 'commit-messages';
    const descLabel = el('label', 'modal-field-label', t('settings.knowledge.new.description'));
    descLabel.htmlFor = `${id}-description`;
    const description = el('input', 'modal-input');
    description.id = `${id}-description`;
    description.required = true;
    description.maxLength = 200;
    description.placeholder = t('settings.knowledge.new.description.placeholder');
    const alwaysRow = el('label', 'knowledge-new__always');
    const always = el('input');
    always.type = 'checkbox';
    alwaysRow.append(always, ' ', t('settings.knowledge.new.always'));
    const actions = el('div', 'knowledge-new__actions');
    const create = el('button', 'btn-primary', t('settings.knowledge.new.create'));
    create.type = 'submit';
    const cancel = el('button', 'btn-secondary', t('settings.knowledge.new.cancel'));
    cancel.type = 'button';
    actions.append(create, cancel);
    form.append(nameLabel, name, descLabel, description, alwaysRow, actions);
    const close = () => {
      form.remove();
      trigger.hidden = false;
      trigger.focus();
    };
    cancel.addEventListener('click', close);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (take(await api.newRuleFile({ level: level.level, name: name.value.trim(), description: description.value.trim(), always: always.checked }))) {
        say(t('settings.knowledge.new.done', { name: name.value.trim() }));
      }
    });
    trigger.hidden = true;
    container.appendChild(form);
    name.focus();
  }

  function renderRules() {
    rulesRoot.replaceChildren();
    for (const level of state.rules) {
      const card = el('div', 'knowledge-level');
      const head = el('div', 'knowledge-level__head');
      head.appendChild(el('h4', 'knowledge-level__title', t(`settings.knowledge.level.${level.level}`)));
      head.appendChild(el('code', 'knowledge-level__path', level.dir));
      head.appendChild(switchInput(t('settings.knowledge.level.switch', { level: t(`settings.knowledge.level.${level.level}`) }), level.enabled, async (enabled) => {
        take(await api.setRuleSwitch({ level: level.level, enabled }));
      }));
      card.appendChild(head);
      if (!level.available) {
        card.appendChild(el('p', 'settings-empty-hint', t('settings.knowledge.rules.noFolder')));
        rulesRoot.appendChild(card);
        continue;
      }
      if (level.files.length === 0) card.appendChild(el('p', 'settings-empty-hint', t('settings.knowledge.rules.empty')));
      else {
        const list = el('ul', 'knowledge-list');
        for (const file of level.files) list.appendChild(renderRule(level, file));
        card.appendChild(list);
      }
      const notes = [];
      if (level.inSubfolders) notes.push(t('settings.knowledge.rules.subfolders', { count: level.inSubfolders }));
      if (level.overLimit) notes.push(t('settings.knowledge.rules.overLimit', { count: level.overLimit }));
      if (level.invalid?.length) notes.push(t('settings.knowledge.rules.invalid', { files: level.invalid.join(', ') }));
      for (const note of notes) card.appendChild(el('p', 'knowledge-note', note));
      const add = el('button', 'btn-secondary knowledge-add', t('settings.knowledge.new'));
      add.type = 'button';
      add.addEventListener('click', () => renderNewRuleForm(level, card, add));
      card.appendChild(add);
      rulesRoot.appendChild(card);
    }
  }

  function renderAgents() {
    agentsRoot.replaceChildren();
    if (state.agents.files.length === 0) {
      agentsRoot.appendChild(el('p', 'settings-empty-hint', state.agents.enabled ? t('settings.knowledge.agents.empty') : t('settings.knowledge.agents.off')));
      return;
    }
    const list = el('ul', 'knowledge-list');
    for (const file of state.agents.files) {
      const row = el('li', 'knowledge-row knowledge-row--plain');
      const body = el('div', 'knowledge-row__body');
      const head = el('div', 'knowledge-row__head');
      head.appendChild(el('code', 'knowledge-row__name', file.inFolder ? `<${t('settings.knowledge.folder')}>/${file.path}` : file.path));
      if (file.truncated) head.appendChild(badge(t('settings.knowledge.badge.truncated'), true));
      if (file.givenWay) head.appendChild(badge(t('settings.knowledge.badge.shortened'), true));
      body.appendChild(head);
      body.appendChild(el('p', 'knowledge-row__meta', charCount(file.chars)));
      if (file.covert?.length) body.appendChild(covertNote(file.covert));
      row.appendChild(body);
      row.appendChild(openButton({ path: file.path, request: { kind: 'agents', source: file.source, name: '' } }));
      list.appendChild(row);
    }
    agentsRoot.appendChild(list);
  }

  function renderJournal() {
    journalRoot.replaceChildren();
    if (state.journal.length === 0) {
      journalRoot.appendChild(el('p', 'settings-empty-hint', t('settings.knowledge.journal.empty')));
      return;
    }
    const list = el('ul', 'knowledge-list knowledge-journal');
    for (const entry of state.journal) {
      const row = el('li', 'knowledge-row knowledge-row--plain');
      const body = el('div', 'knowledge-row__body');
      const when = new Date(entry.at);
      body.appendChild(el('p', 'knowledge-row__meta', `${when.toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'short', timeStyle: 'short' })} · ${t(`settings.knowledge.journal.source.${entry.source === 'file-tool' ? 'fileTool' : entry.source}`)} · ${entry.path}`));
      if (entry.before) body.appendChild(el('p', 'knowledge-journal__old', entry.before));
      if (entry.after) body.appendChild(el('p', 'knowledge-journal__new', entry.after));
      row.appendChild(body);
      const undo = el('button', 'btn-secondary', t('settings.knowledge.undo'));
      undo.type = 'button';
      undo.disabled = entry.undoable === false;
      undo.setAttribute('aria-label', t('settings.knowledge.undo.label', { path: entry.path }));
      undo.addEventListener('click', async () => {
        if (take(await api.undoKnowledgeChange(entry.id))) say(t('settings.knowledge.undo.done', { path: entry.path }));
      });
      row.appendChild(undo);
      list.appendChild(row);
    }
    journalRoot.appendChild(list);
  }

  function renderFactsMark() {
    factsSection?.querySelector('.knowledge-covert')?.remove();
    if (state.memoryCovert?.length && factsSection) {
      const title = factsSection.querySelector('.knowledge-section__title');
      title?.after(covertNote(state.memoryCovert));
    }
  }

  function render() {
    renderRules();
    renderAgents();
    renderJournal();
    renderFactsMark();
    if (!status.isConnected) journalRoot.after(status);
  }

  return {
    async refresh() {
      try {
        state = await api.getKnowledgeState();
        render();
      } catch (error) {
        console.warn('[knowledge] the state could not be loaded:', error);
        say(t('settings.knowledge.error.load'));
      }
    },
  };
}
