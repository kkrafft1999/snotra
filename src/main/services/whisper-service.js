const { withRequestTimeout, TRANSCRIPTION_TIMEOUT_MS } = require('./request-timeout');

function createWhisperService({ fetchImpl, credentials, speechProviderId = 'openai', getAppLocale }) {
  const fetchFn = fetchImpl;

  async function resolveLanguage(options) {
    if (options?.language === 'de' || options?.language === 'en') return options.language;
    if (getAppLocale) {
      const locale = await getAppLocale();
      return locale === 'en' ? 'en' : 'de';
    }
    return 'de';
  }

  async function transcribeAudio(audioBuffer, options) {
    try {
      return await withRequestTimeout((signal) => transcribeRequest(audioBuffer, { ...options, signal }), {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS,
      });
    } catch (err) {
      return { error: err.message };
    }
  }

  async function transcribeRequest(audioBuffer, options) {
    const apiKey = await credentials.getApiKey(speechProviderId);
    if (!apiKey) {
      return { error: 'Kein OpenAI-Key hinterlegt (Whisper benötigt einen).' };
    }

    const language = await resolveLanguage(options);
    const boundary = `----ElectronWhisper${Date.now()}`;
    const fileName = 'voice.webm';

    const fieldParts = [];
    fieldParts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`
    );
    fieldParts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`
    );
    fieldParts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`
    );
    const fileHeader = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/webm\r\n\r\n`
    );
    const fileFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
    const textParts = Buffer.from(fieldParts.join(''));
    const fileBuf = Buffer.from(audioBuffer);
    const body = Buffer.concat([textParts, fileHeader, fileBuf, fileFooter]);

    try {
      const res = await fetchFn('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        signal: options.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let msg = res.statusText;
        try {
          const j = JSON.parse(errText);
          msg = j.error?.message || msg;
        } catch { /* ignore */ }
        return { error: msg };
      }
      const json = await res.json();
      return { text: json.text || '' };
    } catch (err) {
      return { error: err.message || 'Transkription fehlgeschlagen.' };
    }
  }

  return {
    transcribeAudio,
  };
}

module.exports = {
  createWhisperService,
};
