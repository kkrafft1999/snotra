import { onLocaleChange, t, tMessage } from '../i18n.js';
import contracts from '../generated/contracts.js';

// A recording is buffered in full until it stops (#76); these keep a forgotten
// microphone from filling memory and running into Whisper's 25 MB limit.
const DEFAULT_LIMITS = Object.freeze({
  maxMs: contracts.MAX_VOICE_RECORDING_MS,
  maxBytes: contracts.MAX_VOICE_RECORDING_BYTES,
  warnMs: contracts.VOICE_STOP_WARNING_MS,
});

export function initWhisperRecorder({
  api,
  onInputChanged,
  limits = DEFAULT_LIMITS,
}) {
  const btnChatMic = document.getElementById('btn-chat-mic');
  const chatVoiceStatus = document.getElementById('chat-voice-status');
  const chatInput = document.getElementById('chat-input');

  // Aufnahme-State lebt komplett in diesem Component — kein anderer Code
  // liest oder schreibt ihn.
  let generation = 0;
  let voiceRecording = false;
  let voiceTranscribing = false;
  let voiceMediaRecorder = null;
  let voiceChunks = [];
  let voiceStream = null;
  let voiceBytes = 0;
  let limitTimers = [];
  // Why the last recording ended on its own — shown once the text is in.
  let autoStopNotice = '';

  function setMicUi(recording) {
    btnChatMic.classList.toggle('recording', recording);
    btnChatMic.setAttribute('aria-pressed', recording ? 'true' : 'false');
    btnChatMic.title = t(recording ? 'chat.mic.stop' : 'chat.mic.title');
    btnChatMic.setAttribute('aria-label', t(recording ? 'chat.mic.stop' : 'chat.mic.label'));
  }

  function setTranscribingUi() {
    btnChatMic.title = t('chat.mic.cancel');
    btnChatMic.setAttribute('aria-label', t('chat.mic.cancel'));
  }

  function setVoiceStatus(text) {
    if (text) {
      chatVoiceStatus.textContent = text;
      chatVoiceStatus.classList.remove('hidden');
    } else {
      chatVoiceStatus.textContent = '';
      chatVoiceStatus.classList.add('hidden');
    }
  }

  function clearLimitTimers() {
    for (const timer of limitTimers) clearTimeout(timer);
    limitTimers = [];
  }

  function stopAtLimit(notice) {
    if (!voiceRecording) return;
    autoStopNotice = notice;
    stopVoiceRecording();
  }

  function releaseVoiceStream() {
    if (voiceStream) {
      for (const track of voiceStream.getTracks()) track.stop();
      voiceStream = null;
    }
  }

  async function startVoiceRecording() {
    if (voiceRecording || voiceTranscribing) return;
    const started = ++generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (started !== generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      voiceStream = stream;
    } catch (err) {
      if (started !== generation) return;
      setVoiceStatus(err.name === 'NotAllowedError'
        ? t('chat.voice.micDenied')
        : t('chat.voice.micFailed', { error: err.message }));
      return;
    }

    voiceChunks = [];
    voiceBytes = 0;
    autoStopNotice = '';
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    voiceMediaRecorder = new MediaRecorder(voiceStream, { mimeType });
    voiceMediaRecorder.ondataavailable = (e) => {
      if (started !== generation || !(e.data?.size > 0)) return;
      voiceChunks.push(e.data);
      voiceBytes += e.data.size;
      if (voiceBytes >= limits.maxBytes) {
        stopAtLimit(t('chat.voice.autoStopped.size', { max: Math.round(limits.maxBytes / (1024 * 1024)) }));
      }
    };
    voiceMediaRecorder.onstop = () => handleVoiceStopped();
    voiceMediaRecorder.start(250);

    voiceRecording = true;
    setMicUi(true);
    setVoiceStatus(t('chat.voice.recording'));

    // Said once rather than counted down: the status line is a live region,
    // and a ticking number would be read out every second.
    limitTimers = [
      setTimeout(() => {
        if (started === generation && voiceRecording) {
          setVoiceStatus(t('chat.voice.stoppingSoon', { seconds: Math.round(limits.warnMs / 1000) }));
        }
      }, Math.max(0, limits.maxMs - limits.warnMs)),
      setTimeout(() => {
        if (started === generation) {
          stopAtLimit(t('chat.voice.autoStopped.time', { minutes: Math.round(limits.maxMs / 60000) }));
        }
      }, limits.maxMs),
    ];
  }

  function stopVoiceRecording() {
    if (!voiceRecording || !voiceMediaRecorder) return;
    voiceRecording = false;
    clearLimitTimers();
    try { voiceMediaRecorder.stop(); } catch { /* already stopped */ }
    releaseVoiceStream();
  }

  async function handleVoiceStopped() {
    const started = generation;
    setMicUi(false);

    if (voiceChunks.length === 0) { setVoiceStatus(''); return; }
    const blob = new Blob(voiceChunks, { type: 'audio/webm' });
    voiceChunks = [];
    if (blob.size < 1000) { setVoiceStatus(t('chat.voice.tooShort')); return; }

    voiceTranscribing = true;
    setTranscribingUi();
    setVoiceStatus(t('chat.voice.transcribing'));

    try {
      const buf = await blob.arrayBuffer();
      if (started !== generation) return;
      const result = await api.transcribeAudio(buf);
      if (started !== generation) return;
      if (result.error) {
        setVoiceStatus(t('chat.voice.error', { error: tMessage(result.error) }));
      } else if (result.text?.trim()) {
        const cur = chatInput.value;
        const sep = cur && !/\s$/.test(cur) ? ' ' : '';
        chatInput.value = cur + sep + result.text.trim();
        onInputChanged();
        setVoiceStatus(autoStopNotice);
        chatInput.focus();
      } else {
        setVoiceStatus(t('chat.voice.noSpeech'));
      }
    } catch (err) {
      if (started !== generation) return;
      setVoiceStatus(t('chat.voice.error', { error: err.message || t('chat.voice.failed') }));
    } finally {
      if (started === generation) {
        voiceTranscribing = false;
        setMicUi(false);
      }
    }
  }

  function stopChatVoiceListening() {
    generation += 1;
    voiceChunks = [];
    autoStopNotice = '';
    clearLimitTimers();
    if (voiceMediaRecorder) voiceMediaRecorder.onstop = null;
    void api.cancelTranscription?.().catch(() => {});
    voiceTranscribing = false;
    if (voiceRecording) stopVoiceRecording();
    releaseVoiceStream();
    setMicUi(false);
    if (!voiceTranscribing) setVoiceStatus('');
  }

  btnChatMic.addEventListener('click', () => {
    if (btnChatMic.disabled) return;
    if (voiceTranscribing) {
      stopChatVoiceListening();
    } else if (voiceRecording) {
      stopVoiceRecording();
    } else {
      startVoiceRecording();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopChatVoiceListening();
  });

  // The button speaks the language of the interface (#310). A status line left
  // standing belongs to an attempt already over; the next one is in the new
  // language anyway.
  onLocaleChange(() => {
    if (voiceTranscribing) setTranscribingUi();
    else setMicUi(voiceRecording);
  });

  return { stopChatVoiceListening };
}
