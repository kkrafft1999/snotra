# Snotra Agent user manual

The user manual for Snotra Agent, built with [Starlight](https://starlight.astro.build/)
and published at **https://docs.snotra-ai.dev** on every release tag
(`.github/workflows/manual.yml`). Background and decisions: #777.

This is a package of its own: its dependencies do not touch the app's, and the
app's tests do not build it.

## Working on it

```sh
cd manual
npm ci
npm run dev      # http://localhost:4321, German under /de/
npm run build    # content check + static site in dist/
npm run screenshots              # regenerate every screenshot
npm run screenshots -- overview  # only the motifs named
```

Astro keeps rendered pages in `.astro/` and does not notice a change to a
plugin in `src/plugins/`. After editing one, delete `.astro/` and restart the
dev server.

Set `ASTRO_TELEMETRY_DISABLED=1` in your shell to keep Astro from sending usage
data; the workflow does.

## Rules for the content

- **English and German, always both.** Every page under `src/content/docs/`
  has its German counterpart at the same path under `src/content/docs/de/`.
  `npm run check:content` (part of `build`) fails otherwise. German
  addresses the reader as *du*.
- **Plain Markdown only** (`.md`, no MDX). The same files are meant to be shown
  inside the app later, rendered by Snotra's own Markdown preview.
- **"Since" markers:** a feature from the last few releases gets
  `[since 1.16]` (German pages: `[seit 1.16]`) where it is introduced. The
  build turns it into a small badge; elsewhere it reads as plain text.
- **Version:** the header shows the version from the app's `package.json`. The
  site is only deployed from release tags, so that is the released version.

## Screenshots

Screenshots are generated, never taken by hand: `scripts/screenshots.mjs`
starts the real app on a copy of `demo-workspace/<lang>/` against the fake
model from `e2e/helpers/`, and writes every motif in four variants —
`public/screenshots/<motif>.<lang>.<theme>.webp`, English and German, light
and dark, 1280×800 at scale 2. The files are committed; the site build does
not run the app.

A page shows a motif as plain Markdown, without language or theme:

```md
![What the reader sees in the picture.](screenshots/overview.webp)
```

`src/plugins/remark-screenshots.mjs` picks the page's language and puts in
both themes; the one that does not match the reader's theme is hidden.
`check:content` fails when a variant is missing.

To add a motif, add an entry to `MOTIFS` in `scripts/screenshots.mjs`: the
texts per language and a `setUp` that brings the app into the state to shoot.
`setUp` returns the area to shoot, or `null` for the whole window; crop to a
dialog or a menu when the whole window would shrink its text below what a page
shows legibly. `profile: 'fresh'` starts the app as it is right after
installing — no folder, no model — instead of on the demo project; `prefs`
adds entries to `ui-preferences.json`, to switch a tool on or widen the chat
column; `configure(config)` changes `llm-config.json` before the start, to
add model entries.
Running the script needs the app's dependencies (`npm ci` at the repository
root). The demo project must stay free of anything personal.

## Look

Colours and fonts come from the app's design tokens
(`src/renderer/styles/tokens.css`), mapped onto Starlight's colour roles in
`src/styles/theme.css`. Change a token there, not here.
