export function initWhisperRecorder({
  api,
  onInputChanged,
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

  function setMicUi(recording) {
    btnChatMic.classList.toggle('recording', recording);
    btnChatMic.setAttribute('aria-pressed', recording ? 'true' : 'false');
    btnChatMic.title = recording ? 'Aufnahme stoppen' : 'Spracheingabe';
    btnChatMic.setAttribute('aria-label', recording ? 'Aufnahme stoppen' : 'Spracheingabe starten');
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
      setVoiceStatus(err.name === 'NotAllowedError' ? 'Mikrofonzugriff verweigert.' : `Mikrofon: ${err.message}`);
      return;
    }

    voiceChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    voiceMediaRecorder = new MediaRecorder(voiceStream, { mimeType });
    voiceMediaRecorder.ondataavailable = (e) => {
      if (started === generation && e.data?.size > 0) voiceChunks.push(e.data);
    };
    voiceMediaRecorder.onstop = () => handleVoiceStopped();
    voiceMediaRecorder.start(250);

    voiceRecording = true;
    setMicUi(true);
    setVoiceStatus('Aufnahme laeuft …');
  }

  function stopVoiceRecording() {
    if (!voiceRecording || !voiceMediaRecorder) return;
    voiceRecording = false;
    try { voiceMediaRecorder.stop(); } catch { /* already stopped */ }
    releaseVoiceStream();
  }

  async function handleVoiceStopped() {
    const started = generation;
    setMicUi(false);

    if (voiceChunks.length === 0) { setVoiceStatus(''); return; }
    const blob = new Blob(voiceChunks, { type: 'audio/webm' });
    voiceChunks = [];
    if (blob.size < 1000) { setVoiceStatus('Aufnahme zu kurz.'); return; }

    voiceTranscribing = true;
    btnChatMic.title = 'Transkription abbrechen';
    btnChatMic.setAttribute('aria-label', 'Transkription abbrechen');
    setVoiceStatus('Transkribiere…');

    try {
      const buf = await blob.arrayBuffer();
      if (started !== generation) return;
      const result = await api.transcribeAudio(buf);
      if (started !== generation) return;
      if (result.error) {
        setVoiceStatus(`Fehler: ${result.error}`);
      } else if (result.text?.trim()) {
        const cur = chatInput.value;
        const sep = cur && !/\s$/.test(cur) ? ' ' : '';
        chatInput.value = cur + sep + result.text.trim();
        onInputChanged();
        setVoiceStatus('');
        chatInput.focus();
      } else {
        setVoiceStatus('Keine Sprache erkannt.');
      }
    } catch (err) {
      if (started !== generation) return;
      setVoiceStatus(`Fehler: ${err.message || 'Transkription fehlgeschlagen.'}`);
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

  return { stopChatVoiceListening };
}
