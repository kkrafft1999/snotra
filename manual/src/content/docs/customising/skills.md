---
title: Use skills
description: Switch on a skill for a way of working, call one for a single chat with /name, and let Snotra suggest the right one.
sidebar:
  order: 5
---

A skill tells the model how to do a particular kind of task: write a meeting protocol, review code by your team's rules, advise on what to sow. It is a folder with a `SKILL.md` in the open [Agent Skills format](https://agentskills.io/specification) — so skills written for other agents work in Snotra too.

## What you need

A skill. Snotra ships three; the others come from you or from a project.

## Where skills come from

| Source | Folder | On by default |
| --- | --- | --- |
| System skills | built into the app | yes |
| The open folder | `.agents/skills/<name>/` | no |
| Your own | `~/.snotra/skills/<name>/` | no |
| Your own, older place | `~/.agents/skills/<name>/` | no |

The three system skills let Snotra answer questions about itself (`snotra-capabilities`), remember things (`snotra-memory`) and write skills (`snotra-skill-authoring`). Folders of other tools, such as `.claude/`, are not read.

## Switch a skill on

1. Open *Settings › Skills*.
2. Tick the skills you want. They are grouped by where they come from.
3. Click *Apply*.

![Settings › Skills: the choice "Suggestions in the chat", the button "Reload skills", the three system skills ticked, and below them the skill sowing-advice from the folder's .agents/skills, not ticked.](screenshots/skills-settings.webp)

A skill from a folder is never on by itself: it is someone else's content, so switching it on is your decision — and it applies to that folder only. Ticking a `review` skill in one project does not switch on a `review` skill in the next.

## Make a skill of the folder global

[since 1.22] A skill you wrote in one project, and now want in every folder, does not have to be moved by hand.

1. Open [*Settings › Skills*](#switch-a-skill-on) and click the skill under *Folder · .agents/skills* to unfold it.
2. Click *Make global…* below its path.
3. Snotra asks first and names both folders: where the skill is now, in `.agents/skills/` of the open folder, and where it goes, `~/.snotra/skills/`. Click *Make global* — or *Cancel*, which is also what `Enter` and `Esc` do.

The skill leaves the project and shows up under *User · ~/.snotra/skills* right away. If it was ticked in this folder, it is now ticked for every folder; the dialog says so beforehand. One that was off stays off.

Only you can do this. The model writes skills into the open folder only and never moves one out of it.


Type `/` in the input field: a list of every available skill opens, also those that are off. Type to narrow it down — it searches names and descriptions — and take one with `Enter` or `Tab`.

The text `/name` stays in your message and the skill applies for the rest of this chat. Your selection under *Settings › Skills* stays as it was. Only what you type counts: a `/name` in an answer or in a file switches nothing on.

## Let Snotra suggest a skill

Write your request, then type `/`. Below the input field Snotra suggests a fitting skill, for example *Fits here: /sowing-advice*. Click it to take it; `×` hides it. How it finds one is set under *Settings › Skills › Suggestions in the chat*:

- ***From the descriptions (no model)*** — compares your line with the skill descriptions, on your computer and at no cost. The default.
- ***Ask the model*** — also understands jargon, but sends your line and the skill names to the provider and takes a moment.
- ***No suggestions.***

A suggestion is never switched on by itself.

## See which skills a chat has

[since 1.20] In the chat bar, next to the model and the mode, a pill counts the skills that are on in this chat: *3 skills*, or *No skills*. Click it to see the whole picture:

![The popover of the pill "3 skills": under Skills the three system skills on and sowing-advice from the folder off; under Tools run_python and shell_execute switched off with a "Switch on" button each, web_search and generate_image with "Set up", and "15 switched on" folded; below, links to Settings › Skills and Settings › Tools › Autonomy.](screenshots/chat-config.webp)

- **Skills** — every skill, those that are on first, each with where it comes from. A skill you called with `/name`, or switched on a card for this chat, is marked *this chat only*.
- **Tools** — what is missing comes first, with the reason, such as *switched off* or *no search service key*. *Switch on* or *Set up* opens the setting that changes it. The tools that are on are summed up in one line; click it to see them by group.
- The two links at the bottom open *Settings › Skills* and *Settings › Tools › Autonomy*.

The pill only shows. What you switch on or off for good stays a choice in the settings.

The model sees the same list. When something fails or a capability seems to be missing, it looks it up instead of guessing and tells you, for example, that *pdf-export* would fit but is off — and where to switch it on. It cannot switch anything itself, and the instructions of a skill that is off never reach it.

## When the model suggests switching something on

[since 1.21] When a skill or tool that is off would help with what you asked, the model can suggest switching it on — for this chat only. Snotra then shows a card in the chat:

![A card titled "Switch on for this chat": the tool fetch_url with its description from Snotra, below it "External services · this chat only", a folded line "The model's reason", the buttons "Switch on" and "Decline", and the note that new chats keep your settings.](screenshots/config-proposal.webp)

### What the card shows

- **The name and what it does**, in Snotra's own words. For a skill from a folder or your own skills the description is its author's text, and the card says so.
- **Its risk class** for a tool — *Read*, *Change*, *Execute*, *External services* — or **where it comes from** for a skill, and *this chat only*.
- ***The model's reason***, folded away. Open it to read why the model asks; it is the model's sentence, not Snotra's.

### Steps

- ***Switch on*** switches it on for this chat. The model carries on with it right away.
- ***Decline*** leaves it off. Snotra does not show the same suggestion again in this chat. `Esc` declines too.

The model can also suggest switching something off for a chat — when you asked it to work from your documents only, for example. That card asks *Switch off* or *Keep it on*.

### What happens

The change applies to this chat only. It stays when you open another chat and come back, and after a restart; a new chat starts with your settings again. The skills pill marks the change *this chat only*. To switch something on for good, use [*Settings › Tools › Autonomy*](../../safety/tools-and-security/) or [*Settings › Skills*](#switch-a-skill-on).

A tool switched on this way works like one switched on in the settings: in *Smart* mode it still asks before each call that needs it.

### If it doesn't work

- **The model says a tool cannot be switched on from the chat.** It needs setting up first — a key, a program, or the switch for Python or shell commands under *Settings › Tools › Autonomy*. Those stay in the settings.
- **You declined by mistake.** Switch it on in the settings, or start a new chat and ask again.

## What happens

The model reads a switched-on skill's instructions when it needs them, together with the files next to its `SKILL.md`, such as `references/` or `assets/`. Those are read-only: what a skill wants to keep, it writes into `.agents/data/` in the open folder, like any other change you approve.

Snotra watches the skill folders, so a new or changed skill shows up in the settings and in the `/` list by itself. *Reload skills* is there for the rare case it does not, on a network drive for example. There is no skill store or skill manager: a skill is a folder, and putting it in one of the places under *Where skills come from* is all it takes.

## If it doesn't work

- **The model does not use a skill you expected.** Click the skills pill in the chat bar: a skill that is off is listed there with where it comes from. A skill from the folder has to be ticked for this folder.
- **A skill is greyed out with a reason.** Its `SKILL.md` is missing, has no front matter, or its `name` does not match its folder. The reason is shown next to it.
- **A skill is marked *Shadowed by …*.** Another skill of the same name comes first — the folder's before your own ones. The path says which.
- ***Make global* says there already is a global skill of that name.** Nothing was moved. Rename one of the two — the folder and the `name` in its `SKILL.md` — or remove the one in `~/.snotra/skills/` first. The dialog names its path.
- **Your own skill is off in a project.** That project has a skill of the same name; it shadows yours there and needs its own tick.
