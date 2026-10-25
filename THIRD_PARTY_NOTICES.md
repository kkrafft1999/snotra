# Third-party notices

Snotra ships the following third-party material in addition to its npm
dependencies, whose licences come with them in `node_modules`.

## LiteLLM model price table

- **What:** `src/main/data/model-prices.json`, a reduced copy of
  `model_prices_and_context_window.json` (chat models of OpenAI, Anthropic and
  Google, input/output/cache/reasoning prices only), used for the estimated
  chat cost (#949). Renewed with `node scripts/update-model-prices.js`.
- **Source:** https://github.com/BerriAI/litellm
- **Licence:** MIT, Copyright (c) 2023 Berri AI. The full text ships next to
  the data in `src/main/data/model-prices-LICENSE.txt`.

## EFF short word list 2.0

- **What:** `src/shared/contracts/remote/safety-words-v1.json`, the 1,296 words
  of the mobile remote's safety phrase (docs/remote/remote-protocol.md §7, #1116).
  The dice numbers were dropped; order and spelling are as published.
- **Source:** https://www.eff.org/dice
- **Licence:** CC BY 3.0 US, Electronic Frontier Foundation. Attribution and
  licence link ship next to the data in
  `src/shared/contracts/remote/safety-words-v1-LICENSE.txt`.

## Inter

- **What:** the UI font in `src/renderer/vendor/fonts/`.
- **Licence:** SIL Open Font License 1.1, see
  `src/renderer/vendor/fonts/inter-LICENSE.txt`.
