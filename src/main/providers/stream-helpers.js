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
const { describeFetchError } = require('../../shared/runtime/fetch-errors');

async function* iterStreamLines(reader, abortSignal) {
  const decoder = new TextDecoder();
  let carry = '';
  while (true) {
    abortIfRequested(abortSignal);
    let done;
    let value;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw err;
    }
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
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

async function* iterSseEvents(reader, abortSignal) {
  let currentEvent = null;
  let dataLines = [];
  for await (const line of iterStreamLines(reader, abortSignal)) {
    if (line === '') {
      if (dataLines.length > 0) {
        yield { event: currentEvent, data: dataLines.join('\n') };
      }
      currentEvent = null;
      dataLines = [];
      continue;
    }
    if (line.startsWith(':')) continue; // SSE comment
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length > 0) {
    yield { event: currentEvent, data: dataLines.join('\n') };
  }
}

async function readErrorMessage(res) {
  const errText = await res.text().catch(() => '');
  let msg = res.statusText || `HTTP ${res.status}`;
  try {
    const j = JSON.parse(errText);
    msg = j.error?.message || j.error?.code || j.error || j.message || msg;
    if (typeof msg !== 'string') msg = String(msg);
  } catch {
    if (errText) msg = errText.slice(0, 300);
  }
  return msg;
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

module.exports = {
  iterStreamLines,
  iterSseEvents,
  describeFetchError,
  readErrorMessage,
  safeJsonParse,
  isAbortError,
  createChatAbortError,
  bindAbortSignalToReader,
  abortIfRequested,
  cancelledChatRound,
  createEmptyUsage,
  normalizeUsage,
  mergeUsage,
  sleepAbortable,
};
