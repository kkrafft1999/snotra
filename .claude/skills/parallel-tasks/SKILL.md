---
name: parallel-tasks
description: >-
  Builds an overview of what is already running and proposes 3–5 further tasks
  from the board that can run in parallel with it, each with a suggested model
  and reasoning effort; the user picks tasks and models, and every picked task
  is started as its own linked Claude Code session. Triggers on sentences like
  "was kann ich parallel angehen?", "gib mir die nächsten Aufgaben zum
  Parallelisieren", "Übersicht über mögliche nächste Aufgaben", "was können wir
  noch parallel starten?", "starte weitere Aufgaben in eigenen Sessions",
  "what can run in parallel?", "propose the next parallel tasks", "start more
  tasks in separate sessions". Only makes sense in this repository (snotra) and
  in the Claude desktop app, where sessions can be started.
---

# Propose parallel tasks and start them as sessions

The user wants a short menu: what is running, and three to five more things
that could run next to it. They decide; this session then starts the picked
tasks, each in a session of its own, and stays free for the conversation.

Talk to the user in German (see [`language.md`](../../rules/language.md)); the
briefs handed to the new sessions are English, like everything else in the
project.

## Step 1 — what is already in flight (brief, without asking)

Collect in parallel, keep the output terse:

1. **Other sessions** — `mcp__ccd_session_mgmt__list_sessions` (not archived,
   `limit` 30). Keep the ones that work in this repository and are running or
   waiting on the user; note title, branch and PR. Issue numbers in a title or
   branch (`#1033`, `…-1033-…`) mark that issue as taken.
2. **Open pull requests** — `gh pr list --repo kkrafft1999/snotra --state open
   --json number,title,headRefName,files`. The `files` tell which areas are
   busy.
3. **Worktrees and local state** — `git worktree list` and `git status
   --short` in the main checkout. Uncommitted work is in flight too.
4. **The board, open issues only** — never drop the `--query`, see
   [`task-management.md`](../../rules/task-management.md):
   ```sh
   gh project item-list 2 --owner kkrafft1999 --query "is:issue is:open" \
     --limit 200 --format json
   ```
   Then `gh issue list --repo kkrafft1999/snotra --state open --limit 100` for
   open issues the board misses.

Read single issues (`gh issue view <nr>`) only for the candidates you are about
to propose — not the whole backlog.

## Step 2 — choose 3–5 candidates

Order of preference: **Ready** first, then Backlog. Skip anything that is
already taken (Step 1) or explicitly parked (a label, a comment such as
"zurückgestellt", "wait for", "blocked by").

A candidate must be **parallel-safe**:

- **No shared files** with a running session, an open PR or another candidate.
  Estimate the area from the issue text and a quick `grep`/`ls`; when two
  candidates would both touch, say, `src/renderer/chat/` or the same rule
  file, keep only one.
- **No dependency** on unmerged work or on another candidate.
- **No release work** (`release` skill, version bump) and nothing under
  `.github/workflows/` — those serialise everything else.
- **Bounded:** one session can finish it to a merged PR. An epic is not a
  candidate; one of its child issues may be.

If fewer than three parallel-safe tasks exist, propose fewer and say why. Never
pad the list.

## Step 3 — model and effort for each candidate

Suggest the cheapest setting that still solves the task **reliably** — when in
doubt, one step up. A failed run costs more than the difference.

| Model (ID) | Use it for | Typical effort |
| --- | --- | --- |
| Haiku 5.5 (`claude-haiku-5-5`) | Mechanical, fully specified: regenerating screenshots, renaming, a label or wording fix, a dependency bump with green tests, read-only lookups. | `low`–`medium` |
| Sonnet 5.5 (`claude-sonnet-5-5`) | A well-described feature or bug in one area with a clear repro or acceptance criteria; writing tests; translating a document (#281-style). | `medium`–`high` |
| Opus 5.5 (`claude-opus-5-5`) | Cross-cutting changes, architecture findings (AR-xx), IPC/concurrency/timing, flaky tests without a known cause, sandbox and security, visible UI that has to meet [`ux-ui-standards.md`](../../rules/ux-ui-standards.md). | `high`–`xhigh` |
| Fable 5.1 (`claude-fable-5-1`) | Only the hardest, long-running pieces: a root cause across processes after earlier attempts failed, a redesign of the security concept. About 2.5× the price of Opus — name the reason. | `high`–`xhigh` |

`max` effort only when correctness clearly outweighs cost and `xhigh` has
already fallen short on this kind of task.

**Limit of the app:** `start_session` only accepts a model of the same family
or cheaper, and an effort at or below this session's own. Anything higher is
ignored at start. Check this session's model (system prompt) before
presenting: if a suggestion lies above it, mark it in the table and see Step 5.

## Step 4 — present and let the user decide

First a short block **"Läuft bereits"**: one line per running session or open
PR (title, link, area). Then a table, numbered, one row per candidate:

| # | Aufgabe | Worum es geht / was es braucht | Bereich | Modell · Effort | Warum |
| --- | --- | --- | --- | --- | --- |
| 1 | [#1234 Title](https://github.com/kkrafft1999/snotra/issues/1234) | One sentence. | `src/main/…` | Sonnet 5.5 · medium | Half a sentence. |

Never bare issue numbers — title and one sentence each, so the user can pick
without opening an issue.

Then ask with `AskUserQuestion`:

1. **Which tasks?** — `multiSelect: true`, one option per candidate, label
   `#<nr> <short title>`, description = model · effort. A question holds at
   most four options: with five candidates, split them over two questions
   ("Aufgaben 1–3", "Aufgaben 4–5").
2. **Model and effort?** — "Wie vorgeschlagen (Recommended)" / "Einzeln
   anpassen".

On "Einzeln anpassen" ask once more, one question per picked task (four per
call, a second call for a fifth), each with up to four `Modell · Effort`
combinations: the suggestion first, marked *(Recommended)*, then sensible
neighbours (one step cheaper, one step stronger, a different effort). The user
can type any other combination under *Other*.

## Step 5 — start the sessions

For each picked task, in one message (call `mcp__ccd_session__mark_chapter`
first when starting two or more), write a bold title line and one sentence,
then call `mcp__ccd_session__start_session`:

- `initiation: "user_asked"` — the user picked it, so it starts now.
- `context: "fresh"`, `use_worktree: true` — the sessions run in parallel and
  must not share a checkout.
- `name`: short slug, e.g. `i1234-tree-reopen`.
- `model` and `effort` as decided. If the choice lies **above** this session's
  own model or effort, the app would silently drop it. Tell the user before
  starting and offer the two ways out: start it on this session's level, or
  have the user raise this planning session in the app's model picker and run
  the skill again. Do not start it and switch afterwards — the first turn,
  which does most of the work, would already run on the lower model.
- `title`: `#<nr> <issue title>`, under 60 characters.
- `prompt` — the brief, in English:

  ```text
  Work on issue #<nr>: <title> — https://github.com/kkrafft1999/snotra/issues/<nr>
  Read the issue and its comments first.

  Scope: <what to change, which files/area>. Stay inside it; other sessions
  are working on <busy areas> in parallel — do not touch those files.

  Done means: <the issue's definition of done, or your own concrete list>.
  Then follow .claude/rules/git-workflow.md to the end: npm test and
  npm run test:e2e green, push, PR with "Closes #<nr>" and the user-manual
  box ticked (.claude/rules/user-manual.md), pipeline green, squash merge.
  Move the issue to "In progress" on board 2 when you start.
  Other worktrees run their tests at the same time and share node_modules:
  rerun once on ENOTEMPTY or a locked file before suspecting your change.
  ```

- `background` (at least 80 characters): that this session was started by the
  `parallel-tasks` skill next to other sessions, which areas those sessions
  hold, and anything from the conversation that changes the task.

After the calls, one short German summary: which sessions run (linked as
`[title](#local_<id>)`), on which model and effort, and which tasks were not
started. Then stop — do not poll. When a session reports back, check its PR
before telling the user it is done.

## Notes

- Parallel test runs from several worktrees share `node_modules` through the
  symlink. A one-off `ENOTEMPTY` or a locked file is a collision, not
  necessarily a defect — that is why the brief asks for one rerun.
- The skill proposes; it does not re-prioritise the board. Moving issues to
  *Ready* stays the user's call.
