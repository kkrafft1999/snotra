'use strict';

const { createMessage } = require('../../shared/contracts/message');
const { VOICE_SAMPLE_RATE, MAX_VOICE_RECORDING_MS } = require('../../shared/contracts/voice');
const { createTurnDetector } = require('./turn-detector');

/**
 * Live transcription through OpenAI's realtime API (#859).
 *
 * One WebSocket per recording, held by main so the key never reaches the
 * renderer. Audio goes in as it is spoken; the text comes back in turns. A
 * turn grows word by word while it is spoken and is settled — casing,
 * punctuation, corrections — once its audio is committed. The model detects
 * no pauses itself, so the turn detector decides when to commit.
 *
 * Checked against the documentation on 2026-10-11: transcription sessions are
 * opened with `intent=transcription`, configured with `session.update` and
 * `session.type: "transcription"`; `gpt-live-transcribe` takes no server-side
 * turn detection.
 */

const REALTIME_TRANSCRIPTION_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const TRANSCRIPTION_MODEL = 'gpt-live-transcribe';
// Names the model would otherwise hear as something else.
const KEYWORDS = ['Snotra'];
const CONNECT_TIMEOUT_MS = 15000;
// How long a stopped recording waits for its last turn to be settled.
const FINISH_TIMEOUT_MS = 10000;
const BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2;
// OpenAI refuses to commit less than 100 ms of audio.
const MIN_COMMIT_BYTES = BYTES_PER_SECOND / 10;
// Audio spoken while the connection is still being set up waits for it — up
// to the connection timeout, and a little more.
const MAX_QUEUED_BYTES = BYTES_PER_SECOND * 20;
// The renderer stops at the time limit; this is main's own ceiling.
const MAX_SESSION_BYTES = BYTES_PER_SECOND * (MAX_VOICE_RECORDING_MS / 1000 + 30);

function sessionUpdate(language) {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: VOICE_SAMPLE_RATE },
          transcription: {
            model: TRANSCRIPTION_MODEL,
            languages: [language],
            keywords: KEYWORDS,
            delay: 'low',
          },
          turn_detection: null,
        },
      },
    },
  };
}

/** What OpenAI said, quoted as it stands; Snotra's own words when it said nothing. */
function apiMessage(error) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return message || createMessage('chat.voice.failed');
}

function textOf(data) {
  if (typeof data === 'string') return data;
  try {
    return Buffer.from(data).toString('utf8');
  } catch {
    return '';
  }
}

function createRealtimeTranscriptionService({
  credentials,
  speechProviderId = 'openai',
  getAppLocale,
  // Looked up per session, like `fetch` in the providers: the end-to-end tests
  // swap it in the running app without a hook in the code.
  getWebSocket = () => globalThis.WebSocket,
  url = REALTIME_TRANSCRIPTION_URL,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  finishTimeoutMs = FINISH_TIMEOUT_MS,
}) {
  async function resolveLanguage() {
    const locale = getAppLocale ? await getAppLocale() : 'de';
    return locale === 'en' ? 'en' : 'de';
  }

  /**
   * Opens one live transcription.
   *
   * `started` resolves `{ ok: true }` as soon as there is a key and the
   * connection is under way — audio can be appended from then on and waits
   * for the connection — or `{ error }` when there is no key; the microphone
   * need not be opened then. `onUpdate({ turns, settledBytes })` receives
   * every turn so far, in spoken order, each `{ text, final }`, and how many
   * bytes of the audio the settled turns at the front cover — where a fallback
   * has to pick up. `onError(error)` reports a failure after the start, a
   * refused connection included; the session is over then.
   */
  function open({ onUpdate = () => {}, onError = () => {} } = {}) {
    // 'open' while audio comes in, 'finishing' after the stop, then 'closed'.
    let phase = 'open';
    let up = false;
    let socket = null;
    let lastError = null;
    let settleStarted;
    let startSettled = false;
    const started = new Promise((resolve) => { settleStarted = resolve; });
    let settleReady;
    let readySettled = false;
    const ready = new Promise((resolve) => { settleReady = resolve; });
    const queue = [];
    let queuedBytes = 0;
    let totalBytes = 0;
    let bytesSinceCommit = 0;
    let commitSeq = 0;
    // item id → { text, final }, in the order the items were first heard of.
    const turns = new Map();
    const committed = new Set();
    // Items committed but not yet settled.
    const awaiting = new Set();
    // Our commits not yet answered, each with the audio offset it was sent at,
    // and the offset each committed item ends at.
    const pendingCommits = new Map();
    const itemEnds = new Map();
    const detector = createTurnDetector({ sampleRate: VOICE_SAMPLE_RATE });
    let finished = null;

    const connectTimer = setTimeout(
      () => fail(createMessage('chat.voice.error.connection')),
      connectTimeoutMs,
    );

    function snapshot(allFinal = false) {
      return [...turns.values()].map(({ text, final }) => ({ text, final: allFinal || final }));
    }

    /** The audio the settled turns at the front cover, in bytes. */
    function settledBytes() {
      let bytes = 0;
      for (const [id, turn] of turns) {
        if (!turn.final) break;
        if (itemEnds.has(id)) bytes = itemEnds.get(id);
      }
      return bytes;
    }

    function emit() {
      if (phase !== 'closed') onUpdate({ turns: snapshot(), settledBytes: settledBytes() });
    }

    function resolveReady(result) {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(connectTimer);
      settleReady(result);
    }

    function close() {
      if (phase === 'closed') return;
      phase = 'closed';
      clearTimeout(connectTimer);
      try { socket?.close(); } catch { /* already closing */ }
      finished?.();
    }

    function resolveStarted(result) {
      if (startSettled) return;
      startSettled = true;
      settleStarted(result);
    }

    function fail(error) {
      if (phase === 'closed') return;
      const wasStarted = startSettled;
      const wasRunning = phase === 'open';
      lastError = error;
      resolveStarted({ error });
      resolveReady({ error });
      close();
      if (wasStarted && wasRunning) onError(error);
    }

    function send(event) {
      socket.send(JSON.stringify(event));
    }

    function write(event, bytes = 0) {
      if (up) {
        send(event);
        return;
      }
      // While connecting, the oldest speech is the one worth keeping.
      if (queuedBytes + bytes > MAX_QUEUED_BYTES) return;
      queuedBytes += bytes;
      queue.push(event);
    }

    function turnFor(itemId) {
      const id = typeof itemId === 'string' ? itemId : '';
      if (!turns.has(id)) turns.set(id, { text: '', final: false });
      return turns.get(id);
    }

    function commit() {
      commitSeq += 1;
      const eventId = `snotra_commit_${commitSeq}`;
      pendingCommits.set(eventId, totalBytes);
      bytesSinceCommit = 0;
      write({ type: 'input_audio_buffer.commit', event_id: eventId });
    }

    function checkFinished() {
      if (phase === 'finishing' && pendingCommits.size === 0 && awaiting.size === 0) finished?.();
    }

    function hasOpenTurn() {
      for (const [id, turn] of turns) {
        if (!turn.final && !committed.has(id)) return true;
      }
      return false;
    }

    function onEvent(event) {
      switch (event?.type) {
        case 'session.updated':
          if (!up) {
            up = true;
            for (const queued of queue.splice(0)) send(queued);
            queuedBytes = 0;
            resolveReady({ ok: true });
          }
          return;
        case 'input_audio_buffer.committed': {
          // Answers the oldest commit; the event does not name ours.
          const [oldest] = pendingCommits;
          if (oldest) {
            pendingCommits.delete(oldest[0]);
            itemEnds.set(event.item_id, oldest[1]);
          }
          const turn = turnFor(event.item_id);
          committed.add(event.item_id);
          if (!turn.final) awaiting.add(event.item_id);
          checkFinished();
          return;
        }
        case 'conversation.item.input_audio_transcription.delta': {
          const turn = turnFor(event.item_id);
          if (turn.final || typeof event.delta !== 'string' || !event.delta) return;
          turn.text += event.delta;
          emit();
          return;
        }
        case 'conversation.item.input_audio_transcription.completed': {
          const turn = turnFor(event.item_id);
          if (typeof event.transcript === 'string') turn.text = event.transcript;
          turn.final = true;
          awaiting.delete(event.item_id);
          emit();
          checkFinished();
          return;
        }
        case 'conversation.item.input_audio_transcription.failed': {
          // What was heard of it stays; the turn just will not get better.
          turnFor(event.item_id).final = true;
          awaiting.delete(event.item_id);
          emit();
          checkFinished();
          return;
        }
        case 'error': {
          // A commit with too little audio in the buffer — a stop right after a
          // settled turn, say — is refused; nothing is lost by that.
          const causedBy = event.error?.event_id;
          if (causedBy && pendingCommits.has(causedBy)) {
            pendingCommits.delete(causedBy);
            checkFinished();
            return;
          }
          fail(apiMessage(event.error));
          return;
        }
        default:
      }
    }

    (async () => {
      const apiKey = await credentials.getApiKey(speechProviderId);
      if (phase === 'closed') return;
      if (!apiKey) {
        fail(createMessage('chat.voice.error.noApiKey'));
        return;
      }
      const language = await resolveLanguage();
      if (phase === 'closed') return;
      const WebSocketImpl = getWebSocket();
      socket = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      resolveStarted({ ok: true });
      socket.addEventListener('open', () => {
        if (phase === 'closed') return;
        send(sessionUpdate(language));
      });
      socket.addEventListener('message', (message) => {
        if (phase === 'closed') return;
        let event;
        try {
          event = JSON.parse(textOf(message.data));
        } catch {
          return;
        }
        onEvent(event);
      });
      // The browser API tells nothing about why — a refused key and a missing
      // network look the same from here.
      socket.addEventListener('close', () => fail(createMessage('chat.voice.error.connection')));
    })().catch(() => fail(createMessage('chat.voice.error.connection')));

    /** Passes 16-bit PCM on; commits when a turn ended inside it. */
    function append(bytes) {
      if (phase !== 'open' || totalBytes + bytes.byteLength > MAX_SESSION_BYTES) return;
      totalBytes += bytes.byteLength;
      // Int16Array needs an even offset; a Buffer from IPC may sit anywhere.
      const own = new Uint8Array(bytes);
      const ended = detector.push(new Int16Array(own.buffer, 0, own.byteLength >> 1));
      write({ type: 'input_audio_buffer.append', audio: Buffer.from(own.buffer).toString('base64') }, own.byteLength);
      bytesSinceCommit += own.byteLength;
      if (ended && bytesSinceCommit >= MIN_COMMIT_BYTES) commit();
    }

    /**
     * Ends the recording: commits what is still open, waits for the last turns
     * to settle — or for the timeout — and closes. Every turn comes back final;
     * one that did not settle in time keeps the words heard of it. After an
     * error the open turns stay open, and `settledBytes` says where the audio
     * no turn settled begins.
     */
    async function finish() {
      if (phase !== 'open') {
        return { turns: snapshot(!lastError), settledBytes: settledBytes(), ...(lastError ? { error: lastError } : {}) };
      }
      phase = 'finishing';
      const started = await ready;
      if (started.ok && phase === 'finishing') {
        if (bytesSinceCommit > 0 && (detector.hasSpeech() || hasOpenTurn())) commit();
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, finishTimeoutMs);
          finished = () => {
            clearTimeout(timer);
            resolve();
          };
          checkFinished();
        });
      }
      const error = lastError;
      close();
      // After a failure the open turns stay open: the fallback hears them again.
      return { turns: snapshot(!error), settledBytes: settledBytes(), ...(error ? { error } : {}) };
    }

    return { started, append, finish, cancel: close };
  }

  return { open };
}

module.exports = {
  createRealtimeTranscriptionService,
  REALTIME_TRANSCRIPTION_URL,
  TRANSCRIPTION_MODEL,
};
