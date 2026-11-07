---
name: user-feedback
description: >-
  Looks for user feedback on GitHub in both of the shapes it arrives in — issues
  filed by the in-app feedback form (label `feedback`) and contributions by
  people other than the owner (issues, comments, pull requests, discussions) —
  and reports only what is new or still in progress: closed items and
  advertising are left out. For each remaining item it says whether it is
  answered or waiting, on the board or not, real or a test. Read-only.
  Triggers on sentences like "gibt es
  Feedback?", "gibt es Feedback in GitHub Issues?", "gibt es welche mit Tag
  feedback?", "hat jemand was geschrieben?", "Feedback-Status", "neues
  Nutzer-Feedback?", "is there any feedback?", "any new user feedback?",
  "feedback status", "did anyone comment?". Only makes sense in this repository
  (snotra).
---

# Find user feedback and report its state

Feedback reaches this repository in two shapes, and a search for only one of
them misses the other:

1. **Through the in-app form** (*Help › Send Feedback…*, #1045). The endpoint on
   the website files a public issue **under the owner's account**
   (`kkrafft1999`) with the label **`feedback`**. The body ends in a table
   (*Kind* — Bug / Idea / Praise, *App version*, *Operating system*,
   *Architecture*, *Provider*, *Language*) and the line *Sent through the in-app
   feedback form · feedback id `…`*. The author therefore says nothing about who
   wrote it.
2. **Directly on GitHub, by someone else.** Anyone with a GitHub account: an
   issue (also the form's fallback when the endpoint is down — it opens GitHub's
   own issue form prefilled, see `buildFeedbackIssueUrl` in
   `src/shared/contracts/feedback.js`; those issues carry **no** `feedback`
   label), a comment on an existing issue, a pull request, a discussion post.

Everything here is read-only. Nothing is commented, labelled, closed or moved on
the board unless the user asks for it afterwards — and a reply on GitHub is
public, so it is shown to the user word for word before it goes out.

## What is shown: only what is new or still in progress

The user wants to see what still needs attention, not the history (decided
2026-11-07, #1374). Two kinds of item are therefore **left out of the report
entirely** — no row, no footnote:

- **Closed items.** A closed form issue, a closed issue or pull request by
  someone else, a closed discussion, and every comment whose parent issue or
  pull request is closed. The commands below query open items only, so these
  never show up.
- **Advertising.** A comment or issue that mainly promotes a product or service
  (a link to the author's own offering, a sign-up, a price list, "message us
  on Telegram") is dropped, even when it sits on an open issue and even when
  it carries some useful technical text. Only clear cases: a contributor
  offering to work on an issue is not advertising.

Closed items come back only when the user asks for them in words ("auch die
geschlossenen", "alles", "Historie", "including closed"). Then switch every
`open` below to `all` (`--state all`, drop `states:OPEN`, skip the `$OPEN`
filter) and mark closed items as such.

## Step 1 — collect both shapes (without asking)

Run these together; `OWNER=kkrafft1999`, `REPO=kkrafft1999/snotra`. Bots
(`dependabot`, `github-actions`, anything ending in `[bot]`, `app/…`) are not
feedback and are filtered out.

```sh
REPO=kkrafft1999/snotra
BOTS='dependabot|github-actions|bot]$|^app/'   # no backslashes: jq rejects "\["
# Open issues and pull requests (the issues endpoint returns both) — comments
# on anything else are on closed items and are skipped.
OPEN=$(gh api --paginate "repos/$REPO/issues?state=open&per_page=100" --jq '.[].number' | jq -s -c .)

echo "== 1. In-app form (label feedback) =="
gh issue list --repo $REPO --state open --label feedback --limit 500 \
  --json number,title,state,createdAt,body,comments \
  --jq '.[] | "#\(.number) \(.createdAt[:10]) \(.title) | kind=\((.body|capture("\\| Kind \\| (?<k>[^|]+)")?.k // "?")|gsub(" ";"")) version=\((.body|capture("\\| App version \\| (?<v>[^|]+)")?.v // "?")|gsub(" ";"")) | comments=\(.comments|length)"'

echo "== 2a. Issues by others =="
gh issue list --repo $REPO --state open --limit 1000 \
  --json number,title,author,createdAt \
  --jq ".[] | select(.author.login != \"kkrafft1999\" and (.author.login|test(\"$BOTS\")|not)) | \"#\(.number) \(.createdAt[:10]) @\(.author.login): \(.title)\""

echo "== 2b. Comments by others (on open issues and PRs) =="
gh api --paginate "repos/$REPO/issues/comments?per_page=100" \
  | jq -r --argjson open "$OPEN" --arg bots "$BOTS" '.[]
      | select(.user.login != "kkrafft1999" and (.user.login|test($bots)|not))
      | (.issue_url|split("/")|last|tonumber) as $n | select($open|index($n))
      | "\(.created_at[:10]) @\(.user.login) #\($n): \(.body[:200]|gsub("\n";" "))"'

echo "== 2c. Pull requests by others =="
gh pr list --repo $REPO --state open --limit 500 --json number,title,author,createdAt \
  --jq ".[] | select(.author.login != \"kkrafft1999\" and (.author.login|test(\"$BOTS\")|not)) | \"#\(.number) \(.createdAt[:10]) @\(.author.login): \(.title)\""

echo "== 2d. Discussions (started by others, or with a comment by others) =="
gh api graphql -f query='{repository(owner:"kkrafft1999",name:"snotra"){discussions(first:50,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title author{login} createdAt comments(first:50){nodes{author{login} createdAt body}}}}}}' \
  --jq '.data.repository.discussions.nodes[] | select(.author.login != "kkrafft1999" or ([.comments.nodes[].author.login] | any(. != "kkrafft1999"))) | "D#\(.number) @\(.author.login) \(.createdAt[:10]) \(.title) | " + ([.comments.nodes[] | "@\(.author.login) \(.createdAt[:10])"] | join(", "))'
```

Comment hits shown as a 200-character excerpt can hide the advertising at the
end — before keeping a comment from an unknown author, read its full body
(`gh issue view <n> --json comments`) and drop it if it turns out to be
advertising.

If the user asks for a time window ("seit letzter Woche", "since the release"),
add `since=<ISO date>` to the comments call and filter the rest by `createdAt`.
Without one, report every open item, newest first.

## Step 2 — the state of each item

For every hit that is left after the filter, establish:

- **Answered or waiting.** Look at the last comment
  (`gh issue view <n> --json comments`, or the discussion's comment list): if
  it is from someone other than `kkrafft1999` and nothing from the owner
  follows, the item is **waiting for an answer**. A form issue without any
  comment is *not answered* — whether it needs one depends on its kind (praise
  rarely does, a bug report does).
- **On the board:** column from
  `gh project item-list 2 --owner kkrafft1999 --query "is:issue is:open" --limit 200 --format json`.
  Never drop the `--query` (see `.claude/rules/task-management.md`). An open
  feedback issue with no board entry is worth saying so.
- **Real or a test.** Titles like *Test of the feedback endpoint …* / *Test of
  the duplicate check …* are the owner's own tests. A form issue whose
  diagnostics match the owner's machine (current macOS on arm64, provider
  `openai`, language `de`, filed on a release day) is *probably* a self-test
  too — say "probably", never more: the author field cannot tell. An open
  test issue stays in the report: it is a leftover to close.

## Step 3 — report (in the conversation language)

Two sections, one per shape, each as a short table, newest first:

| Item | Date | Who | Kind / topic | State |
|---|---|---|---|---|
| [#1204 Linux sandbox does not start on Ubuntu 26.04](https://github.com/kkrafft1999/snotra/issues/1204) | 2026-10-27 | @sunny-kavixo | investigation results | answered 2026-10-28, ball with the contributor, Backlog |

- Every item is a link with its title or a one-line gist — never a bare number.
- *State* combines answered/waiting, board column, test/real. Closed items and
  advertising are not in the table (see above).
- A section with no open item is one line ("nothing open"), not an empty
  table.
- Close with **one** sentence of verdict: is there real outside feedback that
  is still open, and is anything waiting for an answer? If both sections are
  empty, say so plainly instead of padding the answer.
- Offer follow-ups only where they exist: drafting a reply to a waiting item,
  filing an open form issue on the board, closing a leftover test issue. Each of
  them is a write to GitHub and happens only after the user says yes.
