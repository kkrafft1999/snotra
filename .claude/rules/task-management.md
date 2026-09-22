# Task management

In this project **everything runs through GitHub issues**. There is no
`docs/roadmap.md` and no `docs/task.md` any more (decision from 2026-09-07; the
original convention dates from 2026-07-01, see PR #16).

- **Every task** — a bug, a single feature, a larger topic — is captured as a
  **GitHub issue**: https://github.com/kkrafft1999/snotra/issues. Templates:
  `.github/ISSUE_TEMPLATE/bug_report.yml` (🐛) and
  `.github/ISSUE_TEMPLATE/feature_request.yml` (💡).
- **Progress** is tracked on the **GitHub project "Snotra AI"** (number 2,
  kanban board: Backlog → Ready → In progress → In review → Done) —
  https://github.com/users/kkrafft1999/projects/2.
- Issues are created **directly with `gh issue create`** — `gh` is set up with
  write access in this environment (token scopes `repo`, `workflow`, `project`,
  `read:org`, `gist`; verified 2026-09-13). The `project` scope also allows
  **reading and setting the board column** via `gh project item-list` /
  `gh project item-edit`. New issues do not land on the board by themselves,
  though — after `gh issue create`, either file them yourself with
  `gh project item-add 2 --owner kkrafft1999 --url <issue-url>` or tell the user.
- Deliberately **no** external tool (Linear/Trello/Notion/Jira) and **no** task
  lists in the repository — everything stays in GitHub, since this is a solo
  hobby project that is already fully GitHub-based.

## No task files in the repository

The former scratchpad `docs/task.md` and the roadmap `docs/roadmap.md` were
removed without replacement on 2026-09-07, because they went stale next to the
issues. So:

- **No** new `task.md`, `roadmap.md`, `TODO.md`, `backlog.md` or the like — not
  even as a "temporary" place to put things.
- If `gh` cannot write for once (another machine, a missing scope, no network):
  print the finished issue text **in the conversation** and ask the user to
  create it. Don't write it into the repository.
- The **current state** of the app is described in `README.md` (the user's view)
  and in `docs/architecture.md` (the structure), not in a status list.

## What to do when asked "What's next?", "Where do we stand?", "Backlog?"

1. **Query the board first**, especially the **Ready** column — that is what
   comes next. The flat issue list shows everything as equal; the priorities
   live on the board:
   ```sh
   gh project item-list 2 --owner kkrafft1999 --limit 100 --format json
   ```
2. **Then** the rest of the backlog — either from the same output (column
   `Backlog`) or flat:
   ```sh
   gh issue list --repo kkrafft1999/snotra --state open
   ```
   Issues without a board entry only show up here, so compare both views.
3. Read individual issues where needed (`gh issue view <nr>`) to judge
   dependencies and priorities.
4. Also **check the working tree** (`git status`) — work that has been started
   but not committed is part of the answer to "What's next?".
5. Summarise and recommend an order — the Ready items first and individually,
   the backlog behind them and only grouped. If there are no open issues, say so
   instead of inventing something.

## What to do with new tasks and ideas from the conversation

- When the user names a **concrete task, a bug or an idea**: write the issue
  text along the matching template (the template's sections as headings, plus
  what has proven useful: current state with the date it was checked,
  cross-references, definition of done) — **in English, even when the task was
  described in German**, see [`language.md`](./language.md) — and create the
  issue **right away**:
  ```sh
  gh issue create --repo kkrafft1999/snotra --label enhancement \
    --title "…" --body-file <file>
  ```
  (Bugs with `--label bug`.) Put the body file in the scratchpad, not in the
  repository. Mention the issue link in the conversation afterwards.
- **Put fresh issues on the board.** `item-add` attaches the issue without a
  status; the `Backlog` column is set afterwards with `item-edit` (never
  `Ready` — what comes next is the user's call):
  ```sh
  gh project item-add 2 --owner kkrafft1999 --url <issue-url>
  gh project item-edit --id <item-id from item-add> \
    --project-id PVT_kwHOAQKGm84BjXUk \
    --field-id PVTSSF_lAHOAQKGm84BjXUkzhiL4mY \
    --single-select-option-id f75ad846   # = Backlog
  ```
- **Larger, fundamental topics** (epic level) get an issue as well — written out
  far enough that it can be split into several issues later. There is no
  separate place for "the big picture" any more.

## What does not belong here: the promotion

Since #299 the landing page, its hosting, the workflows that publish and
measure it and the `traffic` skill live in **`kkrafft1999/snotra-promotion`**, a
private repository of their own. Two consequences for the work here:

- **Tasks about the website go into that repository's issues**, not onto this
  board. A bug in the page, a wording change, a new section — all of it is
  raised over there. What stays here is the app, its documentation and its
  releases.
- **Nothing here may depend on that repository.** No workflow that deploys the
  site, no file it has to provide, no path pointing into it. It is private, so
  such a dependency would break for everyone but the owner — and it would turn
  a failed release over there into a failed release here. The direction runs
  the other way: the promotion reads this repository, this repository does not
  know it exists.

A prose reference to it, as in `language.md` or in the header of
`scripts/build-icons.js`, is not a dependency and is fine. A bare `#123` in a
text here means an issue here — when referring to one over there, write it out
as `kkrafft1999/snotra-promotion#123`.
