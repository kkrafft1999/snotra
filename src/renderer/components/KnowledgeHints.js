// The hints of Settings › Knowledge (#1279, mockup variant A): a line under
// an entry or a file saying what it reads like, with the actions that fit —
// Remove, Edit, Move to rules…, Create a skill…, Merge… — and Dismiss.
//
// Main computes the hints and carries out every action; the page names a hint
// by its `ref` and nothing else. One line per entry, the others behind
// "+N more". Shared by the facts (MemoryPanel) and the rules (KnowledgePanel).

import { t, tMessage } from '../i18n.js';

/** The order a hint takes when an entry has several: the kind first. */
const ORDER = ['factLooksLikeRule', 'factLooksLikeProcedure', 'looksLikeEpisode', 'nearlyTheSame', 'similarTopicNames', 'notedAWhileAgo', 'closeToLimit'];

const INFO_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** @param {string} value @param {number} max */
function clip(value, max) {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** `2026-03-12` in the app language's date form. */
function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? t('format.date', { year: match[1], month: match[2], day: match[3] }) : value || '';
}

/** A first guess at what a skill is for: the procedure's opening words. */
function skillDescriptionOf(text) {
  const head = text.split(/[:.]\s/)[0].trim();
  return clip(head || text, 120);
}

let formCount = 0;

/**
 * @param {{ api: any }} deps
 */
export function createKnowledgeHints({ api }) {
  /** @type {any[]} */
  let hints = [];
  /** @type {any[]} */
  let levels = [];
  let folderOpen = false;
  /** Lines unfolded with "+N more", by the ref of their first hint. */
  const unfolded = new Set();

  const statuses = {
    facts: el('p', 'knowledge-hint-status'),
    rules: el('p', 'knowledge-hint-status'),
  };
  for (const status of Object.values(statuses)) {
    status.setAttribute('role', 'status');
    status.tabIndex = -1;
  }

  const self = {
    /** Set by app.js: the knowledge state anew, without redrawing the facts. */
    reload: async () => {},
    /** Set by app.js: the facts and the rest of the page anew. */
    refreshAll: async () => {},

    /** @param {any} state  the knowledge state from main */
    set(state) {
      hints = Array.isArray(state?.hints) ? [...state.hints].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)) : [];
      levels = Array.isArray(state?.rules) ? state.rules : [];
      folderOpen = Boolean(state?.workspaceRoot);
    },

    /** @param {'facts'|'rules'} area */
    status(area) {
      return statuses[area];
    },

    /** @param {string} scope @param {{ line: number, text: string }} entry */
    ofMemoryEntry(scope, entry) {
      return hints.filter((hint) => hint.at.kind === 'memory' && hint.at.scope === scope && hint.at.line === entry.line && hint.at.text === entry.text);
    },
    /** @param {string} scope */
    ofMemoryFile(scope) {
      return hints.filter((hint) => hint.at.kind === 'memoryFile' && hint.at.scope === scope);
    },
    /** @param {{ source: string, name: string }} file */
    ofRuleFile(file) {
      return hints.filter((hint) => hint.at.kind === 'ruleFile' && hint.at.source === file.source && hint.at.name === file.name);
    },
    /** The rules entries of a file that carry a hint, each with its hints. @param {{ source: string, name: string }} file */
    ofRuleEntries(file) {
      /** @type {Map<string, { text: string, line: number, hints: any[] }>} */
      const entries = new Map();
      for (const hint of hints) {
        if (hint.at.kind !== 'rule' || hint.at.source !== file.source || hint.at.name !== file.name) continue;
        const key = `${hint.at.line}`;
        if (!entries.has(key)) entries.set(key, { text: hint.at.text, line: hint.at.line, hints: [] });
        entries.get(key)?.hints.push(hint);
      }
      return [...entries.values()].sort((a, b) => a.line - b.line);
    },
    /** @param {string} level */
    ofRulesLevel(level) {
      return hints.filter((hint) => hint.at.kind === 'rulesLevel' && hint.at.level === level);
    },

    /**
     * The hint line for an entry or a file: the first hint, and "+N more"
     * for the rest. Null without hints.
     *
     * @param {any[]} list
     * @param {{ area: 'facts'|'rules', describedBy?: string }} where
     */
    line(list, where) {
      if (!list.length) return null;
      const box = el('div', 'knowledge-hints');
      const first = list[0];
      box.appendChild(hintLine(first, where));
      const rest = list.slice(1);
      if (rest.length) {
        const open = unfolded.has(first.ref);
        const more = el('button', 'knowledge-hint__more', open ? t('settings.knowledge.hint.fewer') : t('settings.knowledge.hint.more', { count: rest.length }));
        more.type = 'button';
        more.setAttribute('aria-expanded', String(open));
        const others = el('div', 'knowledge-hints__rest');
        others.hidden = !open;
        for (const hint of rest) others.appendChild(hintLine(hint, where));
        more.addEventListener('click', () => {
          const now = others.hidden;
          others.hidden = !now;
          if (now) unfolded.add(first.ref);
          else unfolded.delete(first.ref);
          more.setAttribute('aria-expanded', String(now));
          more.textContent = now ? t('settings.knowledge.hint.fewer') : t('settings.knowledge.hint.more', { count: rest.length });
        });
        box.firstElementChild?.querySelector('.knowledge-hint__actions')?.appendChild(more);
        box.appendChild(others);
      }
      return box;
    },
  };

  /** @param {'facts'|'rules'} area @param {any} message @param {boolean} [isError] */
  function say(area, message, isError = false) {
    const status = statuses[area];
    status.textContent = typeof message === 'string' ? message : tMessage(message) || '';
    status.classList.toggle('is-error', isError);
  }

  /** What a hint says, in the app's language. */
  function sentenceOf(hint) {
    switch (hint.id) {
      case 'nearlyTheSame':
        return hint.alsoGlobal
          ? t('settings.knowledge.hint.nearlyTheSame.global', { where: hint.withWhere })
          : t('settings.knowledge.hint.nearlyTheSame', { text: clip(hint.with?.text || '', 80), where: hint.withWhere });
      case 'similarTopicNames':
        return t('settings.knowledge.hint.similarTopicNames', { name: hint.with?.name || '' });
      case 'notedAWhileAgo':
        return t('settings.knowledge.hint.notedAWhileAgo', { date: formatDate(hint.date) });
      case 'closeToLimit':
        if (hint.budgetUsedUp) return t('settings.knowledge.hint.closeToLimit.always');
        return t(hint.at.kind === 'memoryFile' ? 'settings.knowledge.hint.closeToLimit.memory' : 'settings.knowledge.hint.closeToLimit.rules',
          { percent: Math.min(999, Math.round((hint.share || 0) * 100)) });
      default:
        return t(`settings.knowledge.hint.${hint.id}`);
    }
  }

  /** @param {any} hint @param {'facts'|'rules'} area @param {string} action @param {Record<string, unknown>} [choice] */
  async function act(hint, area, action, choice = {}) {
    let result;
    try {
      result = await api.knowledgeHintAction(hint.ref, action, choice);
    } catch (error) {
      console.warn('[knowledge] a hint action failed:', error);
      result = null;
    }
    if (!result?.ok) {
      say(area, result?.error ?? { key: 'settings.knowledge.hint.error.write', params: { reason: '' } }, true);
      statuses[area].focus();
      return false;
    }
    if (action === 'edit') return true;
    await self.refreshAll();
    const done = result.done || {};
    say(area, { key: `settings.knowledge.hint.done.${action}`, params: { topic: done.topic, name: done.name, kept: done.kept, removed: done.removed } });
    statuses[area].focus();
    return true;
  }

  /** @param {any} hint @param {'facts'|'rules'} area */
  async function dismiss(hint, area) {
    let result;
    try {
      result = await api.dismissKnowledgeHint(hint.key);
    } catch (error) {
      console.warn('[knowledge] a hint could not be dismissed:', error);
      result = null;
    }
    if (!result?.ok) {
      say(area, result?.error ?? { key: 'settings.knowledge.error.invalid' }, true);
      statuses[area].focus();
      return;
    }
    await self.refreshAll();
    say(area, { key: 'settings.knowledge.hint.done.dismiss' });
    statuses[area].focus();
  }

  /** A small form under the line; Escape and Cancel close it and give the focus back. */
  function inlineForm(container, trigger, build) {
    container.querySelector('.knowledge-hint-form')?.remove();
    const form = el('form', 'knowledge-hint-form');
    const id = `knowledge-hint-form-${(formCount += 1)}`;
    const close = () => {
      form.remove();
      trigger.focus();
    };
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    });
    const actions = el('div', 'knowledge-new__actions');
    build(form, id, actions);
    const cancel = el('button', 'btn-secondary', t('settings.knowledge.new.cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', close);
    actions.appendChild(cancel);
    form.appendChild(actions);
    container.appendChild(form);
    form.querySelector('input, select')?.focus();
    return form;
  }

  /** @param {HTMLElement} form @param {string} id @param {string} label @param {HTMLElement} control */
  function field(form, id, label, control) {
    const caption = el('label', 'modal-field-label', label);
    caption.htmlFor = id;
    control.id = id;
    form.append(caption, control);
  }

  function moveForm(hint, area, container, trigger) {
    inlineForm(container, trigger, (form, id, actions) => {
      const level = el('select', 'modal-input');
      for (const value of ['workspace', 'user']) {
        const option = el('option', null, t(`settings.knowledge.level.${value}`));
        option.value = value;
        option.disabled = value === 'workspace' && !folderOpen;
        level.appendChild(option);
      }
      level.value = hint.at.scope === 'workspace' && folderOpen ? 'workspace' : 'user';
      field(form, `${id}-level`, t('settings.knowledge.hint.form.level'), level);

      const topic = el('input', 'modal-input');
      topic.required = true;
      topic.pattern = '[a-z0-9-]{1,64}';
      topic.placeholder = 'commit-messages';
      topic.autocomplete = 'off';
      const names = el('datalist');
      names.id = `${id}-names`;
      topic.setAttribute('list', names.id);
      field(form, `${id}-topic`, t('settings.knowledge.hint.form.topic'), topic);
      form.appendChild(names);

      const description = el('input', 'modal-input');
      description.maxLength = 200;
      description.placeholder = t('settings.knowledge.new.description.placeholder');
      field(form, `${id}-description`, t('settings.knowledge.new.description'), description);
      const note = el('p', 'knowledge-hint-form__note');
      note.id = `${id}-note`;
      description.setAttribute('aria-describedby', note.id);
      form.appendChild(note);

      const existing = () => (levels.find((item) => item.level === level.value)?.files || []).map((file) => file.name);
      const sync = () => {
        names.replaceChildren(...existing().map((name) => Object.assign(document.createElement('option'), { value: name })));
        const known = existing().includes(topic.value.trim());
        description.required = !known;
        note.textContent = known ? t('settings.knowledge.hint.form.existing', { name: topic.value.trim() }) : t('settings.knowledge.hint.form.newFile');
      };
      level.addEventListener('change', sync);
      topic.addEventListener('input', sync);
      sync();

      const submit = el('button', 'btn-primary', t('settings.knowledge.hint.action.moveToRules.submit'));
      submit.type = 'submit';
      actions.appendChild(submit);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await act(hint, area, 'moveToRules', { level: level.value, topic: topic.value.trim(), description: description.value.trim() });
      });
    });
  }

  function skillForm(hint, area, container, trigger) {
    inlineForm(container, trigger, (form, id, actions) => {
      const name = el('input', 'modal-input');
      name.required = true;
      name.pattern = '[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}';
      name.placeholder = 'release';
      name.autocomplete = 'off';
      field(form, `${id}-name`, t('settings.knowledge.hint.form.skillName'), name);
      const description = el('input', 'modal-input');
      description.required = true;
      description.maxLength = 200;
      description.value = skillDescriptionOf(hint.at.text);
      field(form, `${id}-description`, t('settings.knowledge.hint.form.skillDescription'), description);
      const note = el('p', 'knowledge-hint-form__note', t('settings.knowledge.hint.form.skillWhere', {
        path: hint.at.scope === 'workspace' ? '.agents/skills/' : '~/.snotra/skills/',
      }));
      form.appendChild(note);
      const submit = el('button', 'btn-primary', t('settings.knowledge.hint.action.createSkill.submit'));
      submit.type = 'submit';
      actions.appendChild(submit);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await act(hint, area, 'createSkill', { name: name.value.trim(), description: description.value.trim() });
      });
    });
  }

  function mergeForm(hint, area, container, trigger) {
    inlineForm(container, trigger, (form, id, actions) => {
      const keep = el('select', 'modal-input');
      for (const name of [hint.at.name, hint.with.name]) {
        const option = el('option', null, `${name}.md`);
        option.value = name;
        keep.appendChild(option);
      }
      field(form, `${id}-keep`, t('settings.knowledge.hint.form.keep'), keep);
      const note = el('p', 'knowledge-hint-form__note');
      const sync = () => {
        const other = keep.value === hint.at.name ? hint.with.name : hint.at.name;
        note.textContent = t('settings.knowledge.hint.form.mergeNote', { kept: keep.value, removed: other });
      };
      keep.addEventListener('change', sync);
      sync();
      note.id = `${id}-note`;
      keep.setAttribute('aria-describedby', note.id);
      form.appendChild(note);
      const submit = el('button', 'btn-primary', t('settings.knowledge.hint.action.merge.submit'));
      submit.type = 'submit';
      actions.appendChild(submit);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await act(hint, area, 'merge', { keep: keep.value });
      });
    });
  }

  /**
   * @param {any} hint
   * @param {{ area: 'facts'|'rules', describedBy?: string }} where
   */
  function hintLine(hint, { area, describedBy }) {
    const wrap = el('div', 'knowledge-hint-wrap');
    const line = el('div', 'knowledge-hint');
    line.setAttribute('role', 'group');
    const sentence = sentenceOf(hint);
    line.setAttribute('aria-label', sentence);
    if (describedBy) line.setAttribute('aria-describedby', describedBy);
    const icon = el('span', 'knowledge-hint__icon');
    icon.innerHTML = INFO_ICON;
    line.appendChild(icon);
    line.appendChild(el('span', 'knowledge-hint__text', sentence));
    const actions = el('span', 'knowledge-hint__actions');
    for (const action of hint.actions || []) {
      const button = el('button', 'btn-secondary knowledge-hint__btn', t(`settings.knowledge.hint.action.${action}`));
      button.type = 'button';
      if (action === 'moveToRules') button.addEventListener('click', () => moveForm(hint, area, wrap, button));
      else if (action === 'createSkill') button.addEventListener('click', () => skillForm(hint, area, wrap, button));
      else if (action === 'merge') button.addEventListener('click', () => mergeForm(hint, area, wrap, button));
      else button.addEventListener('click', () => act(hint, area, action));
      actions.appendChild(button);
    }
    // *Distil…* (#1316) goes here for an episode, once a chat can be distilled.
    if (hint.dismissible) {
      const dismissButton = el('button', 'knowledge-hint__dismiss', t('settings.knowledge.hint.dismiss'));
      dismissButton.type = 'button';
      dismissButton.addEventListener('click', () => dismiss(hint, area));
      actions.appendChild(dismissButton);
    }
    line.appendChild(actions);
    wrap.appendChild(line);
    return wrap;
  }

  return self;
}
