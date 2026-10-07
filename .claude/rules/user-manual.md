# The user manual is part of the change

Convention from 2026-10-07 (issue #780, epic #777).

The user manual lives in [`manual/`](../../manual/) and is published at
https://docs.snotra-ai.dev on every release tag. It only stays useful if it
moves with the app, so it is updated where the app changes — in the same pull
request — and not in a catch-up round before a release.

## When a pull request has to touch it

A pull request that changes **what a user can see or do** updates the matching
manual page, in English and German, in the same pull request: a new feature, a
changed label or menu path, a new setting, a different default, a new state of
a dialog, a changed limit.

When nothing in the manual is affected — a fix that restores the documented
behaviour, an internal refactoring, a log line — the pull request says so: the
template's box *User manual not affected — because:* ticked, with the reason in
half a sentence.

While the chapters of #777 are still being written, a change in an area that
has no chapter yet needs no page; tick *not affected* and name the missing
chapter. The chapter issue picks it up.

## How it is written

- **Task first.** A page answers a question the reader has: "Connect a
  provider", "Why does Snotra ask before writing?". Its sections run *What you
  need → Steps → What happens → If it doesn't work*. Where the *why* matters —
  safety, permissions — a short explanation page sits next to the tasks.
  Shortcuts, files and settings go into the reference part, as tables.
- **Both languages, same content.** English is the source, German is derived
  and just as complete; German addresses the reader as *du*. `npm run build`
  in `manual/` fails on a page that exists in only one language.
- **Plain Markdown only** — `.md`, no MDX, no components. The same files are
  meant to be shown inside the app later.
- **Menu paths in one notation:** *Settings › Tools & security*, in italics,
  with `›` between the steps, in the words the app shows in that language.
- **Link the setting.** A page names and links the settings it is about; those
  links are where the in-app help will land later.
- **Mark what is new:** `[since 1.17]` / `[seit 1.17]` where a feature from the
  last few releases is introduced.

## Screenshots

Screenshots are generated, never taken by hand: `npm run screenshots` in
`manual/` (see [`manual/README.md`](../../manual/README.md)). A pull request
that changes what an existing motif shows regenerates that motif; a new motif
is added to the script, not pasted in as an image. Every screenshot exists in
four variants — English and German, light and dark — and the build fails
without them.

## Before a release

The [`release` skill](../skills/release/SKILL.md) runs
`node scripts/manual-upkeep-report.js` before it tags. The report lists pull
requests since the last release that changed user-visible code with neither a
manual change nor the *not affected* box, and those that changed the UI. It
does not block the release; it makes sure nothing slipped through unnoticed.

Related rules: [`language.md`](./language.md) for which texts are bilingual,
[`git-workflow.md`](./git-workflow.md) for what a pull request carries.
