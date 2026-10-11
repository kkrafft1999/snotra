import { onLocaleChange, t, tMessage } from '../i18n.js';
import contracts from '../generated/contracts.js';
import { createDictationField } from './DictationField.js';
import { openMicrophone } from './microphone-capture.js';
import { encodeWav } from './wav.js';

// Every minute is billed, and a forgotten microphone would keep streaming.
const DEFAULT_LIMITS = Object.freeze({
  maxMs: contracts.MAX_VOICE_RECORDING_MS,
  warnMs: contracts.VOICE_STOP_WARNING_MS,
});
// Cmd/Ctrl+D held down repeats; the recording would flicker on and off.
const SHORTCUT_REPEAT_MS = 400;
// Less than this after the last settled turn is not worth a Whisper request.
const MIN_FALLBACK_BYTES = contracts.VOICE_SAMPLE_RATE * 2 * 0.3;

const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent ?? '');

/** The loudness of a chunk as a share of the meter, on a decibel scale. */
function meterShare(level) {
  const db = 20 * Math.log10(Math.max(level, 1e-5));
  return Math.max(0, Math.min(1, (db + 50) / 40));
}

function formatClock(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Voice input in the chat (#859): the microphone button, Cmd/Ctrl+D, and the
 * live transcript in the input field.
 *
 * A recording is 'starting' while main looks for the key, 'recording' while
 * the microphone streams, 'finishing' while the last turn is settled after
 * the stop. The text so far stays in the field whatever ends the recording —
 * a stop, an error, a cancel, the window being hidden.
 *
 * The fallback: the recording keeps its audio. When the live transcription
 * cannot be reached or drops out, recording goes on without live text, and at
 * the stop the audio no settled turn covers goes to Whisper in one piece; its
 * text joins the settled turns. Without an OpenAI key there is no fallback —
 * Whisper needs the same key.
 */
export function initVoiceRecorder({
  api,
  onInputChanged,
  limits = DEFAULT_LIMITS,
  openMic = openMicrophone,
  isMac = isMacPlatform(),
}) {
  const btnChatMic = document.getElementById('btn-chat-mic');
  const chatVoiceStatus = document.getElementById('chat-voice-status');
  const meter = document.getElementById('chat-voice-level');
  const clock = document.getElementById('chat-voice-time');
  const bar = btnChatMic.closest('.chat-composer-bar');
  const chatInput = document.getElementById('chat-input');
  const field = createDictationField({
    input: chatInput,
    mirror: document.getElementById('chat-input-mirror'),
    onInputChanged,
  });

  let generation = 0;
  let phase = 'idle';
  let mic = null;
  let limitTimers = [];
  let clockTimer = null;
  let startedAt = 0;
  // Why the last recording ended on its own — shown once the text is in.
  let autoStopNotice = '';
  let lastShortcut = -Infinity;
  // The recording's audio, how much of it the settled turns cover, and why
  // live text failed — null while it works.
  let audio = [];
  let settledBytes = 0;
  let fallbackReason = null;

  btnChatMic.setAttribute('aria-keyshortcuts', isMac ? 'Meta+D' : 'Control+D');

  function micTitle(key) {
    return t('chat.mic.withShortcut', {
      action: t(key),
      shortcut: t(isMac ? 'chat.mic.shortcut.mac' : 'chat.mic.shortcut.other'),
    });
  }

  function setMicUi(recording) {
    btnChatMic.classList.toggle('recording', recording);
    btnChatMic.setAttribute('aria-pressed', recording ? 'true' : 'false');
    btnChatMic.title = micTitle(recording ? 'chat.mic.stop' : 'chat.mic.title');
    btnChatMic.setAttribute('aria-label', t(recording ? 'chat.mic.stop' : 'chat.mic.label'));
  }

  function setFinishingUi() {
    btnChatMic.title = micTitle('chat.mic.cancel');
    btnChatMic.setAttribute('aria-label', t('chat.mic.cancel'));
  }

  function setVoiceStatus(text) {
    chatVoiceStatus.textContent = text || '';
    chatVoiceStatus.classList.toggle('hidden', !text);
  }

  // The level and the clock sit outside the status line: it is a live region,
  // and a figure changing every second would be read out every second.
  function showMeter(visible) {
    meter.classList.toggle('hidden', !visible);
    clock.classList.toggle('hidden', !visible);
    if (visible) {
      meter.style.setProperty('--voice-level', '0');
      clock.textContent = formatClock(0);
    }
  }

  function startClock() {
    startedAt = Date.now();
    clockTimer = setInterval(() => {
      clock.textContent = formatClock(Date.now() - startedAt);
    }, 1000);
  }

  function clearTimers() {
    for (const timer of limitTimers) clearTimeout(timer);
    limitTimers = [];
    clearInterval(clockTimer);
    clockTimer = null;
  }

  function releaseMic() {
    mic?.stop();
    mic = null;
  }

  /** Back to idle; whatever was dictated stays in the field as plain text. */
  function settle(status) {
    clearTimers();
    releaseMic();
    audio = [];
    const said = field.end();
    phase = 'idle';
    setMicUi(false);
    showMeter(false);
    delete bar.dataset.dictating;
    setVoiceStatus(status);
    return said;
  }

  /** Ends a recording that went wrong; main drops its side as well. */
  function abandon(status) {
    generation += 1;
    void api.cancelVoice?.().catch(() => {});
    if (fallbackReason) void api.cancelTranscription?.().catch(() => {});
    settle(status);
  }

  async function start() {
    if (phase !== 'idle') return;
    const id = ++generation;
    phase = 'starting';
    autoStopNotice = '';
    audio = [];
    settledBytes = 0;
    fallbackReason = null;
    setVoiceStatus('');
    // Main answers as soon as it has a key. Without one the microphone stays
    // shut — no permission prompt for a recording that cannot work.
    let started;
    try {
      started = await api.startVoice(id);
    } catch (err) {
      started = { error: err?.message || t('chat.voice.failed') };
    }
    if (id !== generation) return;
    if (started?.error) {
      phase = 'idle';
      setVoiceStatus(t('chat.voice.error', { error: tMessage(started.error) }));
      return;
    }

    let opened;
    try {
      opened = await openMic({
        onChunk: (pcm, level) => {
          if (id !== generation || phase !== 'recording') return;
          audio.push(pcm);
          if (!fallbackReason) api.sendVoiceAudio(id, pcm);
          meter.style.setProperty('--voice-level', meterShare(level).toFixed(2));
        },
      });
    } catch (err) {
      if (id !== generation) return;
      generation += 1;
      void api.cancelVoice?.().catch(() => {});
      phase = 'idle';
      setVoiceStatus(err?.name === 'NotAllowedError'
        ? t('chat.voice.micDenied')
        : t('chat.voice.micFailed', { error: err?.message || '' }));
      return;
    }
    if (id !== generation) {
      opened.stop();
      return;
    }
    mic = opened;
    phase = 'recording';
    field.begin();
    bar.dataset.dictating = 'true';
    setMicUi(true);
    showMeter(true);
    setVoiceStatus(t('chat.voice.recording'));
    startClock();
    // Said once rather than counted down: the status line is a live region.
    limitTimers = [
      setTimeout(() => {
        if (id === generation && phase === 'recording') {
          setVoiceStatus(t('chat.voice.stoppingSoon', { seconds: Math.round(limits.warnMs / 1000) }));
        }
      }, Math.max(0, limits.maxMs - limits.warnMs)),
      setTimeout(() => {
        if (id !== generation || phase !== 'recording') return;
        autoStopNotice = t('chat.voice.autoStopped.time', { minutes: Math.round(limits.maxMs / 60000) });
        void stop();
      }, limits.maxMs),
    ];
  }

  async function stop() {
    if (phase !== 'recording') return;
    const id = generation;
    phase = 'finishing';
    clearTimers();
    releaseMic();
    setMicUi(false);
    setFinishingUi();
    showMeter(false);
    if (!fallbackReason) {
      setVoiceStatus(t('chat.voice.finishing'));
      let result;
      try {
        result = await api.stopVoice(id);
      } catch (err) {
        result = { turns: [], settledBytes, error: err?.message || t('chat.voice.failed') };
      }
      if (id !== generation) return;
      // The answer carries every turn; it supersedes what was pushed.
      field.update(result?.turns);
      if (result?.error) {
        settledBytes = Number.isFinite(result.settledBytes) ? result.settledBytes : settledBytes;
        fallbackReason = result.error;
        field.dropLive();
      }
    }
    let error = null;
    if (fallbackReason) error = await transcribeRest(id);
    if (id !== generation) return;
    const said = settle('');
    if (error) setVoiceStatus(t('chat.voice.error', { error: tMessage(error) }));
    else if (fallbackReason) setVoiceStatus(t('chat.voice.fallback.done', { reason: tMessage(fallbackReason) }));
    else setVoiceStatus(said ? autoStopNotice : t('chat.voice.noSpeech'));
    if (said) chatInput.focus();
  }

  /** The fallback: what no settled turn covers, to Whisper. Returns an error or null. */
  async function transcribeRest(id) {
    const total = audio.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (total - settledBytes < MIN_FALLBACK_BYTES) return null;
    setVoiceStatus(t('chat.voice.fallback.transcribing'));
    const wav = encodeWav(audio, settledBytes, contracts.VOICE_SAMPLE_RATE);
    audio = [];
    let result;
    try {
      result = await api.transcribeAudio(wav);
    } catch (err) {
      result = { error: err?.message || t('chat.voice.failed') };
    }
    if (id !== generation) return null;
    if (result?.error) return result.error;
    field.appendSettled(result?.text);
    return null;
  }

  /** Live text failed while recording: go on without it. */
  function fallBack(reason) {
    fallbackReason = reason;
    field.dropLive();
    setVoiceStatus(t('chat.voice.fallback'));
  }

  /** Ends any recording at once — sending, another chat, a hidden window. */
  function stopChatVoiceListening() {
    if (phase === 'idle') {
      setVoiceStatus('');
      return;
    }
    abandon('');
  }

  function toggle() {
    if (btnChatMic.disabled) return;
    if (phase === 'recording') void stop();
    else if (phase === 'idle') void start();
    // Still waiting for the microphone, or for the last turn: a second press
    // gives up on it.
    else stopChatVoiceListening();
  }

  api.onVoiceTranscript?.((payload) => {
    if (payload?.id !== generation || phase !== 'recording' || fallbackReason) return;
    if (payload.error) {
      fallBack(payload.error);
      return;
    }
    if (Number.isFinite(payload.settledBytes)) settledBytes = payload.settledBytes;
    field.update(payload.turns);
  });

  api.onToggleVoiceInput?.(() => {
    const now = Date.now();
    if (now - lastShortcut < SHORTCUT_REPEAT_MS) return;
    lastShortcut = now;
    toggle();
  });

  btnChatMic.addEventListener('click', toggle);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopChatVoiceListening();
  });

  // The button speaks the language of the interface (#310).
  onLocaleChange(() => {
    if (phase === 'finishing') setFinishingUi();
    else setMicUi(phase === 'recording');
  });
  setMicUi(false);

  return { stopChatVoiceListening, toggle };
}
