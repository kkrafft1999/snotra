# Snotra AI user manual

The user manual for Snotra AI, built with [Starlight](https://starlight.astro.build/)
and published at **https://docs.snotra-ai.dev** on every release tag
(`.github/workflows/manual.yml`). Background and decisions: #777.

This is a package of its own: its dependencies do not touch the app's, and the
app's tests do not build it.

## Working on it

```sh
cd manual
npm ci
npm run dev      # http://localhost:4321, German under /de/
npm run build    # translation check + static site in dist/
```

Set `ASTRO_TELEMETRY_DISABLED=1` in your shell to keep Astro from sending usage
data; the workflow does.

## Rules for the content

- **English and German, always both.** Every page under `src/content/docs/`
  has its German counterpart at the same path under `src/content/docs/de/`.
  `npm run check:translations` (part of `build`) fails otherwise. German
  addresses the reader as *du*.
- **Plain Markdown only** (`.md`, no MDX). The same files are meant to be shown
  inside the app later, rendered by Snotra's own Markdown preview.
- **"Since" markers:** a feature from the last few releases gets
  `[since 1.16]` (German pages: `[seit 1.16]`) where it is introduced. The
  build turns it into a small badge; elsewhere it reads as plain text.
- **Version:** the header shows the version from the app's `package.json`. The
  site is only deployed from release tags, so that is the released version.

## Look

Colours and fonts come from the app's design tokens
(`src/renderer/styles/tokens.css`), mapped onto Starlight's colour roles in
`src/styles/theme.css`. Change a token there, not here.
