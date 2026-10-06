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

**You write skills only into the open folder**, under
`.agents/skills/<name>/`. Use the ordinary file tools with that relative path:
`write_file_text` for a new file (missing folders are created), `edit_file` or
`apply_patch` for changes.

Everything else is read-only for you, with no way around it:

- the global skills in `~/.snotra/skills/` and `~/.agents/skills/`,
- the system skills built into Snotra, this one included.

Do not try to reach them with `shell_execute` or `run_python` either — that is
going around a line the user drew, not a workaround.

**No folder open:** you cannot write a skill. Say so and offer the complete
`SKILL.md` in the chat instead.

**Global skills.** A skill in the open folder applies to that folder only. If
the user wants it everywhere, tell them to move the folder
`.agents/skills/<name>` to `~/.snotra/skills/<name>` themselves — then it is
available in every folder. You do not move it.

**Changing a global skill.** You cannot edit it in place. Offer to write the
changed version into the open folder under the same name: there it takes
precedence over the global one, the user can try it, and moves it back over the
global folder when it is right. Say that this is what will happen.

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
