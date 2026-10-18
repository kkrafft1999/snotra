'use strict';

// AR-37 (#1012): where a button sends something off the machine, its text
// names who receives it — in every language. Voice input goes to OpenAI; the
// price update goes to the host in LITELLM_PRICES_URL, not to "LiteLLM".

const test = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGES } = require('../src/shared/i18n');
const { LITELLM_PRICES_URL } = require('../src/shared/contracts/cost');
const { REALTIME_TRANSCRIPTION_URL } = require('../src/main/services/realtime-transcription-service');
const { TRANSCRIPTIONS_URL } = require('../src/main/services/whisper-service');

const PRICE_HOST = new URL(LITELLM_PRICES_URL).host;

test('the voice input is sent to OpenAI only', () => {
  assert.equal(new URL(REALTIME_TRANSCRIPTION_URL).host, 'api.openai.com');
  assert.equal(new URL(TRANSCRIPTIONS_URL).host, 'api.openai.com');
});

for (const [locale, messages] of Object.entries(MESSAGES)) {
  test(`${locale}: the mic button names OpenAI`, () => {
    assert.match(messages['chat.mic.title'], /OpenAI/);
  });

  test(`${locale}: the price update names the host it contacts`, () => {
    for (const key of [
      'settings.prices.update.title',
      'settings.prices.update.running',
      'settings.prices.update.network',
      'settings.prices.note.body',
    ]) {
      assert.ok(messages[key]?.includes(PRICE_HOST), `${key} names ${PRICE_HOST}`);
    }
  });
}
