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

## Inter

- **What:** the UI font in `src/renderer/vendor/fonts/`.
- **Licence:** SIL Open Font License 1.1, see
  `src/renderer/vendor/fonts/inter-LICENSE.txt`.
