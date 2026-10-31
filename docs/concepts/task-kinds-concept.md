# Kinds of task

Concept from 2026-10-25, tracked in
[#1259](https://github.com/kkrafft1999/snotra/issues/1259). The decisions
below were made by the owner, one question at a time; the implementation is
split into the follow-up issues listed at the end.

The usage report ([#1258](https://github.com/kkrafft1999/snotra/issues/1258))
says what was spent per model and per workspace. It cannot say **what the
money was spent on**: whether simple lookups run on the most expensive model,
how much goes into coding versus writing, where a cheaper model would do. For
that every chat gets a **kind of task**, and the report gains a third grouping
by it.

## Starting point (checked 2026-10-25, `main` at `b53dd78`)

- Nothing about the kind of task is stored with a chat.
- The usage report adds up the history's **index** — each entry carries its
  chat's `SessionCost` with day entries per provider and model
  (`src/shared/contracts/cost.js`, `usage-report.js`) — without opening a chat
  file. The history keeps the 200 most recent chats.
- After the first exchange the conversation service lets the chat's own model
  **name the chat** (`nameChat` in `conversation-service.js`, `generateTitle`
  in `chat-engine.js`, #359): one small request with the first question and
  the first answer, each clipped to 1,200 characters, no tools, a 20-second
  limit. It runs once per chat, as long as the title is still the one derived
  from the question. Its cost is not booked yet;
  [#1266](https://github.com/kkrafft1999/snotra/issues/1266) changes that.

## Decisions

| # | Question | Decision |
| - | -------- | -------- |
| 1 | The set of kinds | Six kinds; *Coding* includes debugging. A seventh, *Organisation*, added 2026-10-31 (#1312) |
| 2 | Fixed or user-defined | Fixed list only, stored as a stable id |
| 3 | Granularity | One kind per chat |
| 4 | How a chat gets its kind | Asked for together with the title; a local estimate when that fails; the user's choice always wins |
| 5 | Existing chats | Stay unclassified until the user sets a kind or continues the chat |
| 6 | Where it shows | Chat header and the usage report, both correctable |

The sections below spell each one out, with the options that were turned
down.

## 1. The kinds

| Id | English | German | Definition (the classifier and the user work from it) |
| -- | ------- | ------ | ------------------------------------------------------ |
| `coding` | Coding | Programmieren | Writing, changing, reviewing or debugging code, scripts and configuration. |
| `writing` | Writing & editing | Schreiben & Überarbeiten | Drafting, revising, shortening or translating prose: mails, documents, posts. |
| `research` | Research & questions | Recherche & Fragen | Looking something up, having something explained, searching the web or a folder for an answer. |
| `data` | Data & analysis | Daten & Analyse | Evaluating data, tables or logs, calculating, building charts. |
| `planning` | Planning & concepts | Planung & Konzepte | Working out a concept, an architecture, a plan or a decision between options — what to build and how, not managing tasks or time. |
| `organisation` | Organisation & admin | Organisation & Verwaltung | Managing tasks, time and files: booking hours, keeping to-dos, tickets and calendars up to date, sorting mail, restructuring folders or a workspace. |
| `other` | Other | Sonstiges | Anything that fits none of the above. |

*Unclassified* (German *Nicht eingeordnet*) is **not** a kind. It is the
report's name for chats that have none yet, and it is never offered as a
choice.

- **Coding and debugging are one kind.** Almost every debugging chat ends in a
  code change, so two kinds would split the same chats arbitrarily and make
  the classification unstable. The price: the report cannot single out
  debugging.
- **Turned down:** the seven kinds from the issue (*Debugging* separate, see
  above), and a seventh kind *Files & documents* for sorting, renaming and
  converting files — it overlaps with *Data & analysis* and *Writing*.

## 2. A fixed list

The seven kinds are built in, with both names and definitions in the i18n
catalogues and the definitions in English on the model channel. A report stays
comparable over months, the classifier works from one fixed prompt, and no
settings page is needed.

What is stored is the **id**, never a label. User-defined kinds could be added
later without migrating data; they are not planned. **Turned down:** user-
defined kinds next to the fixed ones — a settings page, user text inside the
classifier prompt, no translation, and a rule for chats of a deleted kind.

## 3. One kind per chat

A chat has exactly one kind, and all its cost counts towards it. That is the
easiest model to understand and to correct, and it fits the report's chat rows.
A chat that starts as research and turns into coding counts entirely under
the kind it got.

**Turned down:** a kind per run, which would put a third key into the cost
day entries of #1258 and need a classification and a correction per run; and
a per-chat kind copied into each day entry at booking time, where a correction
either rewrites the past or does not — both hard to explain.

## 4. How a chat gets its kind

### Where it is stored

The stored chat gains a field next to its title, mirrored into the history's
index entry so the report reads it without opening a chat file:

```js
taskKind: {
  id: 'coding',          // one of the seven ids
  source: 'model',       // 'model' | 'estimate' | 'user'
  at: '2026-10-25T14:20:10.000Z',
}
```

A chat without the field is unclassified. An unknown id read from disk — from
a newer version, say — counts as unclassified too and is kept as it is.

### The three sources

1. **Model** — the request that names the chat asks for the kind as well. Its
   system prompt gains the seven ids with their definitions and asks for a
   second line holding one id. The title is taken from the first line as
   today; a second line that is not one of the seven ids is ignored and the
   estimate below applies instead. When the chat already has a real title (the
   user renamed it before it was named, or an older chat is continued) but no
   kind, the same request is sent asking for the kind only.
2. **Estimate** — when the request fails, times out or answers with no valid
   id, a local heuristic looks at the tools the chat used and the files they
   touched. It only answers when one signal clearly dominates, and otherwise
   leaves the chat unclassified rather than guess:
   - writes to source files (`edit_file`, `apply_patch`, `write_file_text`
     with a code extension) or build and test commands in `shell_execute` →
     `coding`
   - `run_python`, or reading tabular data (`.csv`, `.xlsx`, `.json`) without
     writing code → `data`
   - writes to prose files (`.md`, `.txt`, `.docx`) → `writing`
   - only `web_search`, `fetch_url` or the reading tools, nothing written →
     `research`

   *Planning*, *Organisation* and *Other* are never estimated: no tool tells them apart.
3. **User** — the user picks a kind. That choice is **never overwritten**, not
   by a later request and not by an estimate.

A model answer replaces an estimate (when a later turn retries the request); an
estimate never replaces a model answer. In short: `user` > `model` >
`estimate`. A first version offers no way back from a user's choice to
"automatic"; picking another kind is enough.

### Cost and privacy

- **No new content leaves the computer, and no new recipient gets it.** The
  request sends what the title request already sends — the first question and
  the first answer — to the provider and model the user chose for that chat.
  The kind-only request for a chat that is continued sends a part of what the
  turn itself sends anyway. That is why there is no opt-in.
- **The extra cost is small:** about 150–200 input tokens for the definitions
  and a few output tokens, once per chat, on the chat's model. On a model at
  $5 per million input tokens that is about a tenth of a cent. The kind-only
  request costs about as much as a title request. Both are booked like the
  title request once #1266 is in.
- **A local model works the same way** and costs nothing.
- **Turned down:** a separate request that reads the whole chat (better for
  chats that change course, but a second full send per chat, an opt-in and a
  model choice); the heuristic alone (most chats use no tools, so it cannot
  tell them apart); and manual only (most chats would stay unclassified and
  the report would lose its point).

## 5. When it happens, and existing chats

- **New chats** get their kind after the first exchange, together with the
  title. Nothing is classified at the end of a run or when the report opens.
- **Existing chats** — everything from before the feature — stay unclassified.
  They show up as *Unclassified* in the report, and the user can set their
  kind by hand. A continued chat gets its kind on its next turn, like a new
  one. There is no batch run over old chats: it would send old content once
  more and need a progress dialog, cancelling and error handling, for a set
  that leaves the usual periods within weeks and the history after 200 chats.
- **Turned down:** running the heuristic over all existing chats once (it
  cannot tell most of them apart), and a *Classify N chats…* action in the
  report (the most work, and it sends old content again).

## 6. Where it shows

- **Chat header.** A small element next to the title shows the kind. Clicking
  it opens a choice of the seven kinds that also says where the current one
  came from: *Suggested by the model* / *Vom Modell vorgeschlagen*,
  *Estimated by Snotra* / *Von Snotra geschätzt*, *Set by you* / *Von dir
  gesetzt*. An unclassified chat shows the element in a muted state that
  invites a choice. It is reachable and operable by keyboard like the rest of
  the header.
- **Usage report.**
  - A third grouping *Task kind* / *Aufgabenart* next to *Model* and
    *Workspace*.
  - Its rows unfold into the models used for that kind — the question the
    feature exists for: which model did which kind of work.
  - *Unclassified* is a row of its own whenever it holds anything, so the
    three groupings add up to the same total. It is never filtered out.
  - In the report's chat list each chat shows its kind and can be changed
    there; the figures update at once.
- **Not in the sidebar.** No icon per chat in the chat list: every row would
  get fuller, and six icons that are told apart at a glance are hard to find.
- The exact look of the header element and the report rows is decided in
  their implementation issues, from a mockup, as
  [`ux-ui-standards.md`](../../.claude/rules/ux-ui-standards.md) asks.

## Out of scope

- Kinds on the phone (remote interface).
- Filtering the chat list by kind.
- User-defined kinds, a kind per run, a batch classification of old chats —
  turned down above.

## Follow-up issues

The implementation is split so that each part can be reviewed on its own.
The first one touches the conversation service and the chat engine, so it
starts after [#1266](https://github.com/kkrafft1999/snotra/issues/1266) is
merged.

1. [#1281](https://github.com/kkrafft1999/snotra/issues/1281) — store a
   chat's kind and classify it with the title request (contract, storage,
   model, estimate, precedence). Starts after #1266.
2. [#1282](https://github.com/kkrafft1999/snotra/issues/1282) — show and
   correct the kind in the chat header. Needs #1281.
3. [#1283](https://github.com/kkrafft1999/snotra/issues/1283) — group the
   usage report by kind of task. Needs #1281.
