/**
 * Führt modellgelieferte reguläre Ausdrücke in einem worker_thread mit hartem
 * Zeitbudget aus (Issue #69, ReDoS). Synchrones Regex-Matching lässt sich im
 * Main-Prozess nicht unterbrechen; ein Worker dagegen kann jederzeit per
 * terminate() beendet werden, ohne dass die App einfriert.
 *
 * Der Worker-Code wird als Quelltext (`eval: true`) gestartet, nicht als
 * Datei: so funktioniert er auch aus dem asar-Archiv der gepackten App und
 * teilt sich das Matching 1:1 mit dem Main-Thread-Pfad für wörtliche Suchen.
 */
const { Worker } = require('worker_threads');
const { collectLineMatches } = require('./search-line-matcher');

/** Gesamtes Zeitbudget für das Matching einer Suche (Summe über alle Dateien). */
const REGEX_SEARCH_DEFAULT_TIME_BUDGET_MS = 5000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const collectLineMatches = ${collectLineMatches.toString()};
const matcher = new RegExp(workerData.pattern, workerData.flags);
parentPort.on('message', ({ id, text, maxMatches }) => {
  const matches = collectLineMatches(text, matcher, { ...workerData.options, maxMatches });
  parentPort.postMessage({ id, matches });
});
`;

class RegexSearchTimeoutError extends Error {
  constructor(timeBudgetMs) {
    super(
      `Der reguläre Ausdruck ist zu langsam: Zeitbudget von ${Math.round(timeBudgetMs / 1000)} s überschritten. ` +
        'Muster vereinfachen (z. B. keine verschachtelten Wiederholungen), Suchbereich mit relative_path/include ' +
        'einschränken oder wörtlich suchen (is_regex=false).'
    );
    this.name = 'RegexSearchTimeoutError';
    this.timeBudgetMs = timeBudgetMs;
  }
}

/**
 * @param {object} params
 * @param {string} params.pattern  Regex-Quelltext
 * @param {string} params.flags    Regex-Flags (ohne g/y)
 * @param {object} params.options  { contextLines, matchLineChars, clipChars } für collectLineMatches
 * @param {number} [params.timeBudgetMs]
 */
function createRegexSearchWorker({ pattern, flags, options, timeBudgetMs = REGEX_SEARCH_DEFAULT_TIME_BUDGET_MS }) {
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags, options } });
  let remainingMs = timeBudgetMs;
  let nextId = 0;
  let pending = null;
  let failure = null;

  function settlePending(fn) {
    const p = pending;
    pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    fn(p);
  }

  worker.on('message', (msg) => {
    if (!pending || msg.id !== pending.id) return;
    settlePending((p) => {
      remainingMs -= Date.now() - p.startedAt;
      p.resolve(msg.matches);
    });
  });
  worker.on('error', (err) => {
    failure = failure || err;
    settlePending((p) => p.reject(err));
  });
  worker.on('exit', () => {
    failure = failure || new Error('Regex-Worker wurde beendet.');
    settlePending((p) => p.reject(failure));
  });

  /** Matcht `text` im Worker; wirft RegexSearchTimeoutError, wenn das Budget aufgebraucht ist. */
  function search(text, maxMatches) {
    if (failure) return Promise.reject(failure);
    if (pending) return Promise.reject(new Error('Regex-Worker ist bereits beschäftigt.'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        failure = new RegexSearchTimeoutError(timeBudgetMs);
        settlePending((p) => p.reject(failure));
        worker.terminate();
      }, Math.max(1, remainingMs));
      pending = { id, resolve, reject, timer, startedAt: Date.now() };
      worker.postMessage({ id, text, maxMatches });
    });
  }

  function terminate() {
    settlePending((p) => p.reject(new Error('Regex-Suche abgebrochen.')));
    return worker.terminate();
  }

  return { search, terminate };
}

module.exports = {
  REGEX_SEARCH_DEFAULT_TIME_BUDGET_MS,
  RegexSearchTimeoutError,
  createRegexSearchWorker,
};
