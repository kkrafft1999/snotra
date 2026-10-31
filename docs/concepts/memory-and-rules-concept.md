# Memory, rules, skills and AGENTS.md

Concept from 2026-10-25, worked out in
[#750](https://github.com/kkrafft1999/snotra/issues/750), reworked with the
owner on 2026-10-31 ([#1318](https://github.com/kkrafft1999/snotra/pull/1318))
and reviewed the same day. The decisions it rests on are listed below, each
with its date; the implementation is split into the follow-up issues listed at
the end.

Snotra keeps lasting knowledge for the agent in two places today, memory and
`AGENTS.md`, and nothing says which kind of knowledge goes where. A convention
ends up in memory, a passing observation in `AGENTS.md`, and the `remember`
tool has no criterion for saying "this belongs in the instructions". This
concept sorts knowledge by **two questions** — *what is it?* (a fact, a rule
or a procedure) and *who should read it?* (only the user, Snotra in this
folder, or every tool in this folder) — gives each answer exactly one home,
adds the home Snotra does not have yet — **rules files**, small topic-scoped
files — and lets the agent write to all of them through one tool, `remember`,
with a card for every write to a knowledge file, whichever tool makes it.

## Starting point

Checked 2026-10-25 on `main` at `b53dd78`; the chats, the write paths, the
injection detector and the phone approvals re-checked on 2026-10-31.

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
- **Write paths.** Inside the open folder, the file tools write `AGENTS.md` and
  everything under `.agents/` like any other file: without a question in
  *Auto*, with an ordinary write card in *Smart*, where remembered allowances
  apply. The shell's sandbox protects only the global skill folders
  (`protectedWritePaths`).
- **Injection detector** — runs over tool results only (#1011); text the
  prompt embeds by itself (`AGENTS.md`, memory) passes the secret protection
  only. A flag is stored with its tool line in the chat.
- **Phone approvals** — the phone answers cards, also without the window open
  (#1251); it receives a fixed list of fields per card: tool, targets, reason,
  preview.
- **Chats** are stored in full, at most 200 **across all folders**
  (`MAX_CHAT_SESSIONS`); every save drops the oldest beyond that without a
  notice. They are filed under the folder's path, and a chat records only its
  current model, not the model of each turn. The agent has no tool to read
  earlier chats.

The order of the system prompt is described in
[`architecture.md` › *System prompt*](../architecture/architecture.md#system-prompt).
Its diagram, [`agent-text-sources.svg`](../architecture/agent-text-sources.svg),
colours every source by the kind of information it carries, so it shows which
kind is loaded from where and when; the rules files, `load_rule` and
`search_chats` are drawn dashed as planned.

## Decisions

1. **External memory tools are not integrated** (2026-10-13). Snotra's
   knowledge stays in plain Markdown files; only ideas are taken over.
2. **Two questions decide where knowledge goes** (2026-10-31, review; replaces
   the five-step criterion of the same morning and the split of 2026-10-13).
   *What is it?* — a **fact** goes into memory, a **rule** into a rules file, a
   **procedure** into a skill, an **episode** nowhere. *Who should read it?* —
   only the user (global level), Snotra in this folder (`.agents/`), or every
   tool in this folder (`AGENTS.md`). There is no residual kind.
3. **Rules files load on demand, like skills** (2026-10-13): a one-line
   description is always in the prompt, the body is read when the topic comes
   up.
4. **A standing personal instruction is a rule with a condition that always
   holds** (2026-10-25, phrased so on 2026-10-31) — "when you answer me,
   answer in German". It goes into a rules file marked `always: true`, which
   puts its body into the prompt in full. **Learned corrections are `always`
   by default as well** (2026-10-31, review): on demand is for topic rules
   whose occasion can be named.
5. **One tool, `remember`, with a `kind` and a reader** (2026-10-31): `kind`
   is `fact`, `rule` or `instruction`, `scope` is `user`, `workspace` or
   `team`. The agent proposes both; the user can change them on the card.
   There is no separate `add_rule` (reverses 2026-10-25) and no `other`
   (2026-10-31, review).
6. **A card for every write to a knowledge file** (2026-10-25, widened on
   2026-10-31 and in the review): in every permission mode, at both levels,
   for every kind — and through every tool, not only `remember`. The agent may
   write global rules and skills, and `AGENTS.md` in the open folder; it no
   longer writes the global `AGENTS.md` (2026-10-31, review).
7. **Memory gets a review** against a fixed catalogue, in two stages
   (2026-10-25): rule-based hints in the settings panel, and an agent-led
   review in the chat when the user asks for it. `replaces` moves or corrects
   an entry; deleting without a replacement stays with the user. **Rules
   files are reviewed alongside memory** (2026-10-31, review).
8. **Episodes are not stored; the chats are the episodic memory**
   (2026-10-31). The agent gets a read tool to search the chats of the open
   workspace, and the user can have a chat *distilled* — on request first,
   later through an action in the interface. **The chat store is made fit for
   that role** (2026-10-31, review): it no longer forgets silently.
9. **Everything stays under `.agents/`** (2026-10-31). Rules files and skills
   in the workspace are versioned with the folder. Snotra still reads no other
   tool's folders (#103); the format stays close enough to Claude Code's that
   a team can copy files across.
10. **One settings page, *Knowledge*,** holds all four homes (2026-10-25,
    widened on 2026-10-31): skills, rules, facts (memory) and `AGENTS.md`. It
    replaces *Memory*, and the skills page moves into it.
11. **A detected injection warns, it does not block** (2026-10-31). The card
    warns when a tool result anywhere in the chat has been flagged — not only
    in the current run (2026-10-31, review).
12. **The phone sees every knowledge card in full and answers it only as
    proposed** (2026-10-31, review). A phone that does not announce the
    capability may only deny.
13. **A chat that ran entirely on local models stays local** (2026-10-31,
    review). One turn on a cloud model opens the chat for good; a local chat
    never reaches a cloud model through `search_chats` or distilling.
14. **One budget for knowledge in the prompt** (2026-10-31, review), with a
    fixed order in which it gives way.
15. **Precedence between homes** (2026-10-31, review): what the user says now,
    then the more specific condition, then the newer entry. A contradiction
    between the user's own rule and the folder's rule with the same condition
    is named and asked about, never decided silently.

## Where knowledge goes

### What is it?

Asked in this order; the first "yes" decides:

1. **Is it only true right now, or something that happened once without a
   lasting consequence** ("the test is failing", "today we released 1.28.1")?
   Then it is an **episode** and is not stored; see *Episodes*. A decision is
   not an episode: "we chose option A because Y" happened once, but its
   consequence lasts.
2. **Is it several steps towards a goal**, "first …, then …"? Then it is a
   **procedure** (`kind: instruction`) and goes into a skill.
3. **Can it be followed or broken?** Then it is a **rule** and goes into a
   rules file — "always", "never", "whenever", "must" and any order count,
   including one whose condition always holds ("when you answer me, …").
4. **Can it be true or false?** Then it is a **fact** and goes into memory.

The form of the statement decides, as it is phrased — not what it could be
rephrased into, and not its effect: almost every fact changes some step the
agent takes. "Answer me in German" is a rule, "I speak German" a fact; both
are kept, each in its home. When the agent proposes a rule, it phrases it as a
condition — "address me as du" is stored as "when you address me, use du" —
because the condition is what the description and the loading are built from.

### Who should read it?

| Reader | `scope` | Home |
| --- | --- | --- |
| Only the user, in every folder | `user` | `~/.snotra/memory.md`, `~/.snotra/rules/`, `~/.snotra/skills/` |
| Snotra in this folder | `workspace` | `.agents/memory.md`, `.agents/rules/`, `.agents/skills/` |
| Every tool in this folder — Snotra, other agents, the people reading the repository | `team` | `AGENTS.md`, facts and rules only |

`AGENTS.md` is the cross-tool file, and that is the only difference to
`.agents/`: when the folder is a repository, both are usually versioned and
reach the team. The card says so in plain words. Procedures have no `team`
reader; a skill is Snotra's format and stays under `.agents/skills/`.

**Frequency** decides `always` for a rule: a condition that holds in every
turn, and every learned correction, gets `always: true`; a topic rule whose
occasion can be named ("when a commit message is written") loads on demand.

### The table

| Kind of knowledge | Example | Kind | Reader | Home |
| --- | --- | --- | --- | --- |
| Facts about the user | "Works at doubleSlash", "the Microsoft calendar address is …" | fact | user | `~/.snotra/memory.md` |
| Facts about the project, for Snotra | "The board is project number 2", "The relay runs on Firebase" | fact | workspace | `<workspace>/.agents/memory.md` |
| Facts every tool should know | "Tests run with `npm test`", "the package manager is pnpm" | fact | team | `AGENTS.md` |
| Pointers to external resources | the board URL, where the design files are kept | fact | as they apply | memory |
| Decisions and their reasons | "Option A was chosen for X because Y" | fact | workspace | memory of the project, or the project's own docs |
| Standing personal instructions | "When you answer me, answer in German" | rule, `always` | user | `~/.snotra/rules/<topic>.md` |
| Learned corrections | "When `npm ci` runs here, never with `--ignore-scripts`" | rule, `always` | as they apply | rules file of the matching topic |
| Topic rules for Snotra | "When the board is asked about, query the Ready column first" | rule | workspace | `<workspace>/.agents/rules/<topic>.md` |
| Conventions every tool should follow | "When a commit message is written, it is in English", folders not to touch | rule | team | `AGENTS.md` |
| Procedures | how a release is cut, step by step | procedure | user or workspace | `~/.snotra/skills/<name>/` or `<workspace>/.agents/skills/<name>/` |
| State of the current work, past events | "the test is failing", "next we do Y" | episode | — | not stored — the chats |
| Credentials, secrets, data about third parties | — | — | — | nowhere (unchanged) |

Decisions sit with the facts on purpose: a decision says *what was chosen and
why*, and the rule that follows from it ("when X, use Y") is written as a rule
separately. A decision recorded only as a rule loses its reason and gets
overridden at the next disagreement.

### Who writes which home

| Home | User | Agent |
| --- | --- | --- |
| Memory, both levels | edits the file or removes entries in *Settings › Knowledge* | `remember` `kind: fact` |
| Rules files, project and `~/.snotra` | edits the files, creates them from *Settings › Knowledge* | `remember` `kind: rule` |
| Skills, project and `~/.snotra` | edits the files | `remember` `kind: instruction` (whole versions, text only); in the open folder also the file tools, with a card for every write |
| `AGENTS.md` in the open folder | edits the file | `remember` with `scope: team`, into a section of its own |
| `~/.snotra/AGENTS.md` | edits the file | never |
| `~/.agents/…` (rules, skills, `AGENTS.md`) | edits the files | never (legacy location, read only) |

Every write to a knowledge file shows a card, in every permission mode,
whichever tool makes it; see *Knowledge files written by other tools*.

## Rules files

### Location and naming

| # | Path | Level | Written by `remember` |
| --- | --- | --- | --- |
| 1 | `<workspace>/.agents/rules/*.md` | project | yes |
| 2 | `~/.snotra/rules/*.md` | global, default location | yes |
| 3 | `~/.agents/rules/*.md` | global, compatible legacy location | no |

It is the same source list as for skills and `AGENTS.md` (#251), so there is
still only one order to remember. Snotra does not read other tools'
directories (#103): no `.claude/rules/`, no `.cursor/rules/`.

- Only `.md` files directly in the folder count. Subfolders are not read; when
  a rules folder has `.md` files in subfolders, *Settings › Knowledge* says so
  ("3 files in subfolders are not read").
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

- 2026-10-31 — When a commit message is written, it is in English.
- 2026-10-31 (remembered on its own) — When a pull request is opened, it names the issue it closes.
- When an issue is filed, it goes on the board.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `description` | yes, derived when missing | One line, at most 200 characters. It is all the model sees of an on-demand rule, so it names the condition — *when* the rule applies — not only the topic. A file without one gets its description from its first heading (or, without a heading, its first line) and is marked "description derived" in the settings. |
| `always` | no, default `false` | `true` puts the whole body into the prompt in every conversation. For rules whose condition holds in every turn, and for learned corrections. |

**Entries.** Each list item is one rule, phrased as a condition. An entry the
agent writes carries the same prefix as a memory line: the date, and for an
entry the agent proposed on its own the marker in the interface language
("remembered on its own" / "selbst gemerkt"). A line written by hand without a
date stays valid; it simply has no age.

Unknown fields are ignored, so `paths`, `globs` or `alwaysApply` from another
tool do not break a file — they just have no effect.

**What "close to Claude Code" means.** A team can copy a file across in both
directions, but the two tools load it differently: Claude Code loads every
rules file without `paths` in every session and also reads subfolders; Snotra
loads a file on demand unless it says `always: true`, derives a missing
description, and reads no subfolders. `always: false` has no effect in Claude
Code. Linking one folder to the other works for flat folders and is a choice
the team makes knowingly.

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
  telling the model to fetch the body with `load_rule` **before each step whose
  situation matches a description — not only before it starts**. A rule's
  condition often arises in the middle of the work: the commit at the end, the
  `npm ci` while fixing something else.

**Framing.** The user's rules are introduced as their own, given in earlier
conversations. The folder's rules — like the folder's `AGENTS.md` and memory
(#529) — are introduced by where they come from: they live in the folder,
where a teammate or a cloned repository can have put them, they are not the
user's own words and do not outweigh what the user says now.

**`load_rule`** takes a name and a level (`workspace` or `user`) and returns
the body. It is a read tool, never shows a card, and its trace line reads
"Rule *release* (project)". It is a tool of its own rather than another use of
`load_skill`: a skill brings a procedure and can carry files and scripts, a
rule is a condition, and the trace and the permissions should say which of
the two was read. Its result is treated like a skill body: it guides how the
work is done, but it cannot grant a permission
(`TOOL_RESULTS_ARE_DATA_RULE` names skill content already and is extended to
rules).

### Order and precedence

Files are read in the source order above, and inside a source alphabetically.
That is a reading order. When two entries contradict each other, the prompt
states the precedence (decision 15):

1. what the user says in the current conversation;
2. the more specific condition over the more general one — "when a commit
   message is written" beats "when you write";
3. the newer entry over the older one, by its date.

When the user's own rule and the folder's rule say different things under the
same condition, the agent names the contradiction and asks once; it does not
pick one silently. A folder must not be able to override the user by winning a
precedence rule, and the user's personal habit must not quietly break a
team's convention either.

Two files of the same name at the project and the global level are both
listed — they complement each other. The same name in `~/.snotra/rules` and
`~/.agents/rules` is the one case where the first hit wins, as with skills:
both are the user level, and the legacy file is shown as shadowed.

### Limits

| What | Limit | Beyond the limit |
| --- | --- | --- |
| `description` | 200 characters | cut in the prompt, marked in the settings |
| Body of one file | 20,000 characters, as `AGENTS.md` and skill bodies | visibly truncated, as `AGENTS.md` |
| Files per source | 50 | ignored, marked |
| Bodies of `always: true` files | 8,000 characters per level in total | the file that came in **last** is offered on demand instead — never, silently, an older one — and marked in the settings and the context breakdown; a `remember` call that causes it says so on its card |

The `always` budget has the size of a memory level because that size has
proven itself for text that goes along with every request. It is added to
memory's 8,000 characters; it does not replace them. Falling back to on demand
instead of truncating keeps a rule whole: half a rule is worse than one that
has to be fetched.

### Knowledge budget

The limits above are per file and per level. On top of them, everything this
concept puts into the prompt without being asked — memory, the `always`
bodies, `AGENTS.md` and the catalogue of on-demand rules — shares **one
budget**, measured against the context window of the current model: at most a
quarter of it. Without that cap the worst case is around 130,000 characters
before the first message, too much for a local model with a small window.

When the budget does not suffice, the knowledge gives way in this order:

1. the catalogue of on-demand rules: beyond 40 entries per level, names only,
   without descriptions;
2. the folder's `always` rules are offered on demand instead;
3. `AGENTS.md` is visibly truncated;
4. the user's own `always` rules are offered on demand instead.

Memory always stays whole; it is capped already. Every step that applies shows
in the context breakdown. The skills catalogue keeps its own handling.

### Context breakdown

Following #174: one row per level for the catalogue of on-demand rules, and one
row per `always` file, each with its path, size and the markers for truncated,
withheld, over budget or given way to the knowledge budget. A body fetched with
`load_rule` shows up where every tool result does.

### Safeguards

The same as for `AGENTS.md` and memory, nothing weaker:

- **Regular files inside their source.** The rules folder and every file in it
  must resolve inside the workspace (or inside `~/.snotra` / `~/.agents`) after
  following links; a symlink that leads out is not read (#534).
- **Secret protection** (#528). The `always` bodies and the descriptions are
  embedded without being asked for and so pass `embedded-text-guard.js`; a
  body fetched with `load_rule` passes the secret protection of a tool result.
- **Covert signals in embedded text.** The folder's `always` bodies,
  descriptions, `AGENTS.md` and memory are checked for the covert signals of
  the injection detector when they are loaded — hiding something from the
  user, sending secrets, revealing the prompt, image beacons, acting "without
  the user". The instruction patterns ("from now on", "addressed to the
  agent") are left out: these files are instructions by design, as skills are,
  which the detector skips for that reason. A hit is marked in the context
  breakdown and in *Settings › Knowledge* and counts for the warning on the
  card.
- **Switches.** The rules section has a switch of its own, and every file has
  one. For the project level they are the emergency brake for a foreign folder,
  as the `AGENTS.md` switch is: a cloned repository can bring rules files the
  same way it brings an `AGENTS.md`. Like the skill switches, the state lives in
  the app's settings, not in the folder, so a folder cannot switch its own
  rules back on.
- **Protected write paths.** Rules files are knowledge files; see
  *Knowledge files written by other tools*.

## Writing: `remember`

One tool for every kind. The model names a kind, a reader and — where the kind
needs it — a topic or a name, never a path.

| Parameter | Meaning |
| --- | --- |
| `kind` | `fact`, `rule` or `instruction` — the agent's proposal |
| `scope` | `user`, `workspace` or `team` — who should read it. The agent asks before the call, as #416 asks for the level today; `team` needs an open folder and takes facts and rules only |
| `text` | `fact` and `rule`: the entry, one thought, at most 500 characters |
| `body` | `instruction` only: the complete body of the skill, at most 20,000 characters |
| `topic` | `rule`: the rules file's name; `instruction`: the skill's name. A new file is created when it does not exist |
| `description` | required when a new rules file or skill is created; for an existing one an optional new description, shown on the card as old → new |
| `always` | `rule` only, and only for a new file; an existing file keeps its setting |
| `origin` | `requested` or `self`, truthfully (#553); the switch for unprompted remembering applies to every kind. An entry proposed in a review or a distillation the user asked for counts as `requested` |
| `replaces` | optional: the exact text of an existing entry at the same level — a memory line or a list item in the body of a rules file, never a frontmatter line or a heading — removed once the new entry is written. Across kinds, so a memory entry can become a rule |
| `replaces_in` | optional: where that entry is — `memory` or a rules file's topic. Without it the text must be unambiguous: matches in more than one file are refused; identical copies in one file are removed together |

**What each kind writes:**

- `fact` — a dated line in the level's `memory.md`, as today; with `scope:
  team`, the same line in the Snotra section of `AGENTS.md`.
- `rule` — a dated list item in `<level>/rules/<topic>.md`, the file created
  with its frontmatter when it is new; with `scope: team`, the same item in the
  Snotra section of `AGENTS.md`.
- `instruction` — a whole version of `<level>/skills/<topic>/SKILL.md`: a new
  skill is created with `name`, `description` and, under `metadata`, the date
  and the origin of the write; an existing skill is replaced by the new
  version. A procedure needs its steps in the right place, so it is never
  appended to. **Text only:** no scripts and no further files; that stays with
  the file tools in the open folder.
- The **Snotra section of `AGENTS.md`** is a heading of its own at the end of
  the file, in the interface language ("Added by Snotra" / "Von Snotra
  ergänzt"), created with the file when either is missing. What the team wrote
  above it is never touched.

`replaces` writes first and removes second. When the removal fails, both
entries remain and the result says so: a duplicate, never a loss.

**The card** is shown for every call, in every permission mode. Auto mode does
not approve it, and no persistent allow rule covers it. It shows:

- the kind and the reader, both changeable. Changing the reader, or changing
  the kind to `fact`, happens on the card. Changing the kind to `rule` or
  `instruction` goes back to the agent with the user's choice, in one short
  round: a rule has to be phrased as a condition and needs a topic and a
  description, a procedure needs its steps — content the card cannot invent;
- the target file, whether it is new, and what the reader means: for
  `workspace` "read by Snotra in this folder; versioned with the folder if it
  is a repository", for `team` "`AGENTS.md` is read by every tool in this
  folder and usually shared with the team";
- for a rule: the `always` marker; for `user` with `always` the line
  "applies in every folder, in every conversation"; and when the new file no
  longer fits the `always` budget, that it will be offered on demand instead;
- for a procedure: the diff against the current version, and at the user level
  that the skill is offered in every folder;
- the description, as old → new when the call changes it;
- the entry itself, and the entry `replaces` would remove, as old → new;
- when the target section or file is switched off: that the entry will not
  take effect until it is switched on — written all the same;
- a warning when a tool result anywhere in this chat has been flagged by the
  injection detector, or the folder's embedded text has shown a covert signal;
- for `scope: user`, when the open folder brings instructions of its own: "This
  folder brings its own instructions: `AGENTS.md`, 2 rules files". That line
  is a fact, not a guess, so it holds where the detector sees nothing — and it
  marks the one path that matters most, from a foreign folder into every
  folder.

**Refusals.** The tool refuses an invalid topic or name, a file that would
exceed its limit, `workspace` or `team` without an open folder, `team` for a
procedure, and a `replaces` entry that cannot be found or is ambiguous
(nothing is written).

**Hints instead of refusals.** The result — and the card — adds a hint when a
`fact` reads like a rule or a procedure, or when any entry reads like an
episode (the heuristics of the panel hints below), so that the model or the
user can correct course. Nothing is refused for its kind: telling the kinds
apart reliably needs the model, and a decision written in the past tense is a
fact that a word list would take for an episode.

The tool keeps its switch in the tool settings. The decision of 2026-10-25 for
a separate `add_rule` and against a `kind` parameter is reversed: only one tool
lets the user re-sort on the card, without rejecting and asking again.

### Knowledge files written by other tools

Knowledge files are `<workspace>/AGENTS.md`, `<workspace>/.agents/memory.md`,
`<workspace>/.agents/rules/**` and `<workspace>/.agents/skills/**`, and at the
global level `~/.snotra/{memory.md,AGENTS.md,rules,skills}` and
`~/.agents/{AGENTS.md,rules,skills}`. A card on `remember` alone would protect
the tool, not the files: an injection that wants to persist would simply use
`write_file` or the shell. So
([#1319](https://github.com/kkrafft1999/snotra/issues/1319)):

- **File tools in the open folder.** Every write to a knowledge file gets a
  card in every permission mode; no remembered allowance covers it. The card
  shows the file, its level, the diff, the `always` marker read from the
  frontmatter, and the warnings of the `remember` card. A skill of several
  files brings one card per write.
- **Shell in the open folder.** Not blocked — `git pull`, `git checkout` and
  `git merge` change `AGENTS.md` and `.agents/` legitimately. Before each
  command Snotra records the state of the knowledge files; when a command
  changed one, a card follows with the diff and *Keep* / *Reset*. Until the
  user has answered, the changed file is not put into the prompt.
- **Global level.** The file tools cannot reach it, as today. Every global
  knowledge path becomes a protected write path of the sandbox; no legitimate
  command needs to write there, so `remember` is the only writer.

### Approvals on the phone

The phone receives every knowledge card — from `remember`, from a file-tool
write and from the check after a shell command — **in full**: kind, reader,
target file, `always` marker and its line, old → new or the diff, the
injection warning and the folder line. It answers only **Allow as proposed**
or **Deny**; changing the kind or the reader stays on the desktop. The phone
announces a capability for knowledge cards when it connects; a phone that does
not — an older app — is offered *Deny* only, with "answer on the desktop". The
desktop side belongs to #1276 and #1319, the app side to
[snotra-mobile#92](https://github.com/kkrafft1999/snotra-mobile/issues/92).

### `snotra-memory`

The system skill stays the one place for writing guidance and covers every
kind. It gets:

- the two questions, in short, with the episode test first;
- examples per kind and reader: "Tests run with `npm test`" moves from the
  memory examples to a `fact` for the `team`; "address me as du" becomes a
  `rule` at the user level with `always: true`, phrased as a condition; a
  learned correction is a rule with `always: true`;
- a section on the review and one on distilling (below), including that their
  proposals count as `requested`;
- an updated description, so that "remember that we always …", "review my
  memory" and "what do we take away from this?" load it as well.

It must stay small: the system skills share the context budget (see the size
limit found for `snotra-capabilities`), so the full explanation goes into the
manual and the skill keeps the rules of thumb. `snotra-skill-authoring` is
updated as well: a global skill no longer has to be moved by hand, and
`remember` writes a skill as a whole version.

## Episodes

An episode is something that happened once, at a time: "on 30 October we
released 1.28.1 and had to fix the manual marker". A skill also has a sequence,
but it is a recipe that holds every time; an episode is an entry in a diary.
Episodes go stale, and stored as notes they only pile up. They are not kept in
any of the homes above.

- **The chats are the episodic memory** — which only holds when the chat store
  does not forget behind the user's back
  ([#1320](https://github.com/kkrafft1999/snotra/issues/1320)): a limit per
  folder instead of one across all folders, an overall ceiling that is
  announced rather than applied silently, a *Keep* marker that no limit
  touches, and *Assign to this folder* for chats whose folder was renamed or
  moved. Chats without a folder form a bucket of their own.
- **`search_chats`** lets the agent search the chats **of the open
  workspace** — never those of other folders; with no folder open, the chats
  without a folder — and returns excerpts with title and date. It shows no
  card; its results are tool results, data and not instructions, and pass the
  secret protection and the injection detector like any other.
- **Local chats stay local** (decision 13). A chat is local when every one of
  its turns ran on a local model (Ollama, MLX, an endpoint on `localhost`).
  One turn on a cloud model opens it for good: the user chose to go public,
  and the whole history went to that provider with that turn. A marker set at
  the first cloud turn records it; older chats, which record only their
  current model, count as local when that model is local. From a chat on a
  cloud model, `search_chats` and distilling do not see local chats at all —
  not even a count of hidden matches, which would itself tell the provider
  something. From a local chat, everything in the folder is found. When a local
  chat switches to a cloud model, Snotra says once that the whole chat so far
  goes to that provider and that the chat is no longer local.
- **Distilling** draws what is lasting out of an episode. On request ("what do
  we take away from this?") the agent goes through the chat and proposes one
  item at a time, each as a `remember` call with its kind, its reader and its
  card; these proposals count as `requested`. Episodic content itself is not
  proposed. Later an action in the chat interface starts the same; the agent
  does not offer it on its own at the end of a run.
- The state of the work in a development project stays where it is: in the
  issues.

## Review and migration

### Hints in the settings

*Settings › Knowledge* marks entries without any model call. The word lists
cover every language Snotra knows, not only the interface language: an entry
may be written in another one.

| Hint | For | When | Actions |
| --- | --- | --- | --- |
| Reads like a rule | memory | contains a condition or *always*, *never*, *whenever*, *must* | *Move to rules…* |
| Reads like a procedure | memory | an enumeration of steps, "first … then …" | *Create a skill…* |
| Reads like an episode | memory, rules | "today", "next", past tense describing an event — not a reason ("because …") | *Remove*, *Distil…* |
| Nearly the same as another entry | memory, rules | normalised word overlap of at least 80 % with an entry of the same level — in the same file, in another rules file or between memory and rules; across levels, "also kept globally" | *Remove*, *Edit* |
| Similar topic names | rules | two files of a level whose names differ only slightly (`commit`, `commits`) | *Merge…* |
| Noted a while ago | memory, rules | the entry's date is more than 180 days old — "noted on <date>; still true?" | *Remove*, *Edit* |
| Close to the limit | memory, rules | the file is at 80 % of its limit, or the level's `always` budget is used up | — |

*Move to rules…*, *Create a skill…* and *Merge…* ask for what is missing (level,
topic) and write the files; the old entries are removed with it. Nothing
changes without the user's click. The heuristics only point at candidates; a
hint that is wrong can be dismissed and stays dismissed for that entry.

### Review in the chat

When the user asks for it ("review my memory", "review my rules"), the agent
goes through memory and the rules files of both levels against the catalogue —
duplicates, contradictions in meaning, snapshots that have gone stale, entries
of the wrong kind or for the wrong reader — and proposes **one change at a
time**, each as `remember` with `replaces` and the fitting kind. The proposals
count as `requested`: the user asked for the review, so the switch for
unprompted remembering does not stop it. An entry that should simply go is
named, with a pointer to *Settings › Knowledge*; the agent cannot delete it.

The agent does not start a review on its own. When memory is close to the
limit it may mention once that a review would help.

### Undo

*Settings › Knowledge* lists the agent's recent changes to knowledge files —
date, kind, file, old → new — with *Undo*. The previous versions are kept in
the app's own storage, not in the folder: the last 50 changes. It covers
`remember`, including what `replaces` removed, and the cards of
*Knowledge files written by other tools*.

### Existing entries

No automatic migration. Existing memory entries stay valid and keep working,
including the ones that are really rules; the hints mark them, and the user
moves them when it suits them. Existing `AGENTS.md` files are not touched. The
release notes and the manual explain the new split once.

## Settings › Knowledge

*Settings › Memory* becomes *Settings › Knowledge* (*Einstellungen › Wissen*),
with four sections in this order:

1. **Skills** — the skills per level, as on today's skills page, which moves
   here.
2. **Rules** — per level, every rules file with name, description, an `always`
   marker, size, state (invalid, description derived, truncated, over budget,
   shadowed, files in subfolders not read), its switch and *Open in editor*; a
   switch for the whole section; *New rules file*, which creates a file with
   the frontmatter filled in.
3. **Facts** — memory as today, plus the hints and their actions.
4. **`AGENTS.md`** — the files found, each with its path, size and state
   (truncated, withheld, given way to the budget), and *Open in editor*. The
   switch *Send `AGENTS.md`* moves here from *Settings › General*.

Below them, the agent's recent changes with *Undo*.

**One word, one meaning.** The interface and the manual call `AGENTS.md`
"project instructions" (*Projektanweisungen*). The kind `instruction` therefore
gets another word wherever a user reads it — on the card and on this page. The
proposal is *Procedure* (*Ablauf*) for the kind and *Skills* for the section;
it is settled with the mockup.

The visual layout is worked out as a mockup in the follow-up issue, as
[`ux-ui-standards.md`](../../.claude/rules/ux-ui-standards.md) asks; the
structure above is what is decided. Renaming the page and moving the skills
page touch every place that quotes the menu paths: the manual, the catalogue
placeholder that `snotra-memory` uses, `snotra-capabilities`, and the context
breakdown labels. Both interface languages, as always.

## Security

The agent can now write three things that apply in every later conversation —
rules, skills and `AGENTS.md` — and rules and skills at the global level, in
every folder. A prompt injection that gets one write approved would outlive
the run it came from. The concept answers that with:

- a card for every write to a knowledge file — through `remember`, the file
  tools or the shell — in every permission mode, never covered by a persistent
  allow rule;
- a card that names the kind, the reader, the file and the `always` marker
  plainly — "applies in every folder, in every conversation" is the line the
  user must not miss — and the same content on the phone, which may only
  allow what it can show;
- a warning on the card when a tool result anywhere in the chat has been
  flagged, or the folder's embedded text has shown a covert signal — a
  warning, not a block (decision 11);
- the line "this folder brings its own instructions" on every global write
  from such a folder, independent of the detector;
- skills written by `remember` are text only: no scripts, no further files;
- a switch for the tool, a switch for the rules section and one per rules file;
- the global knowledge paths protected against the file tools and the shell;
- an undo for what the agent changed.

How rules files, agent-written skills and agent-written `AGENTS.md` enter the
threat model and the quality requirements is filed as
[#1280](https://github.com/kkrafft1999/snotra/issues/1280). It is decided
**before** #1276 and #1314 ship, not alongside them: global skills have been
out of the agent's reach since #160, and widening that needs the threat model
first. `docs/security/security-concept.md` and
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
- **Loading rules by matching the request**, the way skill suggestions match
  it (#125). If on-demand rules turn out to be missed despite the prompt
  sentence, this is the next step.
- **Reading other tools' rules or skills folders** (#103).
- **Automatic capture** of knowledge at the end of a run. Nothing is kept
  without a card, and distilling starts only on request.

## Follow-up issues

Filed on 2026-10-25, reworked and extended on 2026-10-31. Their order follows
the dependencies:

1. [#1280](https://github.com/kkrafft1999/snotra/issues/1280) **Security: rules
   files, agent-written skills and `AGENTS.md` in the security concept and the
   quality requirements**, including the covert-signal check of embedded text
   — comes first; #1276, #1314 and #1319 depend on it.
2. [#1275](https://github.com/kkrafft1999/snotra/issues/1275) **Rules files:
   read and load on demand** — contract, port and adapter, dated entries, the
   derived description, the rules block with its framing, precedence and
   prompt sentence, `load_rule`, the `always` budget, the knowledge budget, the
   context breakdown, safeguards, the update of `architecture.md` and
   `agent-text-sources.svg`.
3. [#1319](https://github.com/kkrafft1999/snotra/issues/1319) **Knowledge
   files: a card for every file-tool write and a check after shell commands**
   — depends on #1280 and #1275.
4. [#1276](https://github.com/kkrafft1999/snotra/issues/1276) **`remember`
   gains `kind` and the `team` reader: rules files and `AGENTS.md` with a
   card** — the card with its switches and lines, `replaces` and
   `replaces_in`, the injection warning for the whole chat, the phone fields
   and capability on the desktop side — depends on #1280 and #1275.
5. [snotra-mobile#92](https://github.com/kkrafft1999/snotra-mobile/issues/92)
   **Show knowledge cards in full and answer them only as proposed** — depends
   on #1276 and #1319.
6. [#1314](https://github.com/kkrafft1999/snotra/issues/1314) **`kind:
   instruction`: write a skill as a whole version, at the global level too** —
   depends on #1280 and #1276.
7. [#1277](https://github.com/kkrafft1999/snotra/issues/1277) **The two
   questions, hints instead of refusals, `snotra-memory` rewritten** — depends
   on #1276.
8. [#1278](https://github.com/kkrafft1999/snotra/issues/1278) ***Settings ›
   Knowledge*** with four sections, the skills page moved in, the undo list,
   one word per meaning, mockup first, manual pages in both languages —
   depends on #1275.
9. [#1279](https://github.com/kkrafft1999/snotra/issues/1279) **Hints for
   memory and rules, *Move to rules…*, *Create a skill…* and *Merge…*** —
   depends on #1276, #1314 and #1278.
10. [#1320](https://github.com/kkrafft1999/snotra/issues/1320) **Chat store as
    episodic memory: limit per folder, keep marker, reassign orphaned chats**
    — independent.
11. [#1315](https://github.com/kkrafft1999/snotra/issues/1315) **`search_chats`**,
    with local chats kept local — depends on #1320.
12. [#1316](https://github.com/kkrafft1999/snotra/issues/1316) **Distil a chat
    on request** — depends on #1276 and #1277.
13. [#1317](https://github.com/kkrafft1999/snotra/issues/1317) **Distil action
    in the chat interface** — depends on #1316.
