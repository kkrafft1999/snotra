# Memory, AGENTS.md and rules files

Concept from 2026-10-25, worked out in
[#750](https://github.com/kkrafft1999/snotra/issues/750). The decisions it
rests on are recorded there; the implementation is split into the follow-up
issues listed at the end.

Snotra keeps lasting knowledge for the agent in two places today, memory and
`AGENTS.md`, and nothing says which kind of knowledge goes where. A convention
ends up in memory, a passing observation in `AGENTS.md`, and the `remember`
tool has no criterion for saying "this belongs in the instructions". This
concept gives every kind of knowledge exactly one home, adds a third home that
Snotra does not have yet — **rules files**, small topic-scoped instruction
files that load on demand — and defines how the agent writes to each.

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
  `load_skill` (#173). This is the model that rules files follow.
- **No rules files.**

The order of the system prompt is described in
[`architecture.md` › *System prompt*](../architecture/architecture.md#system-prompt).

## Decisions

Taken with the owner on 2026-10-13 (the first three, from the assessment of
OpenViking and agentmemory) and on 2026-10-25 (the rest):

1. **External memory tools are not integrated** (option A). Snotra's knowledge
   stays in plain Markdown files; only ideas are taken over.
2. **The kind of knowledge decides its home:** *procedural* ("how we do X") is
   an instruction, *semantic* ("X is the case") is memory, *episodic* ("today
   we did X") is not kept at all.
3. **Rules files load on demand, like skills:** a one-line description is
   always in the prompt, the body is read when the topic comes up.
4. **Memory gets a review** against a fixed catalogue: near-duplicates,
   contradictions, stale snapshots, and *supersede instead of overwrite*.
5. **Standing personal instructions go into a rules file marked
   `always: true`**, which puts its body into the prompt in full. They no
   longer live in memory.
6. **Rules are written by a tool of their own, `add_rule`**, built like
   `remember`. `remember` takes facts only.
7. **The review runs in two stages:** rule-based hints in the settings panel,
   and an agent-led review in the chat when the user asks for it. `remember`
   gains `replaces`; deleting without a replacement stays with the user.
8. **One settings page, *Knowledge*,** replaces *Memory* and holds
   instructions, rules and memory.

## Where knowledge goes

### The criterion

Two questions, asked in this order:

1. **Kind.** *Would the agent take a step differently because of it?* Then it
   is **procedural** and goes into the instructions. *Does it only answer a
   who, what, where or which?* Then it is **semantic** and goes into memory.
   *Is it only true for the work at hand?* Then it is **episodic** and is not
   kept.
2. **Reach and frequency** decide where inside the instructions:
   - needed in every conversation → `AGENTS.md`, or a rules file with
     `always: true` when the agent writes it;
   - needed only when a topic comes up → a rules file;
   - for everyone working in the folder → the project level; for the user in
     every folder → the global level.

The first question is the one that tends to be answered wrongly, because a
procedural statement is easy to phrase as a fact. "Tests run with `npm test`"
reads like a fact, but it changes which command the agent runs: it is
procedural, and so it belongs in `AGENTS.md` — even though it is the very
example `snotra-memory` uses for memory today.

### The table

| Kind of knowledge | Example | Kind | Home |
| --- | --- | --- | --- |
| Facts about the user | "Works at doubleSlash", "GitHub account is `kkrafft1999`" | semantic | `~/.snotra/memory.md` |
| Facts about the project | "The board is project number 2", "The relay runs on Firebase" | semantic | `<workspace>/.agents/memory.md` |
| Pointers to external resources | the board URL, where the design files are kept | semantic | memory, at the level they apply to |
| Decisions and their reasons | "Option A was chosen for X because Y" | semantic | memory of the project, or the project's own docs |
| Conventions every conversation needs | package manager, test command, folders not to touch | procedural | `AGENTS.md` (written by the user or the team) |
| Workflow rules for one topic | how a release is cut, how commits are worded | procedural | `<workspace>/.agents/rules/<topic>.md` |
| Standing personal instructions | form of address, reply language | procedural | `~/.snotra/rules/<topic>.md` with `always: true` |
| Personal ways of working for one topic | how the user wants reviews written | procedural | `~/.snotra/rules/<topic>.md` |
| Learned corrections | "Never run `npm ci` with `--ignore-scripts` here" | procedural | rules file of the matching topic |
| State of the current work | "the test is failing", "next we do Y", "we are in file X" | episodic | not kept |
| Credentials, secrets, data about third parties | — | — | nowhere (unchanged) |

Decisions sit with the facts on purpose: a decision says *what was chosen and
why*, and the rule that follows from it ("use X") is written as a rule
separately. A decision recorded only as a rule loses its reason and gets
overridden at the next disagreement.

### Who writes which home

| Home | User | Agent |
| --- | --- | --- |
| Memory, both levels | edits the file or removes entries in *Settings › Knowledge* | `remember`, with a card for every call |
| Rules files, project and `~/.snotra` | edits the files, creates them from *Settings › Knowledge* | `add_rule`, with a card for every call, in every permission mode |
| Rules files, `~/.agents` | edits the files | never (legacy location, read only) |
| `AGENTS.md`, project | edits the file | only as an ordinary file, through the file tools and their approval — no dedicated tool |
| `AGENTS.md`, global | edits the file | never |

`AGENTS.md` stays hand-written. It is often versioned and shared with a team,
and other tools read it too; the agent's own instructions go into rules files,
where they are visible as a separate file and can be switched off one by one.

## Rules files

### Location and naming

| # | Path | Level | Written by `add_rule` |
| --- | --- | --- | --- |
| 1 | `<workspace>/.agents/rules/*.md` | project | yes |
| 2 | `~/.snotra/rules/*.md` | global, default location | yes |
| 3 | `~/.agents/rules/*.md` | global, compatible legacy location | no |

It is the same source list as for skills and `AGENTS.md` (#251), so there is
still only one order to remember. Snotra does not read other tools'
directories (#103): no `.claude/rules/`, no `.cursor/rules/`. The idea is the
same in both tools, and the frontmatter below stays close enough that a file
can be moved over by hand.

- Only `.md` files directly in the folder count; subfolders are not read.
- The file name is the rule's name: lowercase letters, digits and hyphens,
  at most 64 characters, like a skill name (`release.md`, `commit-style.md`).
- At most 50 files per source. Further files are ignored and marked in the
  settings.

### Format

```markdown
---
description: How a release is cut — version bump through a pull request, tag, pipeline.
always: false
---

- The version bump goes through a pull request, never straight onto `main`.
- …
```

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | yes | One line, at most 200 characters. It is all the model sees of an on-demand rule, so it says *when* the rule applies, not only what it is about. |
| `always` | no, default `false` | `true` puts the whole body into the prompt in every conversation. |

Unknown fields are ignored, so `paths`, `globs` or `alwaysApply` from another
tool do not break a file — they just have no effect. A file without a
`description` is not loaded and is marked as invalid in the settings: there
would be nothing to show the model for it, and loading it always instead would
let a copied file quietly enlarge every prompt.

Scoping by path (load a rule when the agent touches matching files) is left
out for now. It would need the file tools to report what they touch to the
prompt builder; `paths` is reserved for it.

### Loading

The system prompt gets a **rules block** right after the project instructions
(block 5 in `architecture.md`), before the folder's memory — rules are
instructions and stand with the other instructions:

- every `always: true` file with its full body, under a heading naming the
  file and its level;
- every other file as one line: name, level and description, with one sentence
  telling the model to fetch the body with `load_rule` when the description
  matches the task, before it starts on it.

**`load_rule`** takes a name and a level (`workspace` or `user`) and returns
the body. It is a read tool, never shows a card, and its trace line reads
"Rule *release* (project)". It is a tool of its own rather than another use of
`load_skill`: a skill brings a capability and can carry files and scripts, a
rule is an instruction, and the trace and the permissions should say which of
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
  `add_rule` is the only writer, and the port decides the path.

## Writing

### `add_rule`

Built like `remember`: the model names a level and a topic, never a path.

| Parameter | Meaning |
| --- | --- |
| `scope` | `workspace` or `user`, as chosen by the user — the same question as for `remember` (#416) |
| `topic` | the file name without `.md`; a new file is created when it does not exist |
| `description` | required when the file is new, ignored otherwise |
| `text` | the rule, one thought, at most 500 characters, appended as a list item |
| `always` | only for a new file; an existing file keeps its setting |
| `origin` | `requested` or `self`, truthfully, as for `remember`; the switch for unprompted remembering applies here too |
| `replaces` | optional: the exact text of a memory entry at the same level, removed once the rule is written — this is how an entry moves from memory into a rule |

- **A card for every call, in every permission mode.** Auto mode does not
  approve it, and no persistent allow rule covers it. A rule changes how the
  agent behaves in every later conversation; that is worth one click each time.
- The card shows the level, the target file, whether the file is new, whether
  it is `always`, the rule itself, and the memory entry that `replaces` would
  remove.
- The tool has a switch of its own in the tool settings and can be turned off
  without turning off `remember`.
- It refuses when the file would exceed 20,000 characters, when the topic is
  not a valid name, and at the project level when no folder is open.

### `remember`

- **Facts only.** Its description says so and points to `add_rule` for
  anything procedural. It does not refuse an entry that looks like a rule —
  telling the two apart reliably needs the model — but its result adds a hint
  when the entry reads like an instruction (the same heuristic as the panel
  hint below), so the model can correct course.
- **`replaces`** (new, optional): the exact text of an existing entry at the
  same level. The card shows old → new; once approved, the old line is removed
  and the new one is appended with today's date. An entry that cannot be found
  is an error and nothing is written. A correction thus replaces the old entry
  visibly instead of leaving two contradicting ones.
- Deleting without a replacement stays with the user, as today.
- The scope question (#416) and the origin rules (#553) are unchanged.

### `snotra-memory`

The system skill stays the one place for writing guidance and covers both
tools. It gets:

- the criterion and the table above, in short, with the test question first;
- new examples: "Tests run with `npm test`" moves from the memory examples to
  the `AGENTS.md` examples, and "remember: address me as du" becomes an
  `add_rule` example at the user level with `always: true`;
- "When you do not remember" points procedural statements to `add_rule`
  instead of to `AGENTS.md`, and suggests `AGENTS.md` only for conventions the
  whole team should share;
- a section on the review (below);
- an updated description, so that "remember that we always …" and "review my
  memory" load it as well, and `add_rule`'s description asks for the skill
  before first use, as `remember`'s does.

It must stay small: the system skills share the context budget (see the size
limit found for `snotra-capabilities`), so the full explanation goes into the
manual and the skill keeps the rules of thumb.

## Review and migration

### Hints in the settings

*Settings › Knowledge* marks memory entries without any model call:

| Hint | When |
| --- | --- |
| Nearly the same as another entry | normalised word overlap of at least 80 % with another entry of the same file; across levels, "also kept globally" |
| Noted a while ago | the entry's date is more than 180 days old — "noted on <date>; still true?" |
| Reads like an instruction | it starts with an imperative or contains words such as *always*, *never*, *must* (word lists per interface language) |
| Close to the limit | the file is at 80 % of 8,000 characters or more |

Each hint offers what fits: *Remove*, *Edit*, and for "reads like an
instruction" *Move to rules…*, which asks for the level and topic and writes the
rules file. Nothing changes without the user's click. The heuristics only point
at candidates; a hint that is wrong can be dismissed and stays dismissed for
that entry.

### Review in the chat

When the user asks for it ("review my memory"), the agent goes through both
memory files against the catalogue — duplicates, contradictions in meaning,
snapshots that have gone stale, entries that are really rules — and proposes
**one change at a time**:

- a merged or corrected entry → `remember` with `replaces`;
- an entry that is a rule → `add_rule` with `replaces`;
- an entry that should simply go → it names the entry and points to
  *Settings › Knowledge*; it cannot delete it.

The agent does not start a review on its own. When memory is close to the
limit it may mention once that a review would help.

### Existing entries

No automatic migration. Existing memory entries stay valid and keep working,
including the ones that are really rules; the hints mark them, and the user
moves them when it suits them. Existing `AGENTS.md` files are not touched. The
release notes and the manual explain the new split once.

## Settings › Knowledge

*Settings › Memory* becomes *Settings › Knowledge* (*Einstellungen › Wissen*),
with three sections in this order:

1. **Instructions** — the `AGENTS.md` files found, each with its path, size and
   state (truncated, withheld), and *Open in editor*. The switch *Send
   `AGENTS.md`* moves here from *Settings › General*.
2. **Rules** — per level, every rules file with name, description, an `always`
   marker, size, state (invalid, truncated, over budget, shadowed), its switch
   and *Open in editor*; a switch for the whole section; *New rules file*, which
   creates a file with the frontmatter filled in.
3. **Memory** — as today, plus the hints and their actions.

The visual layout is worked out as a mockup in the follow-up issue, as
[`ux-ui-standards.md`](../../.claude/rules/ux-ui-standards.md) asks; the
structure above is what is decided. Renaming the page touches every place that
quotes the menu path: the manual, the catalogue placeholder that `snotra-memory`
uses for it, and the context breakdown labels. Both interface languages, as
always.

## Security

Rules files add one thing that memory and `AGENTS.md` do not have in this
form: **an instruction the agent writes itself and that applies in every later
conversation**, at the global level in every folder. A prompt injection that
gets one `add_rule` call approved would outlive the run it came from. The
concept answers that with:

- a card for every `add_rule` call, in every permission mode, never covered by
  a persistent allow rule;
- a card that names the level, the file and the `always` marker plainly —
  "applies in every folder, in every conversation" is the line the user must
  not miss;
- a switch for the tool, a switch for the rules section and one per file;
- no file tool reaching the global rules folders.

Open for the security concept, and filed as
[#1280](https://github.com/kkrafft1999/snotra/issues/1280): whether `add_rule`
should be refused outright in a run in which the injection detector has flagged
a tool result, and how rules files enter the threat model and the quality
requirements. `docs/security/security-concept.md` and `docs/architecture/quality-requirements.md` are
not changed in this concept.

Workspace rules files are foreign instructions in the same way a workspace
`AGENTS.md` is. They do not open a new path — but they do add a second file
type to look at when judging a folder, which is why the switches exist per
file.

## What this concept leaves out

- **A retrieval backend for memory.** If memory ever outgrows its limit, the
  memory port is where one could dock; that would be an issue of its own
  (decision 1).
- **Scoping rules by path** (`paths`), see *Format*.
- **Reading other tools' rules folders** (#103).
- **Automatic capture** of memory or rules at the end of a run. Nothing is
  kept without a card.

## Follow-up issues

Filed on 2026-10-25 and linked from #750. Their order follows the
dependencies:

1. [#1275](https://github.com/kkrafft1999/snotra/issues/1275) **Rules files: read and load on demand** — contract, port and adapter,
   the rules block, `load_rule`, the `always` budget, limits, the context
   breakdown, safeguards, the update of `architecture.md` and
   `agent-text-sources.svg`.
2. [#1276](https://github.com/kkrafft1999/snotra/issues/1276) **`add_rule`: write rules with a card** — depends on #1275.
3. [#1277](https://github.com/kkrafft1999/snotra/issues/1277) **`remember` takes facts only and gains `replaces`;
   `snotra-memory` rewritten** — depends on #1276.
4. [#1278](https://github.com/kkrafft1999/snotra/issues/1278) ***Settings › Knowledge*** — the merged page, mockup
   first, manual pages in both languages — depends on #1275.
5. [#1279](https://github.com/kkrafft1999/snotra/issues/1279) **Memory hints and *Move to rules…*** — depends on
   #1276 and #1278.
6. [#1280](https://github.com/kkrafft1999/snotra/issues/1280) **Security: rules files and `add_rule` in the security
   concept and the quality requirements** — independent; written once the current edits to
   those documents have landed.
