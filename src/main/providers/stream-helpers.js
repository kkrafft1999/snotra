// Token-Usage-Helfer stammen aus der gemeinsamen Contract-Schicht (Single
// Source of Truth); hier nur re-exportiert, damit die Provider sie weiterhin
// aus stream-helpers beziehen können.
const { createEmptyUsage, normalizeUsage, mergeUsage } = require('../../shared/contracts/usage');
const {
  isAbortError,
  createChatAbortError,
  abortIfRequested,
  bindAbortSignalToReader,
  sleepAbortable,
} = require('../../shared/runtime/abort');
const { describeFetchErrorMessage } = require('../../shared/runtime/fetch-errors');
const { createMessage } = require('../../shared/contracts/message');

// The server behind a provider is often one the user typed in, so what it
// sends is read with a ceiling (#539). One line or one SSE event may carry a
// whole file inside a tool call, hence the generous limit; an error body is
// only read as far as it is shown.
const MAX_STREAM_LINE_CHARS = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Stops reading the rest of a body; a failure to do so changes nothing. */
function cancelQuietly(reader) {
  try {
    Promise.resolve(reader?.cancel?.()).catch(() => {});
  } catch {
    // The stream is gone either way.
  }
}

function streamLimitError() {
  return Object.assign(new Error(`The server sent a line longer than ${MAX_STREAM_LINE_CHARS} characters.`), {
    userMessage: createMessage('provider.error.lineTooLong', { megabytes: MAX_STREAM_LINE_CHARS / (1024 * 1024) }),
  });
}

async function* iterStreamLines(reader, abortSignal, { maxLineChars = MAX_STREAM_LINE_CHARS } = {}) {
  const decoder = new TextDecoder();
  let carry = '';
  while (true) {
    abortIfRequested(abortSignal);
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    if (carry.length > maxLineChars || lines.some((line) => line.length > maxLineChars)) {
      cancelQuietly(reader);
      throw streamLimitError();
    }
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      yield line;
    }
  }
  // Flush: ein Multi-Byte-UTF-8-Zeichen kann genau an der Chunk-Grenze enden.
  carry += decoder.decode();
  if (carry) {
    const line = carry.replace(/\r$/, '');
    yield line;
  }
}

async function* iterSseEvents(reader, abortSignal, { maxEventChars = MAX_STREAM_LINE_CHARS } = {}) {
  let currentEvent = null;
  let dataLines = [];
  let dataChars = 0;
  for await (const line of iterStreamLines(reader, abortSignal, { maxLineChars: maxEventChars })) {
    if (line === '') {
      if (dataLines.length > 0) {
        yield { event: currentEvent, data: dataLines.join('\n') };
      }
      currentEvent = null;
      dataLines = [];
      dataChars = 0;
      continue;
    }
    if (line.startsWith(':')) continue; // SSE comment
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      const data = line.slice(5).replace(/^ /, '');
      // An event split over many `data:` lines counts as one (#539).
      dataChars += data.length + 1;
      if (dataChars > maxEventChars) {
        cancelQuietly(reader);
        throw streamLimitError();
      }
      dataLines.push(data);
    }
  }
  if (dataLines.length > 0) {
    yield { event: currentEvent, data: dataLines.join('\n') };
  }
}

/** At most `maxBytes` of a response body as text; the rest is not fetched (#539). */
async function readLimitedText(res, maxBytes = MAX_ERROR_BODY_BYTES) {
  if (typeof res?.body?.getReader !== 'function') return res.text().catch(() => '');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, maxBytes - bytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } catch {
    // What arrived before the failure is still worth showing.
  } finally {
    cancelQuietly(reader);
  }
  return text;
}

async function readErrorMessage(res) {
  return (await readErrorDetails(res)).message;
}

/**
 * The error text plus, where the API names it, the request field it objects
 * to (`error.param`, e.g. `reasoning.effort`). The field lets a provider
 * recognise its own rejections without matching on wording (#718).
 */
async function readErrorDetails(res) {
  const errText = await readLimitedText(res);
  let msg = res.statusText || `HTTP ${res.status}`;
  let param = '';
  try {
    const j = JSON.parse(errText);
    msg = j.error?.message || j.error?.code || j.error || j.message || msg;
    if (typeof msg !== 'string') msg = String(msg);
    if (typeof j.error?.param === 'string') param = j.error.param;
  } catch {
    if (errText) msg = errText.slice(0, 300);
  }
  return { message: msg, param };
}

function safeJsonParse(s, fallback = {}) {
  if (typeof s !== 'string' || !s.trim()) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function cancelledChatRound(message) {
  return { cancelled: true, message };
}

// Optionale Stream-Callbacks für Tool-Aufrufe, die das Modell gerade streamt.
// Damit erscheint die Tool-Zeile im Chat schon, während z. B. der Dateiinhalt
// noch generiert wird — nicht erst nach der Ausführung.
function notifyToolCallStart(callbacks, call) {
  if (typeof callbacks?.onToolCallStart === 'function') callbacks.onToolCallStart(call);
}

function notifyToolCallArgumentsDelta(callbacks, delta) {
  if (typeof callbacks?.onToolCallArgumentsDelta === 'function') callbacks.onToolCallArgumentsDelta(delta);
}

module.exports = {
  MAX_STREAM_LINE_CHARS,
  MAX_ERROR_BODY_BYTES,
  iterStreamLines,
  iterSseEvents,
  describeFetchErrorMessage,
  readLimitedText,
  readErrorMessage,
  readErrorDetails,
  safeJsonParse,
  isAbortError,
  createChatAbortError,
  bindAbortSignalToReader,
  abortIfRequested,
  cancelledChatRound,
  notifyToolCallStart,
  notifyToolCallArgumentsDelta,
  createEmptyUsage,
  normalizeUsage,
  mergeUsage,
  sleepAbortable,
};
