---
name: snotra-skill-authoring
description: How to write or change a skill — where it goes (.agents/skills/<name>/ in the open folder), folder layout, front matter, a description that makes it fire, and how it becomes global. Use when the user asks you to create, build, extend or fix a skill, or to turn a way of working into one ("make a skill for this", "add X to the skill", "bau mir einen Skill").
license: Apache-2.0
metadata:
  snotra-system-skill: 'true'
---

# Writing skills

A skill is a folder with a `SKILL.md`: YAML front matter with `name` and
`description`, then instructions in Markdown. The description of every
switched-on skill is part of the system prompt; the instructions are fetched
with `load_skill` once the description matches the task.

## Where a skill goes

**Two ways to write a skill.**

- **A skill of one `SKILL.md`** — a procedure in steps — goes through the tool
  `remember` with `kind: "instruction"`: `topic` is the skill's name,
  `description` says what it is for and when to use it, and `body` is the whole
  skill as it should read. `scope: "workspace"` writes
  `.agents/skills/<name>/SKILL.md` in the open folder, `scope: "user"` writes
  `~/.snotra/skills/<name>/SKILL.md` for every folder. It is always a **whole
  version**: to change a skill, send the complete new text — it replaces the
  old one, and the user sees the diff on the card. There is no `team` reader
  for a skill. Ask the user which folder it is for before the call.
- **A skill of several files** — `references/`, `scripts/`, `assets/` — only
  in the open folder, under `.agents/skills/<name>/`, with the ordinary file
  tools: `write_file_text` for a new file (missing folders are created),
  `edit_file` or `apply_patch` for changes. Every such write asks the user on a
  card.

Read-only for the file tools, with no way around it:

- the global skills in `~/.snotra/skills/` and `~/.agents/skills/` — `remember`
  is the one way to write `~/.snotra/skills/`, and `~/.agents/skills/` is never
  written,
- the system skills built into Snotra, this one included; names beginning with
  `snotra-` are theirs.

Do not try to reach them with `shell_execute` or `run_python` either — that is
going around a line the user drew, not a workaround.

**No folder open:** only a global one-file skill through `remember`; for
anything else offer the complete `SKILL.md` in the chat.

A new skill applies once the user switches it on under **{menu:settings.skills}**;
say so after writing one.

## Folder layout

```
.agents/skills/<name>/
├── SKILL.md          required — the instructions
├── references/       optional — longer material, read only when needed
├── scripts/          optional — code the instructions tell you to run
└── assets/           optional — templates, sample files
```

Keep `SKILL.md` focused on what to do; move long reference tables, specs and
examples into `references/` and say in `SKILL.md` when to read which file.
Once the skill is switched on, its files are read with `skill:<name>/…`, for
example `skill:<name>/references/api.md`. Anything over 20,000 characters in
the body of `SKILL.md` is cut off.

What a skill **produces** while it runs — notes, caches, state — never goes
into its own folder. It goes to `.agents/data/` in the open folder.

## Front matter

```yaml
---
name: release-notes
description: Writes release notes from the merged pull requests since the last tag, grouped by area. Use when the user asks for release notes, a changelog or "what changed since vX".
---
```

- **`name`** — exactly the folder name. Letters, digits, `.`, `_` and `-`,
  starting with a letter or digit, at most 64 characters. Prefer lowercase
  words joined by hyphens. Do not start a name with `snotra-`: that prefix
  belongs to the built-in skills, and a built-in skill of the same name always
  wins.
- **`description`** — decides whether the skill is ever used. Say **what** it
  does and **when** to use it, with the phrases the user would actually say,
  in the languages they use. One to three sentences, at most about 1,000
  characters. A description that only names the topic ("Release notes") does
  not fire.
- Other keys (`license`, `metadata`) are allowed and ignored.

Ask about the name if the user did not give one and it is not obvious, and
before you overwrite a skill that already exists in the folder.

## The body

Write instructions, not an essay: imperative steps in the order they happen,
the decisions with their criteria, what to do when something fails, and what
not to do. Concrete examples beat abstract rules. Leave out what any capable
model already knows.

## After writing

The result of every write to `.agents/skills/<name>/SKILL.md` carries a
`skill_check`:

- **`valid: false`** — the catalog skips the skill; `problem` says why
  (missing front matter, missing `name` or `description`, invalid name, name
  not equal to the folder). Fix it right away, before you answer.
- **`valid: true`** — the skill is in the catalog. Skills from a folder start
  **switched off**: tell the user to tick it under
  **{menu:settings.skills}**, unless it is on already. Until then it is not in
  your system prompt, so do not claim it is in use.

Then sum up in a sentence or two what the skill does and when it will fire —
not the whole file again.
