const { withRequestTimeout, userMessageOf, TRANSCRIPTION_TIMEOUT_MS } = require('./request-timeout');
const { createMessage } = require('../../shared/contracts/message');
const { checkTranscriptionPayload } = require('../../shared/contracts/voice');
const { readErrorMessage } = require('../providers/stream-helpers');
const { describeFetchErrorMessage } = require('../../shared/runtime/fetch-errors');

const TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** The bytes of an ArrayBuffer or of any view on one — not its element values (#541). */
function bytesOf(payload) {
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return Buffer.from(payload);
}

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
    // The renderer stops long before this; checked again because the payload
    // crossed IPC and would otherwise be copied twice before Whisper refuses it (#76).
    const checked = checkTranscriptionPayload(audioBuffer);
    if (checked.error) return { error: checked.error };
    try {
      return await withRequestTimeout((signal) => transcribeRequest(audioBuffer, { ...options, signal }), {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS,
      });
    } catch (err) {
      return { error: userMessageOf(err) };
    }
  }

  // Errors travel as keys (#310), put into words by the voice input; what the
  // API or the network said is quoted as it stands.
  async function transcribeRequest(audioBuffer, options) {
    const apiKey = await credentials.getApiKey(speechProviderId);
    if (!apiKey) {
      return { error: createMessage('chat.voice.error.noApiKey') };
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
    const fileBuf = bytesOf(audioBuffer);
    const body = Buffer.concat([textParts, fileHeader, fileBuf, fileFooter]);

    let res;
    try {
      res = await fetchFn(TRANSCRIPTIONS_URL, {
        method: 'POST',
        signal: options.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
    } catch (err) {
      // The same words as for a chat that cannot reach its provider (#541).
      return { error: describeFetchErrorMessage(err) };
    }
    if (!res.ok) return { error: await readErrorMessage(res) };
    const json = await res.json().catch(() => null);
    if (!json) return { error: createMessage('chat.voice.failed') };
    return { text: json.text || '' };
  }

  return {
    transcribeAudio,
  };
}

module.exports = {
  createWhisperService,
};
