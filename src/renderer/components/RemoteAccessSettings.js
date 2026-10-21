/**
 * *Settings › Remote access* (#1110): pair, show and remove the phone of the
 * mobile remote (#1081), drawn from main's pairing state (#1114,
 * `contracts/remote/pairing-state.js`). The design is the one decided on
 * 2026-10-18 in `docs/ui-design/remote-access-mockup.html`: the pairing runs
 * inside the panel, *Allow* is the system's dialog, one phone per computer.
 *
 * Until the phone's side is out, pairing is closed (decided 2026-10-21): the
 * empty state shows *Pair a phone* disabled, a *Coming soon* chip and why.
 * Main refuses a pairing as well, so the button is not the only lock. A
 * phone paired before can still be removed.
 *
 * Everything here takes effect at once; *Apply* is not involved. Main owns
 * nine of the states; *Replace phone?* and *Remove phone?* are questions the
 * panel asks itself while main stays in `paired`.
 */
import contracts from '../generated/contracts.js';
import { APP_LOCALES, getLocale, onLocaleChange, t } from '../i18n.js';
import { settingsPageName } from '../utils/settings-pages.js';

const { REMOTE_PAIRING_STATES: STATES, REMOTE_PAIRING_REASONS: REASONS } = contracts;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** How long a code is valid (protocol §4), for the countdown's bar. */
const CODE_TTL_MS = 5 * 60 * 1000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.type = 'button';
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

function svgIcon(paths, size = 22) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of paths) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    svg.appendChild(node);
  }
  return svg;
}

const ICONS = {
  phone: () => svgIcon([['rect', { x: '6.5', y: '2.5', width: '11', height: '19', rx: '2.5' }], ['path', { d: 'M10.5 18.5h3', 'stroke-linecap': 'round' }]]),
  alert: () => svgIcon([['path', { d: 'M12 3.4 21.6 20H2.4z', 'stroke-linejoin': 'round' }], ['path', { d: 'M12 9.6v4.8M12 17.2v.1', 'stroke-linecap': 'round' }]], 20),
  cloud: () => svgIcon([['path', { d: 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.1 4.5 4.5 0 0 0 7 18z', 'stroke-linejoin': 'round' }], ['path', { d: 'M4 4l16 16', 'stroke-linecap': 'round' }]]),
  info: () => svgIcon([['circle', { cx: '12', cy: '12', r: '9.4' }], ['path', { d: 'M12 10.8v5.4M12 7.6v.1', 'stroke-linecap': 'round' }]], 16),
  shield: () => svgIcon([['path', { d: 'M12 2.7 19.5 5.4v6.2c0 4.5-3.2 8-7.5 9.7-4.3-1.7-7.5-5.2-7.5-9.7V5.4z', 'stroke-linejoin': 'round' }]], 16),
};

/** `4:59`, from milliseconds. */
function minutesSeconds(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The QR code from main's modules, on a plate that stays light in both themes. */
function qrCode(modules, { expired = false } = {}) {
  const plate = el('div', `ra-qr${expired ? ' ra-qr--expired' : ''}`);
  const quiet = 2;
  const side = modules.length + quiet * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${side} ${side}`);
  svg.setAttribute('width', '196');
  svg.setAttribute('height', '196');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('settings.remote.qrLabel'));
  // One path for all dark modules: hundreds of rects would be needless DOM.
  let d = '';
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] === '1') d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  });
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'ra-qr__ink');
  svg.appendChild(path);
  plate.appendChild(svg);
  return plate;
}

/**
 * @param {{
 *   root: HTMLElement | null,
 *   api: any,
 *   openPanel?: (panelKey: string) => void,
 *   now?: () => number,
 * }} deps  `openPanel` switches the dialog to another section — for the link to Tools › Security
 */
export function initRemoteAccessSettings({ root, api, openPanel = () => {}, now = () => Date.now() } = {}) {
  const noop = { open: async () => {}, render: () => {}, dispose: () => {} };
  if (!root || !api?.remote) return noop;

  /** @type {ReturnType<typeof contracts.normalizeRemotePairingState> | null} */
  let state = null;
  /** The released workspaces, for the row under the phone. */
  let releasedCount = null;
  /** A question the panel asks itself: 'replace' | 'remove' | null. */
  let asking = null;
  /** An action under way: its button stays disabled until main answers. */
  let busy = false;
  /** A refused action's line, until the next state. */
  let failure = null;
  /** The countdown's ticker while a code is shown. */
  let ticker = 0;
  /** What was drawn last, so that a new state moves the focus to its first action. */
  let drawnKey = '';
  let unsubscribe = null;

  const normalize = (raw) => contracts.normalizeRemotePairingState(raw);

  async function readReleases() {
    try {
      const view = await api.remote.getReleases?.();
      releasedCount = Array.isArray(view?.released) ? view.released.length : null;
    } catch {
      // The row then says nothing about the count; the link still leads there.
      releasedCount = null;
    }
  }

  async function open() {
    if (!unsubscribe && typeof api.remote.onState === 'function') {
      unsubscribe = api.remote.onState((raw) => {
        state = normalize(raw);
        failure = null;
        if (state.state !== STATES.PAIRED) asking = null;
        render();
      });
    }
    try {
      state = normalize(await api.remote.getState());
    } catch {
      // Main did not answer: the panel shows the empty state and says that something failed.
      state = normalize(null);
      failure = t('settings.remote.failed');
    }
    await readReleases();
    render();
  }

  /** Runs one of main's actions; a refusal says so in the panel. */
  async function act(run) {
    if (busy) return;
    busy = true;
    failure = null;
    render();
    let result = null;
    try {
      result = await run();
    } catch {
      // The IPC call failed: drawn as a refusal, with the line below.
      result = { ok: false };
    }
    busy = false;
    // A reason main draws a state of its own for needs no line here.
    if (!result?.ok && ![REASONS.CANCELLED, REASONS.NETWORK, REASONS.NOT_CONFIGURED, REASONS.RATE_LIMITED,
      REASONS.UNAUTHORIZED, REASONS.REFUSED, REASONS.UNAVAILABLE, REASONS.INVALID_RESPONSE].includes(result?.reason)) {
      if (result?.reason === REASONS.ENCRYPTION_UNAVAILABLE) failure = t('settings.remote.noEncryption');
      else if (result?.reason === REASONS.LOCKED) failure = t('settings.remote.locked');
      else failure = t('settings.remote.failed');
    }
    render();
    return result;
  }

  const startPairing = () => { asking = null; return act(() => api.remote.startPairing()); };
  const cancelPairing = () => act(() => api.remote.cancelPairing());
  const unpair = async () => {
    const result = await act(() => api.remote.unpair());
    if (result?.ok) asking = null;
    render();
  };

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = 0;
  }

  // ---------------------------------------------------------------- pieces

  function notice(text, role = 'status') {
    const box = el('div', 'ra-notice');
    box.setAttribute('role', role);
    box.append(ICONS.info(), el('span', null, text));
    return box;
  }

  function actions(...buttons) {
    const row = el('div', 'ra-actions');
    row.append(...buttons.filter(Boolean));
    return row;
  }

  function emptyCard({ note = null } = {}) {
    const fragment = document.createDocumentFragment();
    if (note) fragment.appendChild(notice(note));
    const card = el('div', 'ra-card ra-empty');
    const icon = el('div', 'ra-empty__icon');
    icon.appendChild(ICONS.phone());
    const title = el('h3', 'ra-empty__title', t('settings.remote.empty.title'));
    if (state.locked) title.appendChild(el('span', 'ra-soon', t('settings.remote.soon')));
    card.append(icon, title, el('p', 'ra-empty__text', t('settings.remote.empty.text')),
      el('p', 'ra-empty__need', t('settings.remote.empty.need')));
    const pair = button(t('settings.remote.pair'), 'btn-primary', startPairing);
    pair.dataset.action = 'pair';
    const why = state.locked
      ? t('settings.remote.locked')
      : !state.encryptionAvailable ? t('settings.remote.noEncryption') : null;
    if (why || busy) pair.disabled = true;
    card.appendChild(pair);
    if (why) {
      const line = el('p', 'ra-locked-why', why);
      line.id = 'ra-pair-why';
      pair.setAttribute('aria-describedby', line.id);
      card.appendChild(line);
    }
    fragment.appendChild(card);
    return fragment;
  }

  function steps(current) {
    const list = el('ol', 'ra-steps');
    ['scan', 'confirm', 'done'].forEach((key, i) => {
      const item = el('li', i < current ? 'is-done' : null);
      if (i === current) item.setAttribute('aria-current', 'step');
      item.append(el('span', 'n', String(i + 1)), el('span', null, t(`settings.remote.step.${key}`)));
      list.appendChild(item);
    });
    return list;
  }

  function flowCard(current, body, buttons) {
    const card = el('div', 'ra-card');
    const head = el('div', 'ra-flow__head');
    head.append(el('h3', 'ra-flow__title', t('settings.remote.flow.title')), steps(current));
    card.append(head, body, actions(...buttons));
    return card;
  }

  function howto() {
    const list = el('ol', 'ra-howto');
    // One span per step: the list item is a flex row, and loose text beside a <strong> would be spaced as items.
    const step = (...parts) => {
      const item = el('li');
      const text = el('span');
      text.append(...parts);
      item.appendChild(text);
      list.appendChild(item);
    };
    step(t('settings.remote.howto.open'));
    const [before, after] = t('settings.remote.howto.tap').split('{action}');
    step(before, el('strong', null, t('settings.remote.howto.action')), after ?? '');
    step(t('settings.remote.howto.scan'));
    return list;
  }

  function codeBody({ expired = false } = {}) {
    const scan = el('div', 'ra-scan');
    const code = state.code;
    if (code?.modules) scan.appendChild(qrCode(code.modules, { expired }));
    else scan.appendChild(el('div', 'ra-qr ra-qr--empty'));
    const side = el('div');
    side.appendChild(howto());
    side.appendChild(el('span', 'ra-key__label', t('settings.remote.key')));
    const key = el('span', 'ra-key', code?.display ?? '');
    // The key's symbols are read out as Latin letters and digits, whatever the interface language.
    key.setAttribute('lang', APP_LOCALES.EN);
    side.appendChild(key);
    if (code) {
      const timer = el('div', 'ra-timer');
      const row = el('div', 'ra-timer__row');
      const left = el('span', 'ra-timer__left');
      row.append(left, el('span', null, t('settings.remote.once')));
      const track = el('div', 'ra-timer__track');
      const fill = el('div', 'ra-timer__fill');
      track.appendChild(fill);
      timer.append(row, track);
      const tick = () => {
        const remaining = code.expiresAt - now();
        left.textContent = t('settings.remote.validFor', { time: minutesSeconds(remaining) });
        fill.style.width = `${Math.max(0, Math.min(100, (remaining / CODE_TTL_MS) * 100))}%`;
      };
      tick();
      ticker = setInterval(tick, 1000);
      side.appendChild(timer);
    }
    const wait = el('p', 'ra-wait');
    wait.setAttribute('role', 'status');
    const dots = el('span', 'ra-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(el('i'), el('i'), el('i'));
    wait.append(dots, t('settings.remote.waiting'));
    side.appendChild(wait);
    scan.appendChild(side);
    return scan;
  }

  function confirmBody() {
    const body = document.createDocumentFragment();
    body.append(el('p', 'ra-confirm__lead', t('settings.remote.confirm.lead')),
      el('p', 'ra-confirm__sub', t('settings.remote.confirm.sub')));
    const words = el('ol', 'ra-words');
    // The words belong to the protocol and are never translated (#1116).
    words.setAttribute('lang', APP_LOCALES.EN);
    (state.words || []).forEach((word, i) => {
      const item = el('li');
      item.append(el('span', 'i', String(i + 1)), el('span', 'w', word));
      words.appendChild(item);
    });
    const hint = el('p', 'ra-sys-hint');
    hint.append(ICONS.shield(), el('span', null, t('settings.remote.confirm.system')));
    body.append(words, hint);
    return body;
  }

  function problem(title, text, { error = false } = {}) {
    const box = el('div', error ? 'ra-error' : 'ra-offline');
    if (error) box.setAttribute('role', 'alert');
    box.appendChild(error ? ICONS.alert() : ICONS.cloud());
    const words = el('div');
    words.append(el('p', error ? 'ra-error__title' : 'ra-ask__title', title), el('p', error ? 'ra-error__text' : 'ra-ask__text', text));
    box.appendChild(words);
    return box;
  }

  function relayText() {
    if (state.reason === REASONS.NOT_CONFIGURED) return t('settings.remote.relay.notConfigured');
    if (state.reason === REASONS.RATE_LIMITED) return t('settings.remote.relay.rateLimited');
    return t('settings.remote.relay.text');
  }

  function question(kind) {
    const box = el('div', 'ra-ask');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', 'ra-ask-title');
    box.setAttribute('aria-describedby', 'ra-ask-text');
    const title = el('p', 'ra-ask__title', t(`settings.remote.${kind}.title`));
    title.id = 'ra-ask-title';
    const text = el('p', 'ra-ask__text', t(`settings.remote.${kind}.text`));
    text.id = 'ra-ask-text';
    const go = kind === 'remove'
      ? button(t('settings.remote.remove'), 'btn-destructive', unpair)
      : button(t('settings.remote.replace.go'), 'btn-primary', startPairing);
    go.disabled = busy || (kind === 'replace' && state.locked);
    const row = el('div', 'ra-actions');
    row.append(button(t('settings.remote.cancel'), 'btn-secondary', () => { asking = null; render(); }), go);
    box.append(title, text, row);
    return box;
  }

  function formatDate(at) {
    if (!at) return '';
    return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(at));
  }

  function deviceCards() {
    const fragment = document.createDocumentFragment();
    const locked = asking !== null;
    fragment.appendChild(el('div', 'modal-field-label eyebrow-row', t('settings.remote.paired.eyebrow')));
    const card = el('div', 'ra-card');
    const device = el('div', 'ra-device');
    const icon = el('div', 'ra-device__icon');
    icon.appendChild(ICONS.phone());
    const about = el('div');
    const on = state.phone?.connected === true;
    const status = el('p', `ra-status ${on ? 'ra-status--on' : 'ra-status--off'}`);
    const dot = el('span', 'ra-status__dot');
    dot.setAttribute('aria-hidden', 'true');
    status.append(dot, el('strong', null, t(on ? 'settings.remote.connected' : 'settings.remote.notConnected')));
    about.append(el('p', 'ra-device__name', t('settings.remote.phone')), status);
    if (state.phone?.pairedAt) about.appendChild(el('p', 'ra-meta', t('settings.remote.pairedOn', { date: formatDate(state.phone.pairedAt) })));
    const buttons = el('div', 'ra-device__actions');
    const replace = button(t('settings.remote.replace'), 'btn-secondary', () => { asking = 'replace'; render(); });
    replace.dataset.action = 'replace';
    // Replacing is pairing: closed as long as pairing is (#1110).
    replace.disabled = locked || busy || state.locked;
    if (state.locked) replace.title = t('settings.remote.locked');
    const remove = button(t('settings.remote.remove'), 'btn-destructive', () => { asking = 'remove'; render(); });
    remove.dataset.action = 'remove';
    remove.disabled = locked || busy;
    buttons.append(replace, remove);
    device.append(icon, about, buttons);
    card.appendChild(device);
    fragment.appendChild(card);

    fragment.appendChild(el('div', 'modal-field-label eyebrow-row', t('settings.remote.can.eyebrow')));
    const rows = el('ul', 'ra-rows');
    const workspaces = el('li');
    const value = el('span', 'v');
    const count = releasedCount === null ? null
      : releasedCount === 0 ? t('settings.remote.can.workspaces.none')
        : t(releasedCount === 1 ? 'settings.remote.can.workspaces.count.one' : 'settings.remote.can.workspaces.count.other', { count: releasedCount });
    if (count) value.append(count, ' · ');
    const link = button(t('settings.remote.can.workspaces.change', { place: settingsPageName('sandbox') }), 'ra-link', () => openPanel('sandbox'));
    value.appendChild(link);
    workspaces.append(el('span', 'k', t('settings.remote.can.workspaces')), value);
    const approvals = el('li');
    approvals.append(el('span', 'k', t('settings.remote.can.approvals')), el('span', 'v', t('settings.remote.can.approvals.value')));
    rows.append(workspaces, approvals);
    const rowsCard = el('div', 'ra-card');
    rowsCard.appendChild(rows);
    fragment.appendChild(rowsCard);
    return fragment;
  }

  // ---------------------------------------------------------------- drawing

  function render() {
    stopTicker();
    if (!state) return;
    const view = document.createDocumentFragment();
    const s = state.state;
    if (failure) view.appendChild(notice(failure, 'alert'));
    if (s === STATES.OPENING) {
      const body = el('p', 'ra-wait', t('settings.remote.opening'));
      body.setAttribute('role', 'status');
      view.appendChild(flowCard(0, body, [button(t('settings.remote.cancel'), 'btn-secondary', cancelPairing)]));
    } else if (s === STATES.CODE) {
      view.appendChild(flowCard(0, codeBody(), [button(t('settings.remote.cancel'), 'btn-secondary', cancelPairing)]));
    } else if (s === STATES.CONFIRM) {
      // Allow and Deny are the system dialog's; Cancel here says no as well.
      view.appendChild(flowCard(1, confirmBody(), [button(t('settings.remote.cancel'), 'btn-secondary', cancelPairing)]));
    } else if (s === STATES.EXPIRED) {
      const body = document.createDocumentFragment();
      body.append(el('p', 'ra-ask__title', t('settings.remote.expired.title')), el('p', 'ra-ask__text', t('settings.remote.expired.text')));
      view.appendChild(flowCard(0, body, [
        button(t('settings.remote.cancel'), 'btn-secondary', cancelPairing),
        Object.assign(button(t('settings.remote.newCode'), 'btn-primary', startPairing), { disabled: busy || state.locked }),
      ]));
    } else if (s === STATES.STOPPED) {
      const text = state.reason === REASONS.NOT_SAVED ? t('settings.remote.stopped.notSaved') : t('settings.remote.stopped.mac');
      view.appendChild(flowCard(1, problem(t('settings.remote.stopped.title'), text, { error: true }), [
        button(t('settings.remote.cancel'), 'btn-secondary', cancelPairing),
        Object.assign(button(t('settings.remote.again'), 'btn-primary', startPairing), { disabled: busy || state.locked }),
      ]));
    } else if (s === STATES.UNREACHABLE) {
      view.appendChild(flowCard(0, problem(t('settings.remote.relay.title'), relayText()), [
        button(t('settings.remote.cancel'), 'btn-secondary', cancelPairing),
        Object.assign(button(t('settings.remote.retry'), 'btn-primary', startPairing), { disabled: busy || state.locked }),
      ]));
    } else if (s === STATES.PAIRED) {
      if (asking) view.appendChild(question(asking));
      view.appendChild(deviceCards());
    } else {
      view.appendChild(emptyCard({ note: s === STATES.DENIED ? t('settings.remote.denied') : null }));
    }

    const key = `${s}:${asking ?? ''}`;
    const hadFocus = root.contains(document.activeElement);
    root.replaceChildren(view);
    // A new state's first action takes the focus — only while it was in the panel.
    if (key !== drawnKey && hadFocus) {
      const first = root.querySelector('[role="alertdialog"] button:not([disabled]), .ra-actions button:not([disabled]), button:not([disabled])');
      first?.focus();
    }
    drawnKey = key;
  }

  const stopFollowingLocale = onLocaleChange(() => render());

  return {
    open,
    render,
    dispose() {
      stopTicker();
      stopFollowingLocale?.();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/**
 * Whether *Settings › Remote access* is in the navigation (#1213): while
 * developer mode is on — switched with ⌘⌥⇧D, which main catches and this
 * passes on — or while a phone is paired, so that it can still be removed.
 * The *Developer* chip says which. A hidden section that is open gives way
 * to *Models*.
 *
 * @param {{
 *   api: any,
 *   tab: HTMLElement | null,
 *   leave: () => void,
 *   isActive: () => boolean,
 * }} deps
 */
export function initRemoteSectionVisibility({ api, tab, leave, isActive }) {
  if (!tab || !api?.developerMode) return { refresh: async () => {} };
  const chip = tab.querySelector('.settings-nav-chip');
  let developer = false;
  let paired = false;

  function sync() {
    const shown = developer || paired;
    tab.hidden = !shown;
    if (chip) chip.hidden = !developer;
    if (!shown && isActive()) leave();
  }

  api.developerMode.onChange?.((payload) => {
    developer = payload?.on === true;
    sync();
  });
  api.developerMode.onShortcut?.(() => {
    Promise.resolve(api.developerMode.toggle()).catch((error) => console.error('[settings] developer mode could not be switched:', error));
  });
  api.remote?.onState?.((raw) => {
    paired = !!contracts.normalizeRemotePairingState(raw).phone;
    sync();
  });

  async function refresh() {
    const [mode, state] = await Promise.all([api.developerMode.get(), api.remote?.getState?.()]);
    developer = mode?.on === true;
    paired = !!contracts.normalizeRemotePairingState(state).phone;
    sync();
  }
  refresh().catch((error) => console.error('[settings] developer mode could not be read:', error));
  return { refresh };
}
