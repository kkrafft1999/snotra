import { buildApprovalCardView, describeApprovalOutcome } from '../utils/tool-approval-view.js';
import { buildSandboxCardView, describeSandboxOutcome } from '../utils/sandbox-approval-view.js';
import contracts from '../generated/contracts.js';
import { createToolApprovalQueue, APPROVAL_ENTRY_STATES } from '../utils/tool-approval-queue.js';
import { onLocaleChange, t, tMessage } from '../i18n.js';
import { isCancelledResult } from '../state/tool-permissions.js';

const { APPROVAL_RESPONSES } = contracts;

/**
 * Bestätigungskarte im Chat (Issue #67, Konzept §4/§6).
 *
 * Der Main-Prozess schickt nach `subscribeToolApprovals()` je Rückfrage ein
 * validiertes DTO; die Karte zeigt es als Daten (Pfade, Vorschau, Grund) und
 * meldet genau eine Entscheidung zurück. Sie trifft keine Rechteentscheidung
 * und kennt keine Argumente – ausgeführt wird der Plan des Main, nicht der
 * Text der Karte.
 *
 * Verhalten (Konzept §6): kein Zeitlimit, kein initialer Fokus auf Erlauben,
 * kein globaler Enter-Shortcut; Esc lehnt die älteste offene Anfrage ab,
 * sofern kein Menü oder Dialog offen ist. Fokus- und Fensterwechsel bestätigen
 * nichts. Verfall durch den Main (Abbruch, Kontext-/Regelwechsel) macht die
 * Aktionen unwirksam und zeigt den Grund; verspätete oder doppelte Antworten
 * werden lokal abgefangen und vom Main ohnehin verworfen.
 */
export function initToolApprovalCards({
  api,
  appStore,
  onPendingChanged = () => {},
  onOpenSandboxSettings = null,
  // Program allowances (#408): home folder for `~` paths, the way to the list.
  getHomeDir = () => '',
  onOpenAllowanceSettings = null,
}) {
  const chatMessagesEl = document.getElementById('chat-messages');
  const queue = createToolApprovalQueue();
  const readHomeDir = () => {
    try {
      return getHomeDir() || '';
    } catch {
      return '';
    }
  };
  /** requestId → Karten-Element des laufenden Zuges. */
  const cards = new Map();
  /**
   * Chat → the message its cards belong to (a store object, so it survives a
   * rebuild of the list). One per chat since #320: a run in the background
   * collects its cards until its chat is on screen again.
   */
  const owners = new Map();

  /** The chat a request belongs to — fixed when it arrives (`onRequest`). */
  function chatOf(entry) {
    return entry?.chatId ?? (entry?.dto?.chatId || null);
  }

  function isOnScreen(entry) {
    return chatOf(entry) === (appStore.currentChatId || null);
  }

  /** Which chats have a card waiting for an answer — for the history column. */
  function pendingChatIds() {
    return new Set(queue.pending().map(chatOf));
  }

  let lastPendingSignature = '';
  function notifyPendingChanged() {
    const signature = [...pendingChatIds()].sort().join('\n');
    if (signature === lastPendingSignature) return;
    lastPendingSignature = signature;
    try {
      onPendingChanged();
    } catch {
      /* the history column is a view; it must not break the card */
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function code(text, lang) {
    const node = el('code', 'chat-approval-card__code', text);
    if (lang) node.lang = lang;
    return node;
  }

  function domId(requestId, suffix) {
    return `approval-${String(requestId).replace(/[^a-zA-Z0-9_-]/g, '')}-${suffix}`;
  }

  /** Der Lauf wurde lokal abgebrochen (Stopp-Taste) – dann heißt Verfall „abgebrochen“. */
  function runAborted(entry) {
    return appStore.chatRuns?.get(chatOf(entry))?.aborted === true;
  }

  function ensureContainer(bubble) {
    if (!bubble) return null;
    let box = bubble.querySelector('.chat-approval-cards');
    if (!box) {
      box = el('div', 'chat-approval-cards');
      const anchor = bubble.querySelector('.chat-md-streaming, .chat-md');
      if (anchor) bubble.insertBefore(box, anchor);
      else bubble.appendChild(box);
    }
    return box;
  }

  function currentContainer() {
    const bubble = chatMessagesEl?.querySelector('.chat-msg.assistant:last-of-type');
    return ensureContainer(bubble);
  }

  /** The domains an isolated run may reach, one code chip each (#329). */
  function buildDomainList(isolation) {
    if (isolation.domains.length === 0) return isolation.networkNone;
    const list = el('span', 'chat-approval-card__domains');
    for (const domain of isolation.domains) list.appendChild(code(domain, 'en'));
    return list;
  }

  function fact(dl, term, valueNode) {
    const row = el('div', 'chat-approval-card__fact');
    row.appendChild(el('dt', null, term));
    const dd = el('dd');
    if (typeof valueNode === 'string') dd.textContent = valueNode;
    else dd.appendChild(valueNode);
    row.appendChild(dd);
    dl.appendChild(row);
  }

  function buildTargetList(view) {
    const list = el('ul', 'chat-approval-card__targets');
    for (const target of view.targets) {
      const li = el('li');
      li.appendChild(el('span', 'chat-approval-card__target-kind', target.kindLabel));
      li.appendChild(code(target.path || t('approval.target.noPath')));
      if (target.sensitive) {
        const badge = el('span', 'chat-approval-card__badge', t('approval.badge.sensitive'));
        badge.title = t('approval.badge.sensitive.title');
        li.appendChild(badge);
      }
      // The sensitivity already has its own badge; the note would repeat it.
      const sensitiveNote = t('approval.note.sensitive');
      const notes = target.notes.filter((n) => !n.startsWith(sensitiveNote));
      if (notes.length > 0) li.appendChild(el('span', 'chat-approval-card__target-note', notes.join(' · ')));
      list.appendChild(li);
    }
    if (view.targets.length === 0) {
      list.appendChild(el('li', 'chat-approval-card__target-note', t('approval.target.none')));
    }
    return list;
  }

  function buildPreview(view) {
    const preview = view.preview;
    if (!preview) return null;
    const details = el('details', 'chat-approval-card__preview');
    // Open from the start: the preview is what is being approved — the
    // command, the source, the change. Having to unfold it first invites
    // approving without reading, and since "always allow this command"
    // (#121) that costs more than one call. Long previews stay height-limited.
    details.open = true;
    const summary = el('summary', null, preview.summary);
    details.appendChild(summary);
    const notes = [preview.truncatedNote, preview.maskedNote].filter(Boolean);
    if (notes.length > 0) details.appendChild(el('p', 'chat-approval-card__preview-note', notes.join(' ')));
    const pre = el('pre', 'chat-approval-card__preview-text chat-approval-card__preview-text--clamped');
    pre.dataset.kind = preview.kind;
    pre.textContent = preview.text;
    details.appendChild(pre);
    // Standard input and arguments below the source (#551), each under its
    // own label and limited in height like the source.
    const pres = [pre];
    for (const block of preview.blocks || []) {
      details.appendChild(el('p', 'chat-approval-card__preview-label', block.label));
      const blockPre = el('pre', 'chat-approval-card__preview-text chat-approval-card__preview-text--clamped');
      blockPre.dataset.kind = block.id;
      blockPre.setAttribute('aria-label', block.label);
      blockPre.textContent = block.text;
      details.appendChild(blockPre);
      pres.push(blockPre);
    }
    // Long previews are height-limited at first; "show in full" lifts the
    // limit. The text stays the same — masked stays masked.
    const expand = el('button', 'chat-approval-card__preview-toggle', t('approval.preview.expand'));
    expand.type = 'button';
    expand.setAttribute('aria-expanded', 'false');
    expand.addEventListener('click', () => {
      const clamped = !pre.classList.contains('chat-approval-card__preview-text--clamped');
      for (const item of pres) item.classList.toggle('chat-approval-card__preview-text--clamped', clamped);
      expand.textContent = clamped ? t('approval.preview.expand') : t('approval.preview.collapse');
      expand.setAttribute('aria-expanded', clamped ? 'false' : 'true');
    });
    details.appendChild(expand);
    // With the preview open from the start, "show in full" under a one-line
    // command would be noise: it only appears when the text really runs past
    // the limit. Measured, not guessed — wrapping depends on the width, and a
    // card for a chat in the background is laid out only once it is mounted,
    // which is when the observer first reports. Once expanded, the button
    // stays, so the preview can be folded back.
    if (typeof ResizeObserver === 'function') {
      const syncToggle = () => {
        if (!pre.classList.contains('chat-approval-card__preview-text--clamped')) return;
        expand.hidden = pres.every((item) => item.scrollHeight <= item.clientHeight + 1);
      };
      const observer = new ResizeObserver(syncToggle);
      for (const item of pres) observer.observe(item);
      observer.observe(details);
    }
    return details;
  }

  function buildActions(view, requestId) {
    const actions = el('div', 'chat-approval-card__actions');
    const hintId = domId(requestId, 'session-hint');
    for (const key of view.actionOrder) {
      const action = view.actions[key];
      const button = el('button', key === 'once' ? 'btn-primary' : 'btn-secondary', action.label);
      button.type = 'button';
      button.dataset.response = action.response;
      button.disabled = !action.enabled;
      // The middle button — "for this session", or "always" on a command
      // card (#121) — carries the hint below the buttons.
      if ((key === 'session' || key === 'always') && action.hint) {
        button.setAttribute('aria-describedby', hintId);
        button.title = action.hint;
      }
      actions.appendChild(button);
    }
    return { actions, hintId };
  }

  /**
   * The headline as a sentence with two slots. `template` still carries
   * `{target}` and `{tool}` so that the path and the tool name can be rendered
   * as code — wherever the language puts them (#290). The order is the
   * catalogue's business, not this component's.
   */
  function appendHeadline(node, headline) {
    const slots = {
      '{target}': () => code(headline.targetLabel),
      '{tool}': () => code(headline.tool || t('tools.line.generic.fallbackName'), 'en'),
    };
    for (const part of headline.template.split(/(\{target\}|\{tool\})/)) {
      if (!part) continue;
      const slot = slots[part];
      if (slot) node.appendChild(slot());
      else node.append(part);
    }
  }

  /** The view of a card: the sandbox card (#792), or the card before a call or for its output. */
  function viewOf(dto) {
    const homeDir = readHomeDir();
    return buildSandboxCardView(dto, { homeDir }) || buildApprovalCardView(dto, { homeDir });
  }

  /** One group of radio rows; the first option is chosen. */
  function radioGroup(requestId, name, legend, options) {
    const fieldset = el('fieldset', 'chat-approval-card__choice');
    fieldset.appendChild(el('legend', 'chat-approval-card__choice-legend', legend));
    options.forEach((option, i) => {
      const label = el('label', 'chat-approval-card__option');
      const input = el('input');
      input.type = 'radio';
      input.name = domId(requestId, name);
      input.value = option.value;
      input.checked = i === 0;
      label.appendChild(input);
      const text = el('span', 'chat-approval-card__option-text');
      if (option.code) text.appendChild(code(option.label));
      else text.append(option.label);
      if (option.hint) text.appendChild(el('span', 'chat-approval-card__option-hint', option.hint));
      label.appendChild(text);
      fieldset.appendChild(label);
    });
    return fieldset;
  }

  /**
   * The sandbox card (#792): what the run was refused, how it went, what it
   * reported; which path to open — exactly the blocked one or one folder up
   * — and for how long. "Allow and run again" answers once or for the
   * session, as the duration says; Esc denies, like on every card.
   */
  function buildSandboxCard(entry, view) {
    const requestId = entry.dto.requestId;
    const card = el('section', 'chat-approval-card chat-approval-card--sandbox');
    card.dataset.requestId = requestId;
    card.dataset.state = 'pending';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-labelledby', domId(requestId, 'title'));
    card.setAttribute('aria-describedby', `${domId(requestId, 'badge')} ${domId(requestId, 'headline')}`);
    card.tabIndex = -1;

    const row = el('div', 'chat-approval-card__title-row');
    const title = el('h3', 'chat-approval-card__title', view.title);
    title.id = domId(requestId, 'title');
    const badge = el('span', 'chat-approval-card__badge', view.badge);
    badge.id = domId(requestId, 'badge');
    row.append(title, badge);
    card.appendChild(row);

    const headline = el('p', 'chat-approval-card__headline');
    headline.id = domId(requestId, 'headline');
    for (const part of view.headline.template.split(/(\{command\})/)) {
      if (part === '{command}') headline.appendChild(code(view.headline.command));
      else if (part) headline.append(part);
    }
    card.appendChild(headline);

    const facts = el('dl', 'chat-approval-card__facts');
    const blocked = el('ul', 'chat-approval-card__blocked');
    for (const item of view.entries) {
      const li = el('li');
      li.appendChild(el('span', 'chat-approval-card__blocked-kind', item.kindLabel));
      const target = code(item.target);
      if (item.title !== item.target) target.title = item.title;
      li.appendChild(target);
      if (item.detail) li.appendChild(el('span', 'chat-approval-card__blocked-detail', item.detail));
      blocked.appendChild(li);
    }
    fact(facts, t('approval.sandbox.fact.blocked'), blocked);
    if (view.others.length) {
      const others = el('ul', 'chat-approval-card__blocked');
      for (const other of view.others) {
        const li = el('li');
        li.appendChild(el('span', 'chat-approval-card__blocked-kind', other.kindLabel));
        li.appendChild(code(other.target));
        li.appendChild(el('span', 'chat-approval-card__blocked-detail', t('approval.sandbox.others.note')));
        others.appendChild(li);
      }
      fact(facts, t('approval.sandbox.fact.others'), others);
    }
    if (view.command) fact(facts, t('approval.sandbox.fact.command'), code(view.command));
    fact(facts, t('approval.sandbox.fact.run'), view.run);
    fact(facts, t('approval.fact.reason'), view.reason);
    card.appendChild(facts);

    const output = el('details', 'chat-approval-card__preview chat-approval-card__report');
    output.open = true;
    output.appendChild(el('summary', null, t('approval.sandbox.output')));
    // A report that scrolls takes the keyboard too.
    const scrolling = (text) => {
      const pre = el('pre', 'chat-approval-card__preview-text', text);
      pre.tabIndex = 0;
      return pre;
    };
    output.appendChild(view.output
      ? scrolling(view.output)
      : el('p', 'chat-approval-card__report-empty', t('approval.sandbox.output.empty')));
    card.appendChild(output);
    if (view.raw) {
      const raw = el('details', 'chat-approval-card__preview chat-approval-card__report');
      raw.appendChild(el('summary', null, t('toolLog.sandbox.raw')));
      raw.appendChild(scrolling(view.raw));
      card.appendChild(raw);
    }

    view.entries.forEach((item, i) => {
      if (item.options.length < 2) return;
      // The path in the legend only tells several resources apart; for one,
      // it stands right below as the first option.
      const legend = view.entries.length > 1 ? `${item.legend} ${item.target}` : item.legend;
      card.appendChild(radioGroup(requestId, `scope-${i}`, legend, item.options.map((option) => ({ ...option, code: true }))));
    });
    if (view.durations.length) card.appendChild(radioGroup(requestId, 'duration', t('approval.sandbox.duration.legend'), view.durations));

    card.appendChild(el('p', 'chat-approval-card__warning', view.warning));

    const { actions } = buildActions(view, requestId);
    card.appendChild(actions);
    const status = el('p', 'chat-approval-card__status', t('approval.status.waiting'));
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    card.appendChild(status);

    actions.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-response]');
      if (!button || button.disabled) return;
      if (button.dataset.response === APPROVAL_RESPONSES.DENY) {
        void respond(requestId, APPROVAL_RESPONSES.DENY);
        return;
      }
      const chosen = (name) => card.querySelector(`input[name="${domId(requestId, name)}"]:checked`)?.value;
      const sandboxPaths = view.entries.map((item, i) => chosen(`scope-${i}`) || item.options[0].value);
      const session = chosen('duration') === 'session';
      void respond(requestId, session ? APPROVAL_RESPONSES.ALLOW_SESSION : button.dataset.response, { sandboxPaths });
    });
    return card;
  }

  function buildCard(entry, view) {
    if (view.kind === 'sandbox') return buildSandboxCard(entry, view);
    const requestId = entry.dto.requestId;
    const card = el('section', 'chat-approval-card');
    card.dataset.requestId = requestId;
    card.dataset.state = 'pending';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-labelledby', domId(requestId, 'title'));
    card.setAttribute('aria-describedby', domId(requestId, 'headline'));
    card.tabIndex = -1;

    const title = el('h3', 'chat-approval-card__title', view.title);
    title.id = domId(requestId, 'title');
    if (view.isolation) {
      // Isolation sits next to the title (#329): the first thing read, and in
      // the warning amber when the run would not be isolated (#396).
      const row = el('div', 'chat-approval-card__title-row');
      row.appendChild(title);
      const badge = el(
        'span',
        view.isolation.isolated
          ? 'chat-approval-card__badge'
          : 'chat-approval-card__badge chat-approval-card__badge--warning',
        view.isolation.badge,
      );
      badge.id = domId(requestId, 'isolation');
      row.appendChild(badge);
      card.appendChild(row);
      card.setAttribute('aria-describedby', `${domId(requestId, 'isolation')} ${domId(requestId, 'headline')}`);
    } else {
      card.appendChild(title);
    }

    const headline = el('p', 'chat-approval-card__headline');
    headline.id = domId(requestId, 'headline');
    appendHeadline(headline, view.headline);
    card.appendChild(headline);

    const facts = el('dl', 'chat-approval-card__facts');
    fact(facts, t('approval.fact.effect'), view.classText);
    if (view.shellLabel) fact(facts, t('approval.fact.shell'), view.shellLabel);
    if (view.cwdLabel) fact(facts, t('approval.fact.cwd'), code(view.cwdLabel));
    if (view.isolation?.isolated) fact(facts, t('approval.fact.network'), buildDomainList(view.isolation));
    // The memory has no file target the user could influence (issue #166) —
    // the reach is the decision here, not the path.
    if (view.memoryScopeLabel) fact(facts, t('approval.fact.memoryScope'), view.memoryScopeLabel);
    // A shell command has no file target — the line "no file target" would be
    // noise next to the shell and the working folder (issue #102); the same
    // holds for remembering, next to the reach.
    if ((!view.shellLabel && !view.memoryScopeLabel) || view.targets.length > 0) {
      fact(facts, t(view.targets.length === 1 ? 'approval.fact.target' : 'approval.fact.targets'), buildTargetList(view));
    }
    if (view.reason) fact(facts, t('approval.fact.reason'), view.reason);
    if (view.sensitive && view.providerLabel) fact(facts, t('approval.fact.recipient'), view.providerLabel);
    if (view.scopeNote) fact(facts, t('approval.fact.sessionScope'), view.scopeNote);
    fact(facts, t('approval.fact.mode'), view.modeLabel);
    card.appendChild(facts);

    if (view.isolation?.isolated) card.appendChild(el('p', 'chat-approval-card__note', view.isolation.note));

    // A program allowance (#408): what the run gets on top, or why the
    // allowance for its program stays off — with the way to the list.
    const allowance = view.isolation?.allowance;
    if (allowance) {
      const box = el('p', 'chat-approval-card__allowance');
      if (allowance.prefix) {
        box.appendChild(el('strong', null, allowance.prefix));
        box.append(' ');
      }
      box.append(allowance.text);
      if (typeof onOpenAllowanceSettings === 'function') {
        box.append(' ');
        const link = el('button', 'chat-approval-card__warning-link', allowance.settingsLabel);
        link.type = 'button';
        link.addEventListener('click', () => onOpenAllowanceSettings());
        box.appendChild(link);
      }
      card.appendChild(box);
    }

    if (view.warning) {
      const warning = el('p', 'chat-approval-card__warning');
      warning.appendChild(el('strong', null, t('approval.warning.prefix')));
      warning.append(view.warning);
      // The user switched the sandbox off for this folder (#357): the way
      // back sits right where the card says so.
      if (view.isolation?.switchedOff && typeof onOpenSandboxSettings === 'function') {
        warning.append(' ');
        const link = el('button', 'chat-approval-card__warning-link', view.isolation.settingsLabel);
        link.type = 'button';
        link.addEventListener('click', () => onOpenSandboxSettings());
        warning.appendChild(link);
      }
      card.appendChild(warning);
    }

    // Invisible characters in what the model chose (CR-B13-01): marked where
    // they sit, and said once here, above the preview most of them are in.
    if (view.invisibleWarning) {
      const note = el('p', 'chat-approval-card__warning chat-approval-card__warning--invisible');
      note.appendChild(el('strong', null, t('approval.warning.prefix')));
      note.append(view.invisibleWarning);
      card.appendChild(note);
    }

    const preview = buildPreview(view);
    if (preview) card.appendChild(preview);

    const { actions, hintId } = buildActions(view, requestId);
    card.appendChild(actions);
    const middleHint = view.actions[view.actionOrder[1]]?.hint;
    if (middleHint) {
      const hint = el('p', 'chat-approval-card__hint', middleHint);
      hint.id = hintId;
      card.appendChild(hint);
    }

    const status = el('p', 'chat-approval-card__status', t('approval.status.waiting'));
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    card.appendChild(status);

    actions.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-response]');
      if (!button || button.disabled) return;
      void respond(requestId, button.dataset.response);
    });
    return card;
  }

  function setStatus(card, text) {
    const status = card?.querySelector('.chat-approval-card__status');
    if (status && status.textContent !== text) status.textContent = text;
  }

  function setButtonsEnabled(card, view, enabled) {
    for (const button of card.querySelectorAll('.chat-approval-card__actions button')) {
      const action = Object.values(view.actions).find((entry) => entry.response === button.dataset.response);
      button.disabled = !enabled || !action?.enabled;
    }
  }

  /** Auflösung anzeigen: keine aktive Aktion bleibt zurück (Konzept §6). */
  function applyOutcome(card, entry) {
    const resolved = { ...(entry.outcome || {}), aborted: entry.aborted === true && entry.outcome?.invalidated === true };
    const outcome = (entry.dto?.checkpoint === 'sandbox' && describeSandboxOutcome(resolved)) || describeApprovalOutcome(resolved);
    // What the sandbox card offered to choose stays visible, but fixed.
    for (const fieldset of card.querySelectorAll('.chat-approval-card__choice')) fieldset.disabled = true;
    card.dataset.state = outcome.status;
    const actions = card.querySelector('.chat-approval-card__actions');
    if (actions) {
      for (const button of actions.querySelectorAll('button')) button.disabled = true;
      actions.hidden = true;
    }
    const hint = card.querySelector('.chat-approval-card__hint');
    if (hint) hint.hidden = true;
    const result = el('p', 'chat-approval-card__result');
    result.appendChild(el('strong', null, outcome.label));
    if (outcome.detail) result.append(` ${outcome.detail}`);
    card.querySelector('.chat-approval-card__result')?.remove();
    card.insertBefore(result, card.querySelector('.chat-approval-card__status'));
    setStatus(card, t('approval.status.resolved', { label: outcome.label }));
  }

  async function respond(requestId, response, extra) {
    if (!queue.beginResponse(requestId, response)) return;
    const card = cards.get(requestId);
    const entry = queue.get(requestId);
    const view = card?.__approvalView;
    // The buttons are about to be disabled and then hidden, and a disabled
    // button loses the focus to the top of the window. The card takes it —
    // it has tabindex -1 for this — and its status line says what happens
    // (CR-B13-03).
    const hadFocus = !!card?.contains(document.activeElement);
    if (hadFocus) card.focus({ preventScroll: true });
    if (card && view) {
      setButtonsEnabled(card, view, false);
      setStatus(card, t('approval.status.sending'));
    }
    let result;
    try {
      result = typeof api.respondToolApproval === 'function'
        ? await api.respondToolApproval(requestId, response, extra)
        : { ok: false, error: t('approval.error.unavailable') };
    } catch (error) {
      result = { ok: false, error: error?.message || t('approval.error.unknown') };
    }
    if (result?.ok) return; // Auflösung kommt per Push vom Main.
    if (entry?.state === APPROVAL_ENTRY_STATES.RESOLVED) return; // inzwischen verfallen
    queue.failResponse(requestId);
    // The card may have been rebuilt meanwhile (a language change).
    const current = cards.get(requestId);
    const currentView = current?.__approvalView;
    if (current && currentView) {
      setButtonsEnabled(current, currentView, true);
      // A cancelled native dialog ("always", #121) is the user's own answer:
      // the card stays open and says nothing went wrong (CR-B13-06).
      setStatus(current, isCancelledResult(result)
        ? t('approval.status.waiting')
        : t('approval.error.rejected', { error: tMessage(result?.error) || t('approval.error.unknown.short') }));
      // Back to the button that was pressed, if the focus is still on the card.
      if (hadFocus && (document.activeElement === current || document.activeElement === document.body)) {
        current.querySelector(`.chat-approval-card__actions button[data-response="${response}"]`)?.focus();
      }
    }
  }

  function onRequest(dto) {
    const entry = queue.add(dto);
    if (!entry) return;
    // A request without a chat comes from a main that predates #320; it can
    // only mean the chat on screen.
    entry.chatId = dto.chatId || appStore.currentChatId || null;
    const view = viewOf(dto);
    if (!view) return;
    const card = buildCard(entry, view);
    card.__approvalView = view;
    cards.set(dto.requestId, card);
    // A card for a chat in the background waits here until that chat is
    // opened; `mount` puts it in place then (#320).
    const box = isOnScreen(entry) ? currentContainer() : null;
    if (box) {
      box.appendChild(card);
      if (chatMessagesEl) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }
    notifyPendingChanged();
  }

  function onResolved(payload) {
    const entry = queue.resolve(payload);
    if (!entry) return;
    // Decided now, not when the card is next drawn: by then the run may be gone.
    entry.aborted = runAborted(entry);
    const card = cards.get(entry.dto.requestId);
    if (card) applyOutcome(card, entry);
    notifyPendingChanged();
  }

  /**
   * A language change repaints an open card as well (#290): the sentence, the
   * labels and the buttons are built at runtime, so `data-i18n` cannot reach
   * them. The decision itself is untouched — the card is rebuilt from the
   * entry the queue still holds, including the outcome of a resolved one.
   */
  onLocaleChange(() => {
    for (const [requestId, card] of [...cards]) {
      const entry = queue.get(requestId);
      if (!entry) continue;
      const view = viewOf(entry.dto);
      if (!view) continue;
      // The focus follows into the new card: the same button, or the card.
      const focused = card.contains(document.activeElement) ? document.activeElement.dataset?.response || '' : null;
      const fresh = buildCard(entry, view);
      fresh.__approvalView = view;
      card.replaceWith(fresh);
      cards.set(requestId, fresh);
      if (entry.state === APPROVAL_ENTRY_STATES.RESOLVED) applyOutcome(fresh, entry);
      // A decision already on its way keeps its buttons locked; the answer
      // arrives for the request, not for the DOM node it was clicked in.
      else if (entry.state === APPROVAL_ENTRY_STATES.RESPONDING) {
        setButtonsEnabled(fresh, view, false);
        setStatus(fresh, t('approval.status.sending'));
      }
      if (focused !== null) {
        const button = focused ? fresh.querySelector(`.chat-approval-card__actions button[data-response="${focused}"]`) : null;
        (button && !button.disabled && !button.closest('[hidden]') ? button : fresh).focus({ preventScroll: true });
      }
    }
  });

  /** Sichtbar heißt: nimmt Platz im Layout ein – Klassen allein sagen bei verschachtelten Overlays nichts. */
  function isVisible(node) {
    return !!node && node.getClientRects().length > 0;
  }

  function overlayOpen() {
    if (isVisible(document.getElementById('modal-settings'))) return true;
    // Der Chat-Verlauf steht seit Epic #223 (Phase B) als Spalte da und ist
    // kein Overlay mehr — er beansprucht Escape nicht mehr fuer sich.
    for (const id of ['chat-mention-menu', 'chat-model-menu', 'chat-tool-mode-menu']) {
      if (isVisible(document.getElementById(id))) return true;
    }
    // The completions of the composer (`@` and `/`) are listboxes; Escape
    // closes them (CR-B13-02).
    return [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]')]
      .some(isVisible);
  }

  /**
   * Escape from a field of its own — the PDF page number, a rename, a search
   * — belongs to that field. The composer is the exception: it is where the
   * user is when a card arrives (CR-B13-02).
   */
  function fromOtherField(target) {
    if (!(target instanceof Element) || target.id === 'chat-input') return false;
    return target.matches('input, textarea, select') || target.isContentEditable === true;
  }

  // Esc lehnt ab – bewusst nur die älteste offene Karte und nur, wenn kein
  // Overlay den Tastendruck für sich beansprucht. Capture-Phase, damit die
  // Ablehnung nicht von einem anderen Esc-Handler verschluckt wird.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Only a card the user can see: not one of a chat in the background
      // (#320), and not while the chat column is switched off (CR-B13-02).
      const pending = queue.pending().filter((entry) => isOnScreen(entry) && isVisible(cards.get(entry.dto.requestId)));
      if (pending.length === 0 || fromOtherField(e.target) || overlayOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      void respond(pending[0].dto.requestId, 'deny');
    },
    true
  );

  async function subscribe() {
    if (typeof api.subscribeToolApprovals !== 'function') return;
    try {
      await api.subscribeToolApprovals();
      const pending = typeof api.listPendingToolApprovals === 'function' ? await api.listPendingToolApprovals() : null;
      for (const dto of pending?.requests || []) onRequest(dto);
    } catch {
      /* ohne Anmeldung lehnt der Main Rückfragen sicher ab */
    }
  }

  if (typeof api.onToolApprovalRequest === 'function') api.onToolApprovalRequest(onRequest);
  if (typeof api.onToolApprovalResolved === 'function') api.onToolApprovalResolved(onResolved);
  void subscribe();

  return {
    /**
     * Nach einem Neuaufbau der Nachrichtenliste die Karten wieder in die
     * Bubble ihrer Nachricht einhängen – auch nach Ende des Laufs, damit
     * Verfall, Abbruch und Entscheidung sichtbar bleiben.
     */
    mount(bubble, message) {
      if (cards.size === 0 || !message) return;
      let box = null;
      for (const [requestId, card] of cards) {
        const entry = queue.get(requestId);
        if (!entry || owners.get(chatOf(entry)) !== message) continue;
        box = box || ensureContainer(bubble);
        if (!box) return;
        box.appendChild(card);
      }
    },
    /** Neuer Zug: Karten dieses Chats gehören ab jetzt zur neuen Assistant-Nachricht. */
    beginRun(chatId, message) {
      const key = chatId || null;
      for (const entry of queue.forgetWhere((e) => chatOf(e) === key && e.state === APPROVAL_ENTRY_STATES.RESOLVED)) {
        cards.delete(entry.dto.requestId);
      }
      owners.set(key, message || null);
    },
    /**
     * Keep only the cards of the given chats — the one on screen and those
     * still running (#320). A chat the user has left and that has nothing
     * going loses its cards; main has discarded its requests already.
     */
    retainChats(chatIds) {
      const keep = new Set([...chatIds].map((id) => id || null));
      for (const entry of queue.forgetWhere((e) => !keep.has(chatOf(e)))) {
        cards.get(entry.dto.requestId)?.remove();
        cards.delete(entry.dto.requestId);
      }
      for (const chatId of [...owners.keys()]) {
        if (!keep.has(chatId)) owners.delete(chatId);
      }
      notifyPendingChanged();
    },
    pendingCount: () => queue.pending().length,
    pendingChatIds,
  };
}
