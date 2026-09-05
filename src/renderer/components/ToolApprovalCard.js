import { buildApprovalCardView, describeApprovalOutcome } from '../utils/tool-approval-view.js';
import { createToolApprovalQueue, APPROVAL_ENTRY_STATES } from '../utils/tool-approval-queue.js';

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
export function initToolApprovalCards({ api, appStore }) {
  const chatMessagesEl = document.getElementById('chat-messages');
  const queue = createToolApprovalQueue();
  /** requestId → Karten-Element des laufenden Zuges. */
  const cards = new Map();
  /** Nachricht (Store-Objekt), zu der die Karten gehören – überlebt Neuaufbauten der Liste. */
  let owner = null;

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
  function runAborted() {
    return appStore.chatSendSeq > 0 && appStore.chatAbortedSendSeq === appStore.chatSendSeq;
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
      li.appendChild(code(target.path || '(ohne Pfad)'));
      if (target.sensitive) {
        const badge = el('span', 'chat-approval-card__badge', 'sensibel');
        badge.title = 'Diese Datei kann Zugangsdaten enthalten.';
        li.appendChild(badge);
      }
      const notes = target.notes.filter((n) => !n.startsWith('sensibel'));
      if (notes.length > 0) li.appendChild(el('span', 'chat-approval-card__target-note', notes.join(' · ')));
      list.appendChild(li);
    }
    if (view.targets.length === 0) list.appendChild(el('li', 'chat-approval-card__target-note', 'ohne Dateiziel'));
    return list;
  }

  function buildPreview(view) {
    const preview = view.preview;
    if (!preview) return null;
    const details = el('details', 'chat-approval-card__preview');
    const summary = el('summary', null, preview.summary);
    details.appendChild(summary);
    const notes = [preview.truncatedNote, preview.maskedNote].filter(Boolean);
    if (notes.length > 0) details.appendChild(el('p', 'chat-approval-card__preview-note', notes.join(' ')));
    const pre = el('pre', 'chat-approval-card__preview-text chat-approval-card__preview-text--clamped');
    pre.dataset.kind = preview.kind;
    pre.textContent = preview.text;
    details.appendChild(pre);
    // Lange Vorschauen sind zunächst höhenbegrenzt; „Vollständig anzeigen“
    // hebt die Grenze auf. Der Text bleibt derselbe – maskiert bleibt maskiert.
    const expand = el('button', 'chat-approval-card__preview-toggle', 'Vollständig anzeigen');
    expand.type = 'button';
    expand.setAttribute('aria-expanded', 'false');
    expand.addEventListener('click', () => {
      const clamped = pre.classList.toggle('chat-approval-card__preview-text--clamped');
      expand.textContent = clamped ? 'Vollständig anzeigen' : 'Vorschau einklappen';
      expand.setAttribute('aria-expanded', clamped ? 'false' : 'true');
    });
    details.appendChild(expand);
    return details;
  }

  function buildActions(view, requestId) {
    const actions = el('div', 'chat-approval-card__actions');
    const hintId = domId(requestId, 'session-hint');
    for (const key of ['once', 'session', 'deny']) {
      const action = view.actions[key];
      const button = el('button', key === 'once' ? 'btn-primary' : 'btn-secondary', action.label);
      button.type = 'button';
      button.dataset.response = action.response;
      button.disabled = !action.enabled;
      if (key === 'session' && action.hint) {
        button.setAttribute('aria-describedby', hintId);
        button.title = action.hint;
      }
      actions.appendChild(button);
    }
    return { actions, hintId };
  }

  function buildCard(entry, view) {
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
    card.appendChild(title);

    const headline = el('p', 'chat-approval-card__headline');
    headline.id = domId(requestId, 'headline');
    headline.append('Snotra möchte ');
    if (view.headline.targetLabel) {
      headline.appendChild(code(view.headline.targetLabel));
      headline.append(' ');
    }
    headline.append(`${view.headline.verb} (`);
    headline.appendChild(code(view.headline.tool || 'Tool', 'en'));
    headline.append(').');
    card.appendChild(headline);

    const facts = el('dl', 'chat-approval-card__facts');
    fact(facts, 'Wirkung', view.classText);
    fact(facts, view.targets.length === 1 ? 'Ziel' : 'Ziele', buildTargetList(view));
    if (view.reason) fact(facts, 'Grund', view.reason);
    if (view.sensitive && view.providerLabel) fact(facts, 'Empfänger', view.providerLabel);
    if (view.scopeNote) fact(facts, 'Sitzungsumfang', view.scopeNote);
    fact(facts, 'Modus', view.modeLabel);
    card.appendChild(facts);

    if (view.warning) {
      const warning = el('p', 'chat-approval-card__warning');
      warning.appendChild(el('strong', null, 'Achtung: '));
      warning.append(view.warning);
      card.appendChild(warning);
    }

    const preview = buildPreview(view);
    if (preview) card.appendChild(preview);

    const { actions, hintId } = buildActions(view, requestId);
    card.appendChild(actions);
    if (view.actions.session.hint) {
      const hint = el('p', 'chat-approval-card__hint', view.actions.session.hint);
      hint.id = hintId;
      card.appendChild(hint);
    }

    const status = el('p', 'chat-approval-card__status', 'Wartet auf deine Entscheidung. Esc lehnt ab.');
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
      const key = button.dataset.response === 'allow-session' ? 'session' : button.dataset.response === 'deny' ? 'deny' : 'once';
      button.disabled = !enabled || !view.actions[key].enabled;
    }
  }

  /** Auflösung anzeigen: keine aktive Aktion bleibt zurück (Konzept §6). */
  function applyOutcome(card, entry) {
    const outcome = describeApprovalOutcome({ ...(entry.outcome || {}), aborted: runAborted() && entry.outcome?.invalidated === true });
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
    setStatus(card, `${outcome.label}.`);
  }

  async function respond(requestId, response) {
    if (!queue.beginResponse(requestId, response)) return;
    const card = cards.get(requestId);
    const entry = queue.get(requestId);
    const view = card?.__approvalView;
    if (card && view) {
      setButtonsEnabled(card, view, false);
      setStatus(card, 'Entscheidung wird übermittelt …');
    }
    let result;
    try {
      result = typeof api.respondToolApproval === 'function'
        ? await api.respondToolApproval(requestId, response)
        : { ok: false, error: 'Freigaben sind nicht verfügbar.' };
    } catch (error) {
      result = { ok: false, error: error?.message || 'Unbekannter Fehler.' };
    }
    if (result?.ok) return; // Auflösung kommt per Push vom Main.
    if (entry?.state === APPROVAL_ENTRY_STATES.RESOLVED) return; // inzwischen verfallen
    queue.failResponse(requestId);
    if (card && view) {
      setButtonsEnabled(card, view, true);
      setStatus(card, `Antwort nicht angenommen: ${result?.error || 'unbekannter Fehler'}. Du kannst erneut entscheiden.`);
    }
  }

  function onRequest(dto) {
    const entry = queue.add(dto);
    if (!entry) return;
    const view = buildApprovalCardView(dto);
    if (!view) return;
    const card = buildCard(entry, view);
    card.__approvalView = view;
    cards.set(dto.requestId, card);
    const box = currentContainer();
    if (box) {
      box.appendChild(card);
      if (chatMessagesEl) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }
  }

  function onResolved(payload) {
    const entry = queue.resolve(payload);
    if (!entry) return;
    const card = cards.get(entry.dto.requestId);
    if (card) applyOutcome(card, entry);
  }

  /** Sichtbar heißt: nimmt Platz im Layout ein – Klassen allein sagen bei verschachtelten Overlays nichts. */
  function isVisible(node) {
    return !!node && node.getClientRects().length > 0;
  }

  function overlayOpen() {
    if (isVisible(document.getElementById('modal-settings'))) return true;
    for (const id of ['chat-mention-menu', 'chat-model-menu', 'chat-tool-mode-menu', 'chat-history-drawer']) {
      if (isVisible(document.getElementById(id))) return true;
    }
    return [...document.querySelectorAll('[role="menu"], [role="dialog"], [role="alertdialog"]')].some(isVisible);
  }

  // Esc lehnt ab – bewusst nur die älteste offene Karte und nur, wenn kein
  // Overlay den Tastendruck für sich beansprucht. Capture-Phase, damit die
  // Ablehnung nicht von einem anderen Esc-Handler verschluckt wird.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const pending = queue.pending();
      if (pending.length === 0 || overlayOpen()) return;
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
      if (cards.size === 0 || !owner || message !== owner) return;
      const box = ensureContainer(bubble);
      if (!box) return;
      for (const card of cards.values()) box.appendChild(card);
    },
    /** Neuer Zug: Karten gehören ab jetzt zur neuen Assistant-Nachricht. */
    beginRun(message) {
      cards.clear();
      queue.forgetResolved();
      owner = message || null;
    },
    /** Chat- oder Workspace-Wechsel: offene Karten verfallen lokal (der Main verwirft sie ohnehin). */
    reset() {
      for (const entry of queue.invalidateAll('request_invalidated')) {
        const card = cards.get(entry.dto.requestId);
        if (card) applyOutcome(card, entry);
      }
      cards.clear();
      queue.forgetResolved();
      owner = null;
    },
    pendingCount: () => queue.pending().length,
  };
}
