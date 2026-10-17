import { dismissOnFocusLeave, dismissOnOutsideClick, followColumn, keepPopupInColumn } from '../utils/helpers.js';
import {
  activeEntrySendsTools,
  describeConfigLinks,
  describeConfigPill,
  describeNoTools,
  describeSkillRows,
  describeToolSections,
  invokedSkillNames,
} from '../utils/chat-config-view.js';
import { APP_LOCALES, onLocaleChange, t } from '../i18n.js';

const CHEVRON_HTML =
  '<svg class="chat-config-chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path fill="currentColor" d="M0 0l5 6 5-6z"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** The state dot. Shape and fill carry it, the words next to it say it. */
function mark(on) {
  const dot = el('span', `chat-config-mark${on ? ' chat-config-mark--on' : ''}`);
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

/**
 * Skills and tools of the open chat, at the composer (#773).
 *
 * A pill next to the model and mode pills counts the skills that are on;
 * its popover lists every skill with its state and source, the tools that are
 * missing with the reason and the way to the setting, and the tools that are
 * on summed up by group. It only shows — switching stays in the settings, so
 * every row that can be changed leads there.
 *
 * `onOpenSettings({ panel, target })` opens the settings on a page and, when
 * given, the heading of the section that changes it.
 */
export function initChatConfigIndicator({ api, appStore, onOpenSettings }) {
  const wrap = document.getElementById('chat-config-wrap');
  const btn = document.getElementById('btn-chat-config');
  const label = document.getElementById('chat-config-label');
  const popup = document.getElementById('chat-config-popup');
  const noop = { refresh: async () => {}, close() {}, isOpen: () => false };
  if (!wrap || !btn || !label || !popup || typeof api?.getChatConfiguration !== 'function') return noop;

  let open = false;
  let config = null;
  let failed = false;
  let generation = 0;
  // True while the popover is rebuilt: its focused node goes away for a moment.
  let rebuilding = false;
  // Expanded stays expanded across a refresh and a reopening.
  let toolsExpanded = false;

  async function refresh() {
    const mine = ++generation;
    let next = null;
    let error = false;
    try {
      next = await api.getChatConfiguration({ invokedSkills: invokedSkillNames(appStore.chatMessages) });
    } catch {
      error = true;
    }
    // A newer request has the newer answer; this one is dropped.
    if (mine !== generation) return;
    if (error) {
      failed = true;
    } else {
      failed = false;
      config = next && typeof next === 'object' ? next : null;
    }
    render();
  }

  function renderPill() {
    if (!config) {
      // Nothing to count yet: the pill waits rather than claim "No skills".
      // After a failed read it stays reachable, named without a number, and
      // the popover says what went wrong.
      wrap.classList.toggle('hidden', !failed);
      label.textContent = failed ? t('chat.config.pill.unknown') : '';
      if (failed) {
        btn.title = t('chat.config.button.title', { pill: label.textContent });
        btn.setAttribute('aria-label', t('chat.config.button.label', { pill: label.textContent }));
      }
      return;
    }
    const pill = describeConfigPill(config, { sendsTools: sendsTools() });
    wrap.classList.remove('hidden');
    if (pill.noTools) wrap.dataset.noTools = 'true';
    else delete wrap.dataset.noTools;
    label.textContent = pill.label;
    btn.title = pill.title;
    btn.setAttribute('aria-label', pill.ariaLabel);
  }

  function sectionHead(id, text, count) {
    const head = el('h2', 'chat-model-menu-head chat-config-head');
    head.id = id;
    head.append(el('span', null, text));
    if (count) head.append(el('span', 'chat-config-count', count));
    return head;
  }

  function buildSkills() {
    const view = describeSkillRows(config);
    const section = el('section', 'chat-config-section');
    section.setAttribute('aria-labelledby', 'chat-config-skills-heading');
    section.append(sectionHead('chat-config-skills-heading', t('chat.config.skills.heading'), view.total ? view.count : ''));
    if (view.empty) section.append(el('p', 'chat-config-empty', view.empty));
    if (view.rows.length) {
      const list = el('ul', 'chat-config-list');
      for (const row of view.rows) {
        const item = el('li', `chat-config-row chat-config-row--skill${row.on ? '' : ' chat-config-row--off'}`);
        if (row.description) item.title = row.description;
        item.append(mark(row.on));
        const main = el('span', 'chat-config-row-main');
        const name = el('span', 'chat-config-name', row.name);
        name.lang = APP_LOCALES.EN;
        main.append(name);
        if (row.chatOnly) {
          const tag = el('span', 'chat-config-tag', t('chat.config.chatOnly'));
          tag.title = row.chatOnlyTitle;
          main.append(tag);
        }
        // "on" is read out but not shown — the filled dot says it.
        main.append(el('span', row.on ? 'sr-only' : 'chat-config-state', row.stateLabel));
        if (row.source) {
          const source = el('span', 'chat-config-src', row.source);
          source.title = row.source;
          main.append(source);
        }
        item.append(main);
        list.append(item);
      }
      section.append(list);
    }
    return section;
  }

  /** The active entry's switch, read off the model state on every render (#1013). */
  function sendsTools() {
    return activeEntrySendsTools(appStore.llmState);
  }

  function buildTools() {
    if (!sendsTools()) return buildNoTools();
    const view = describeToolSections(config);
    const section = el('section', 'chat-config-section');
    section.setAttribute('aria-labelledby', 'chat-config-tools-heading');
    section.append(sectionHead('chat-config-tools-heading', t('chat.config.tools.heading'), view.total ? view.count : ''));
    const list = el('ul', 'chat-config-list');
    for (const tool of view.changed) {
      const item = el('li', `chat-config-row chat-config-row--tool${tool.on ? '' : ' chat-config-row--off'}`);
      item.append(mark(tool.on));
      const main = el('span', 'chat-config-row-main');
      const name = el('span', 'chat-config-name', tool.name);
      name.lang = APP_LOCALES.EN;
      const tag = el('span', 'chat-config-tag', tool.tag);
      tag.title = tool.tagTitle;
      main.append(name, tag, el('span', 'chat-config-sub', tool.reason));
      item.append(main);
      list.append(item);
    }
    for (const tool of view.missing) {
      const item = el('li', 'chat-config-row chat-config-row--tool chat-config-row--off');
      item.append(mark(false));
      const main = el('span', 'chat-config-row-main');
      const name = el('span', 'chat-config-name', tool.name);
      name.lang = APP_LOCALES.EN;
      main.append(name, el('span', 'chat-config-sub', tool.reason));
      item.append(main);
      if (tool.action) {
        const action = el('button', 'chat-config-action', tool.action.label);
        action.type = 'button';
        action.setAttribute('aria-label', tool.action.ariaLabel);
        action.dataset.panel = tool.action.panel;
        if (tool.action.target) action.dataset.target = tool.action.target;
        item.append(action);
      }
      list.append(item);
    }
    if (view.noFolder) {
      const item = el('li', 'chat-config-row chat-config-row--tool chat-config-row--off');
      item.append(mark(false), el('span', 'chat-config-row-main chat-config-sub', view.noFolder));
      list.append(item);
    }
    if (list.children.length) section.append(list);

    if (view.groups.length) {
      const toggle = el('button', 'chat-config-summary');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', toolsExpanded ? 'true' : 'false');
      toggle.setAttribute('aria-controls', 'chat-config-groups');
      toggle.append(mark(true), el('span', 'chat-config-summary-label', view.onSummary));
      toggle.insertAdjacentHTML('beforeend', CHEVRON_HTML);
      const groups = el('ul', 'chat-config-groups');
      groups.id = 'chat-config-groups';
      groups.hidden = !toolsExpanded;
      for (const group of view.groups) {
        const item = el('li', 'chat-config-group');
        const names = el('span', 'chat-config-group-tools', group.names.join(', '));
        names.lang = APP_LOCALES.EN;
        item.append(el('span', 'chat-config-group-name', group.label), names);
        groups.append(item);
      }
      section.append(toggle, groups);
    }
    return section;
  }

  /**
   * A model that gets no tools: no list of what is switched on — none of it
   * reaches the model — but the reason and the way to the switch.
   */
  function buildNoTools() {
    const view = describeNoTools();
    const section = el('section', 'chat-config-section');
    section.setAttribute('aria-labelledby', 'chat-config-tools-heading');
    section.append(sectionHead('chat-config-tools-heading', t('chat.config.tools.heading'), ''));
    const note = el('div', 'chat-config-notools');
    note.append(el('p', 'chat-config-notools-text', view.text));
    const link = el('button', 'chat-config-link', view.link.label);
    link.type = 'button';
    link.dataset.panel = view.link.panel;
    note.append(link);
    section.append(note);
    return section;
  }

  function buildFooter() {
    const links = describeConfigLinks();
    const footer = el('div', 'chat-config-footer');
    for (const link of Object.values(links)) {
      const button = el('button', 'chat-config-link');
      button.type = 'button';
      button.dataset.panel = link.panel;
      button.textContent = t(link.key, { place: link.place });
      footer.append(button);
    }
    return footer;
  }

  /** What has the focus inside the popover, in a form that survives a rebuild. */
  function focusedSpot() {
    const active = document.activeElement;
    if (!active || !popup.contains(active)) return null;
    if (active === popup) return 'popup';
    const all = [...popup.querySelectorAll('button')];
    const index = all.indexOf(active);
    return index === -1 ? 'popup' : index;
  }

  function buildPopup() {
    const spot = focusedSpot();
    rebuilding = true;
    try {
      popup.textContent = '';
      if (!config) {
        popup.append(el('p', 'chat-config-empty', failed ? t('chat.config.loadFailed') : ''));
        return;
      }
      popup.append(buildSkills(), buildTools(), buildFooter());
    } finally {
      rebuilding = false;
    }
    if (spot === null) return;
    const target = spot === 'popup' ? popup : popup.querySelectorAll('button')[spot] || popup;
    target.focus();
  }

  function render() {
    renderPill();
    if (open) {
      buildPopup();
      keepPopupInColumn(popup, wrap);
    }
  }

  function close() {
    if (!open) return;
    open = false;
    popup.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  function show() {
    open = true;
    popup.setAttribute('aria-label', t('chat.config.dialog'));
    buildPopup();
    popup.classList.remove('hidden');
    keepPopupInColumn(popup, wrap);
    btn.setAttribute('aria-expanded', 'true');
    popup.focus();
    // What it shows is read again on every opening: a skill switched on in
    // another window, a key added — the pill may be a step behind.
    void refresh();
  }

  function goToSettings(panel, target) {
    close();
    btn.focus();
    onOpenSettings?.({ panel, target: target || null });
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) close();
    else show();
  });

  popup.addEventListener('click', (e) => {
    const toggle = e.target.closest('.chat-config-summary');
    if (toggle) {
      toolsExpanded = !toolsExpanded;
      toggle.setAttribute('aria-expanded', toolsExpanded ? 'true' : 'false');
      const groups = popup.querySelector('#chat-config-groups');
      if (groups) groups.hidden = !toolsExpanded;
      return;
    }
    const link = e.target.closest('.chat-config-action, .chat-config-link');
    if (link?.dataset.panel) goToSettings(link.dataset.panel, link.dataset.target);
  });

  popup.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...popup.querySelectorAll('button')];
    if (items.length === 0) return;
    e.preventDefault();
    const index = items.indexOf(document.activeElement);
    let next;
    if (index === -1) next = e.key === 'ArrowDown' ? items[0] : items[items.length - 1];
    else if (e.key === 'ArrowDown') next = items[(index + 1) % items.length];
    else next = items[(index - 1 + items.length) % items.length];
    next.focus();
  });

  dismissOnOutsideClick({
    isOpen: () => open,
    ownsTarget: (target) => !!target?.closest?.('#chat-config-wrap'),
    onDismiss: close,
  });
  followColumn(popup, wrap, () => open);
  dismissOnFocusLeave({
    container: wrap,
    isOpen: () => open,
    isPaused: () => rebuilding,
    onDismiss: close,
  });
  // Built at runtime, so a language change redraws it (#290); the system
  // skills' descriptions follow the language too, hence the new read.
  onLocaleChange(() => {
    render();
    void refresh();
  });

  // `redraw`: the model changed (#1013) — what the pill says depends on it,
  // and nothing has to be read from main for that.
  return { refresh, redraw: render, close, isOpen: () => open };
}
