# Memory, rules, skills and AGENTS.md

Concept from 2026-10-25, worked out in
[#750](https://github.com/kkrafft1999/snotra/issues/750), and reworked with
the owner on 2026-10-31. The decisions it rests on are listed below; the
implementation is split into the follow-up issues listed at the end.

Snotra keeps lasting knowledge for the agent in two places today, memory and
`AGENTS.md`, and nothing says which kind of knowledge goes where. A convention
ends up in memory, a passing observation in `AGENTS.md`, and the `remember`
tool has no criterion for saying "this belongs in the instructions". This
concept separates knowledge into **three kinds — facts, rules and
instructions** — gives each exactly one home, keeps `AGENTS.md` as the home for
everything else, adds the home Snotra does not have yet — **rules files**,
small topic-scoped files that load on demand — and lets the agent write to all
of them through one tool, `remember`, with a card for every call.

## Starting point (checked 2026-10-25, `main` at `b53dd78`)

- **Memory** — `~/.snotra/memory.md` (the user's) and
  `<workspace>/.agents/memory.md` (the folder's), always in the system prompt,
  at most 8,000 characters per level (`MAX_MEMORY_CHARS`), 500 per entry. It is
  written only through the `remember` tool, which asks for every call and lets
  the user pick the scope (#166, #416, #529). The instructions for writing live
  in the system skill `snotra-memory` and are loaded on demand. The agent cannot
  delete entries; the user does that in *Settings › Memory*.
- **Project instructions** — `AGENTS.md` from the workspace root,
  `~/.snotra/AGENTS.md` and `~/.agents/AGENTS.md`, all of them concatenated and
  always in the prompt, at most 20,000 characters per file (#212, #253, #432).
  They are instruction, not data. One switch under *Settings › General* turns
  them off.
- **Skills** — name and description in the prompt, body fetched with
  `load_skill` (#173). The agent writes skills only into the open folder,
  through the ordinary file tools, as `snotra-skill-authoring` describes; the
  global skill folders are out of reach (#160).
- **No rules files.**
- **Chats** are stored in full, but the agent has no tool to read earlier ones
  (checked 2026-10-31).

The order of the system prompt is described in
[`architecture.md` › *System prompt*](../architecture/architecture.md#system-prompt).

## Decisions

Taken with the owner on 2026-10-13 (1–2, from the assessment of OpenViking and
agentmemory), on 2026-10-25 (3, 6, 7) and on 2026-10-31 (the rest; they
replace decisions 2, 5, 6 and 8 of 2026-10-25):

1. **External memory tools are not integrated.** Snotra's knowledge stays in
   plain Markdown files; only ideas are taken over.
2. **Three kinds of knowledge, each with one home:** a **fact** (what is the
   case, what belongs to what) goes into memory, a **rule** (*when X, then Y*)
   into a rules file, an **instruction** (a procedure of several steps towards
   a goal) into a skill. Whatever the user does not want to or cannot place,
   or what belongs to the team, goes into `AGENTS.md`.
3. **Rules files load on demand, like skills:** a one-line description is
   always in the prompt, the body is read when the topic comes up.
4. **A standing personal instruction is a rule with a condition that always
   holds** — "when you answer me, answer in German". It goes into a rules file
   marked `always: true`, which puts its body into the prompt in full.
5. **One tool, `remember`, with a `kind`:** `fact`, `rule`, `instruction` or
   `other`. The agent proposes the kind; the user can switch it on the card
   before approving. There is no separate `add_rule`.
6. **A card for every call, in every permission mode, at both levels and for
   every kind** — including skills and `AGENTS.md`, and including the global
   level.
7. **Memory gets a review** against a fixed catalogue, in two stages:
   rule-based hints in the settings panel, and an agent-led review in the chat
   when the user asks for it. `replaces` moves or corrects an entry; deleting
   without a replacement stays with the user.
8. **Episodes are not stored; the chats are the episodic memory.** The agent
   gets a read tool to search the chats of the open workspace, and the user can
   have a chat *distilled* into facts, rules and instructions — on request
   first, later through an action in the interface.
9. **Everything stays under `.agents/`.** Rules files and skills in the
   workspace are versioned with the folder and so available to the team.
   Snotra still reads no other tool's folders (#103); the format stays close
   enough to Claude Code's that a team can link or copy files.
10. **One settings page, *Knowledge*,** holds all four homes: instructions
    (skills), rules, facts (memory) and `AGENTS.md`. It replaces *Memory*, and
    the skills page moves into it.
11. **A detected injection warns, it does not block.** When the injection
    detector has flagged a tool result in the run, the card of every
    `remember` call says so plainly; the user decides.

## Where knowledge goes

### The criterion

The **form** of the statement decides, not its effect — almost every useful
fact changes some step the agent takes, so "would the agent act differently?"
sorts nearly everything into the instructions. Asked in this order:

1. **Is it a procedure** — several steps towards a goal, "first …, then …"?
   Then it is an **instruction** and goes into a skill.
2. **Is it, or can it be phrased as, *when X, then Y*?** "Always", "never" and
   "whenever" count, and so does a condition that always holds ("when you answer
   me, …"). Then it is a **rule** and goes into a rules file.
3. **Does it say what is the case or what belongs to what?** Then it is a
   **fact** and goes into memory.
4. **Is it only true for the work at hand, or did it happen once** ("the test is
   failing", "today we released 1.28.1")? Then it is an **episode** and is not
   stored; see *Episodes*.
5. **Does it fit none of these, or does the user not want to decide**, or does
   it belong to the team as a whole? Then it goes into `AGENTS.md`.

**Reach** decides the level: for everyone working in the folder → the project
level; for the user in every folder → the global level. **Frequency** decides
`always` for a rule: a condition that holds in every turn needs `always: true`,
any other rule loads on demand.

A rule is written as a condition, even when it reads like a plain order:
"address me as du" is stored as "when you address me, use du". The condition is
what the description and the loading are built from.

### The table

| Kind of knowledge | Example | Kind | Home |
| --- | --- | --- | --- |
| Facts about the user | "Works at doubleSlash", "the Microsoft calendar address is …" | fact | `~/.snotra/memory.md` |
| Facts about the project | "The board is project number 2", "The relay runs on Firebase" | fact | `<workspace>/.agents/memory.md` |
| Pointers to external resources | the board URL, where the design files are kept | fact | memory, at the level they apply to |
| Decisions and their reasons | "Option A was chosen for X because Y" | fact | memory of the project, or the project's own docs |
| Standing personal instructions | "When you answer me, answer in German" | rule, `always` | `~/.snotra/rules/<topic>.md` |
| Workflow rules for one topic | "When a commit message is written, it is in English" | rule | `<workspace>/.agents/rules/<topic>.md` |
| Learned corrections | "When `npm ci` runs here, never with `--ignore-scripts`" | rule | rules file of the matching topic |
| Procedures | how a release is cut, step by step | instruction | `<workspace>/.agents/skills/<name>/` or `~/.snotra/skills/<name>/` |
| Team conventions, anything not placed | package manager, folders not to touch | other | `AGENTS.md`, project or global |
| State of the current work, past events | "the test is failing", "next we do Y" | episode | not stored — the chats |
| Credentials, secrets, data about third parties | — | — | nowhere (unchanged) |

Decisions sit with the facts on purpose: a decision says *what was chosen and
why*, and the rule that follows from it ("when X, use Y") is written as a rule
separately. A decision recorded only as a rule loses its reason and gets
overridden at the next disagreement.

### Who writes which home

| Home | User | Agent |
| --- | --- | --- |
| Memory, both levels | edits the file or removes entries in *Settings › Knowledge* | `remember` `kind: fact` |
| Rules files, project and `~/.snotra` | edits the files, creates them from *Settings › Knowledge* | `remember` `kind: rule` |
| Skills, project and `~/.snotra` | edits the files | `remember` `kind: instruction` (text only); multi-file work in the open folder through the file tools |
| `AGENTS.md`, project and `~/.snotra` | edits the file | `remember` `kind: other`, appended |
| `~/.agents/…` (rules, skills, `AGENTS.md`) | edits the files | never (legacy location, read only) |

Every `remember` call shows a card, in every permission mode. The file tools
still cannot write any global folder; `remember` is the only writer there, and
the port decides the path.

## Rules files

### Location and naming

| # | Path | Level | Written by `remember` |
| --- | --- | --- | --- |
| 1 | `<workspace>/.agents/rules/*.md` | project | yes |
| 2 | `~/.snotra/rules/*.md` | global, default location | yes |
| 3 | `~/.agents/rules/*.md` | global, compatible legacy location | no |

It is the same source list as for skills and `AGENTS.md` (#251), so there is
still only one order to remember. Snotra does not read other tools'
directories (#103): no `.claude/rules/`, no `.cursor/rules/`. The idea is the
same in those tools, and the frontmatter below stays close enough that a team
member using Claude Code can link `.claude/rules` to `.agents/rules` or copy a
file over.

- Only `.md` files directly in the folder count; subfolders are not read.
- The file name is the rule's name: lowercase letters, digits and hyphens,
  at most 64 characters, like a skill name (`release.md`, `commit-style.md`).
- At most 50 files per source. Further files are ignored and marked in the
  settings.

### Format

```markdown
---
description: When a commit message, pull request or issue is written in this repository.
always: false
---

- When a commit message is written, it is in English.
- …
```

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | yes | One line, at most 200 characters. It is all the model sees of an on-demand rule, so it names the condition — *when* the rule applies — not only the topic. |
| `always` | no, default `false` | `true` puts the whole body into the prompt in every conversation. For rules whose condition holds in every turn. |

Each list item is one rule, phrased as a condition. Unknown fields are
ignored, so `paths`, `globs` or `alwaysApply` from another tool do not break a
file — they just have no effect. A file without a `description` is not loaded
and is marked as invalid in the settings: there would be nothing to show the
model for it, and loading it always instead would let a copied file quietly
enlarge every prompt.

Scoping by path (load a rule when the agent touches matching files) is left
out for now. It would need the file tools to report what they touch to the
prompt builder; `paths` is reserved for it.

### Loading

The system prompt gets a **rules block** right after the project instructions
(block 5 in `architecture.md`), before the folder's memory — rules guide the
work and stand with the other instructions:

- every `always: true` file with its full body, under a heading naming the
  file and its level;
- every other file as one line: name, level and description, with one sentence
  telling the model to fetch the body with `load_rule` when the description
  matches the task, before it starts on it.

**`load_rule`** takes a name and a level (`workspace` or `user`) and returns
the body. It is a read tool, never shows a card, and its trace line reads
"Rule *release* (project)". It is a tool of its own rather than another use of
`load_skill`: a skill brings a procedure and can carry files and scripts, a
rule is a condition, and the trace and the permissions should say which of
the two was read. Its result is treated like a skill body: it guides how the
work is done, but it cannot grant a permission
(`TOOL_RESULTS_ARE_DATA_RULE` names skill content already and is extended to
rules).

**Order and precedence.** Files are read in the source order above, and inside
a source alphabetically. As with `AGENTS.md`, all of them apply together; the
order is a reading order, not a precedence. Two files of the same name at the
project and the global level are both listed — they complement each other. The
same name in `~/.snotra/rules` and `~/.agents/rules` is the one case where the
first hit wins, as with skills: both are the user level, and the legacy file is
shown as shadowed.

### Limits

| What | Limit | Beyond the limit |
| --- | --- | --- |
| `description` | 200 characters | cut in the prompt, marked in the settings |
| Body of one file | 20,000 characters, as `AGENTS.md` and skill bodies | visibly truncated, as `AGENTS.md` |
| Files per source | 50 | ignored, marked |
| Bodies of `always: true` files | 8,000 characters per level in total, as memory | files beyond the budget, in reading order, are offered on demand instead and marked in the settings and the context breakdown |

The `always` budget equals the memory limit because it takes over the standing
personal instructions that memory carried so far. Falling back to on demand
instead of truncating keeps a rule whole: half a rule is worse than one that
has to be fetched.

### Context breakdown

Following #174: one row per level for the catalogue of on-demand rules, and one
row per `always` file, each with its path, size and the markers for truncated,
withheld or over budget. A body fetched with `load_rule` shows up where every
tool result does.

### Safeguards

The same as for `AGENTS.md` and memory, nothing weaker:

- **Regular files inside their source.** The rules folder and every file in it
  must resolve inside the workspace (or inside `~/.snotra` / `~/.agents`) after
  following links; a symlink that leads out is not read (#534).
- **Secret protection** (#528). The `always` bodies and the descriptions are
  embedded without being asked for and so pass `embedded-text-guard.js`; a
  body fetched with `load_rule` passes the secret protection of a tool result.
- **Switches.** The rules section has a switch of its own, and every file has
  one. For the project level they are the emergency brake for a foreign folder,
  as the `AGENTS.md` switch is: a cloned repository can bring rules files the
  same way it brings an `AGENTS.md`. Like the skill switches, the state lives in
  the app's settings, not in the folder, so a folder cannot switch its own
  rules back on.
- **Out of reach of the file tools at the global level.** As for global skills
  (#160), no file tool may write to `~/.snotra/rules` or `~/.agents/rules`;
  `remember` is the only writer, and the port decides the path.

## Writing: `remember`

One tool for every kind. The model names a kind, a level and — where the kind
needs it — a topic or a name, never a path.

| Parameter | Meaning |
| --- | --- |
| `kind` | `fact`, `rule`, `instruction` or `other` — the agent's proposal; the user can switch it on the card |
| `scope` | `workspace` or `user`, as chosen by the user — the question of #416, unchanged |
| `text` | the entry: one thought, at most 500 characters; for `instruction` the steps, within the skill body limit |
| `topic` | `rule`: the rules file's name; `instruction`: the skill's name. A new file is created when it does not exist |
| `description` | required when a new rules file or skill is created, ignored otherwise |
| `always` | `rule` only, and only for a new file; an existing file keeps its setting |
| `origin` | `requested` or `self`, truthfully (#553); the switch for unprompted remembering applies to every kind |
| `replaces` | optional: the exact text of an existing memory entry or rules-file line at the same level, removed once the new entry is written — across kinds, so a memory entry can become a rule |

**What each kind writes:**

- `fact` — a line with today's date in the level's `memory.md`, as today.
- `rule` — a list item in `<level>/rules/<topic>.md`, the file created with
  its frontmatter when it is new.
- `instruction` — `<level>/skills/<topic>/SKILL.md`, created with `name` and
  `description`, or extended with the new steps. **Text only:** no scripts and
  no further files; that stays with the file tools in the open folder.
- `other` — appended to the level's `AGENTS.md` (`<workspace>/AGENTS.md` or
  `~/.snotra/AGENTS.md`), which is created when it is missing.

**The card** is shown for every call, in every permission mode. Auto mode does
not approve it, and no persistent allow rule covers it. It shows:

- the kind, with a switch to change it; switching changes the target and the
  fields asked for (a rule needs a topic, a fact does not) without a new round
  with the agent;
- the level and the target file, and whether it is new;
- for a rule: the `always` marker; for `user` with `always` the line
  "applies in every folder, in every conversation";
- for `other` at the project level: that `AGENTS.md` is usually versioned and
  shared with the team;
- for an instruction at the user level: that the skill is offered in every
  folder;
- the entry itself, and the entry `replaces` would remove, as old → new;
- a warning when the injection detector has flagged a tool result in this run.

**Refusals.** The tool refuses an invalid topic or name, a file that would
exceed its limit, the project level without an open folder, a `replaces` entry
that cannot be found (nothing is written), and an entry that reads as an
episode — with a hint that the chats keep it and that it can be distilled.

**`kind: fact` stays facts only.** Its description says so. It does not refuse
an entry that looks like a rule — telling the two apart reliably needs the
model — but the result adds a hint when the entry reads like a rule or a
procedure (the same heuristics as the panel hints below), so the model can
correct course.

The tool keeps its switch in the tool settings. The decision of 2026-10-25 for
a separate `add_rule` and against a `kind` parameter is reversed: only one tool
lets the user re-sort on the card, without rejecting and asking again.

### `snotra-memory`

The system skill stays the one place for writing guidance and covers every
kind. It gets:

- the criterion above, in short, with the form test first;
- examples per kind: "Tests run with `npm test`" moves from the memory examples
  to the `AGENTS.md` (`other`) examples, "address me as du" becomes a `rule` at
  the user level with `always: true`, phrased as a condition;
- a section on the review and one on distilling (below);
- an updated description, so that "remember that we always …", "review my
  memory" and "what do we take away from this?" load it as well.

It must stay small: the system skills share the context budget (see the size
limit found for `snotra-capabilities`), so the full explanation goes into the
manual and the skill keeps the rules of thumb. `snotra-skill-authoring` is
updated as well: a global skill no longer has to be moved by hand.

## Episodes

An episode is something that happened once, at a time: "on 30 October we
released 1.28.1 and had to fix the manual marker". A skill also has a sequence,
but it is a recipe that holds every time; an episode is an entry in a diary.
Episodes go stale, and stored as notes they only pile up. They are not kept in
any of the homes above.

- **The chats are the episodic memory.** Snotra stores them in full already.
  A read tool, `search_chats`, lets the agent search the chats **of the open
  workspace** — never those of other folders — and returns excerpts with title
  and date. It shows no card; its results are tool results, data and not
  instructions, and pass the secret protection and the injection detector like
  any other.
- **Distilling** draws what is lasting out of an episode. On request ("what do
  we take away from this?") the agent goes through the chat and proposes one
  item at a time, each as a `remember` call with its kind and its card.
  Episodic content itself is not proposed. Later an action in the chat
  interface starts the same; the agent does not offer it on its own at the end
  of a run.
- The state of the work in a development project stays where it is: in the
  issues.

## Review and migration

### Hints in the settings

*Settings › Knowledge* marks memory entries without any model call:

| Hint | When | Actions |
| --- | --- | --- |
| Reads like a rule | contains a condition or *always*, *never*, *whenever*, *must* (word lists per interface language) | *Move to rules…* |
| Reads like a procedure | an enumeration of steps, "first … then …" | *Create a skill…* |
| Reads like an episode | a date or "today", "next", past tense describing an event | *Remove*, *Distil…* |
| Nearly the same as another entry | normalised word overlap of at least 80 % with another entry of the same file; across levels, "also kept globally" | *Remove*, *Edit* |
| Noted a while ago | the entry's date is more than 180 days old — "noted on <date>; still true?" | *Remove*, *Edit* |
| Close to the limit | the file is at 80 % of 8,000 characters or more | — |

*Move to rules…* and *Create a skill…* ask for the level and the topic and
write the file; the memory entry is removed with it. Nothing changes without
the user's click. The heuristics only point at candidates; a hint that is
wrong can be dismissed and stays dismissed for that entry.

### Review in the chat

When the user asks for it ("review my memory"), the agent goes through both
memory files against the catalogue — duplicates, contradictions in meaning,
snapshots that have gone stale, entries of the wrong kind — and proposes
**one change at a time**, each as `remember` with `replaces` and the fitting
kind. An entry that should simply go is named, with a pointer to
*Settings › Knowledge*; the agent cannot delete it.

The agent does not start a review on its own. When memory is close to the
limit it may mention once that a review would help.

### Existing entries

No automatic migration. Existing memory entries stay valid and keep working,
including the ones that are really rules; the hints mark them, and the user
moves them when it suits them. Existing `AGENTS.md` files are not touched. The
release notes and the manual explain the new split once.

## Settings › Knowledge

*Settings › Memory* becomes *Settings › Knowledge* (*Einstellungen › Wissen*),
with four sections in this order:

1. **Instructions** — the skills per level, as on today's skills page, which
   moves here.
2. **Rules** — per level, every rules file with name, description, an `always`
   marker, size, state (invalid, truncated, over budget, shadowed), its switch
   and *Open in editor*; a switch for the whole section; *New rules file*, which
   creates a file with the frontmatter filled in.
3. **Facts** — memory as today, plus the hints and their actions.
4. **`AGENTS.md`** — the files found, each with its path, size and state
   (truncated, withheld), and *Open in editor*. The switch *Send `AGENTS.md`*
   moves here from *Settings › General*.

The visual layout is worked out as a mockup in the follow-up issue, as
[`ux-ui-standards.md`](../../.claude/rules/ux-ui-standards.md) asks; the
structure above is what is decided. Renaming the page and moving the skills
page touch every place that quotes the menu paths: the manual, the catalogue
placeholder that `snotra-memory` uses, `snotra-capabilities`, and the context
breakdown labels. Both interface languages, as always.

## Security

The agent can now write three things that apply in every later conversation —
rules, skills and `AGENTS.md` — and at the global level in every folder. A
prompt injection that gets one `remember` call approved would outlive the run
it came from. The concept answers that with:

- a card for every `remember` call, every kind, in every permission mode,
  never covered by a persistent allow rule;
- a card that names the kind, the level, the file and the `always` marker
  plainly — "applies in every folder, in every conversation" is the line the
  user must not miss;
- a warning on the card when the injection detector has flagged a tool result
  in the run — a warning, not a block (decision 11);
- skills written by `remember` are text only: no scripts, no further files;
- a switch for the tool, a switch for the rules section and one per rules file;
- no file tool reaching the global folders.

How rules files, agent-written skills and agent-written `AGENTS.md` enter the
threat model and the quality requirements is filed as
[#1280](https://github.com/kkrafft1999/snotra/issues/1280);
`docs/security/security-concept.md` and
`docs/architecture/quality-requirements.md` are not changed in this concept.

Workspace rules files are foreign instructions in the same way a workspace
`AGENTS.md` or a workspace skill is. They do not open a new path — but they
do add a file type to look at when judging a folder, which is why the switches
exist per file.

## What this concept leaves out

- **A retrieval backend for memory.** If memory ever outgrows its limit, the
  memory port is where one could dock; that would be an issue of its own
  (decision 1).
- **A semantic index for the chats.** `search_chats` starts with keyword search.
- **Scoping rules by path** (`paths`), see *Format*.
- **Reading other tools' rules or skills folders** (#103).
- **Automatic capture** of knowledge at the end of a run. Nothing is kept
  without a card, and distilling starts only on request.

## Follow-up issues

Filed on 2026-10-25 and reworked on 2026-10-31. Their order follows the
dependencies:

1. [#1275](https://github.com/kkrafft1999/snotra/issues/1275) **Rules files: read and load on demand** — contract, port and adapter,
   the rules block, `load_rule`, the `always` budget, limits, the context
   breakdown, safeguards, the update of `architecture.md` and
   `agent-text-sources.svg`.
2. [#1276](https://github.com/kkrafft1999/snotra/issues/1276) **`remember` gains `kind`: rules files and `AGENTS.md` with a card** —
   the kind switch on the card, `replaces` across kinds, the injection
   warning — depends on #1275.
3. [#1314](https://github.com/kkrafft1999/snotra/issues/1314) **`kind: instruction`: write a skill, at the global level too** —
   depends on #1276.
4. [#1277](https://github.com/kkrafft1999/snotra/issues/1277) **Facts only, episode refusal, `snotra-memory` rewritten** —
   depends on #1276.
5. [#1278](https://github.com/kkrafft1999/snotra/issues/1278) ***Settings › Knowledge*** with four sections, the skills page
   moved in, mockup first, manual pages in both languages — depends on #1275.
6. [#1279](https://github.com/kkrafft1999/snotra/issues/1279) **Hints, *Move to rules…* and *Create a skill…*** — depends on
   #1276, #1314 and #1278.
7. [#1280](https://github.com/kkrafft1999/snotra/issues/1280) **Security: rules files, agent-written skills and `AGENTS.md`
   in the security concept and the quality requirements** — independent.
8. [#1315](https://github.com/kkrafft1999/snotra/issues/1315) **`search_chats`** — independent.
9. [#1316](https://github.com/kkrafft1999/snotra/issues/1316) **Distil a chat on request** — depends on #1276 and #1277.
10. [#1317](https://github.com/kkrafft1999/snotra/issues/1317) **Distil action in the chat interface** — depends on #1316.
