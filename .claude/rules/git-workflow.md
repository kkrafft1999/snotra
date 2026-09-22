# Git workflow: push, pull request and merge without being asked

Convention from 2026-09-20.

A finished task is carried through to a merged pull request without the user
triggering each step. In this repository the confirmation costs more than it
protects — and what it is supposed to protect, a machine checks more reliably
anyway:

**Ruleset `23177645` on `main`** requires a pull request, forbids force-pushing
and deleting the branch, and makes the three contexts `Tests (macos-14)`,
`Tests (windows-latest)` and `Tests (ubuntu-latest)` mandatory. A red state does
not get through, not even by accident.

Since 2026-09-20 `bypass_actors` is **empty** (#240). The rules therefore apply
to the owner as well: a direct push to `main` fails hard instead of slipping
through quietly. The price is a missing emergency exit — if a required check
ever stops running, the ruleset has to be touched before anything can reach
`main` again.

Until 2026-09-20 the ruleset demanded a review instead. In a solo repository
there is nobody to give one, so every merge was an admin bypass — and the agent
environment refuses that as *Merge Without Review*, rightly so. With review
traded for mandatory checks, a merge is an ordinary merge through a green gate;
proven on the same day.

## Without asking

1. **Push and open the pull request as soon as the tests are green locally.**
   Green means: `npm test` **and** `npm run test:e2e` ran to completion, without
   failures, on the working branch. The pull request carries `Closes #N` for the
   matching issue (see [`task-management.md`](./task-management.md)) — in
   English, a German "Schließt #N" closes nothing. **Commit messages, pull
   request titles and pull request bodies are English** — see
   [`language.md`](./language.md).
2. **Merge as soon as the pipeline is green** and the review below finds
   nothing. By **squash**: `main` carries one commit per pull request, with the
   pull request number in the title. Delete the branch afterwards, the
   repository does not tidy up by itself.

The user is told afterwards, in one sentence, what happened: pull request
number, merge, deleted branch. They don't have to approve it beforehand, but
they shouldn't have to go looking for it either.

## What is checked before merging

- **All required checks green** — not skipped, not still running. "It's running"
  is not a result.
- **No conflicts with `main`** (`mergeable: MERGEABLE`, status `CLEAN`).
- **No open reviews or comments** that call for an answer — including from bots,
  when they carry a real objection.
- **The diff contains nothing beyond the task** — no foreign changes from a
  parallel session, no credentials or keys, nothing touching the release process
  or the workflows under `.github/`.

If one of these fails, don't merge — report it.

Since [#237](https://github.com/kkrafft1999/snotra/issues/237) `ci.yml` also
runs `npm run test:e2e` in the same job, so the required gate covers both test
levels, not just the DOM stand-in.

## Ask first

- **Tests red locally**, or not run at all — then nothing gets pushed either.
- **Conflicts, force-push, rebase** — anything that rewrites history.
- **Changes to the ruleset itself** or to the protection of `main`. Moving the
  gate moves the ground this rule stands on.
- **Writing to `main` directly:** never, not even with an admin bypass. That
  includes the **version commit of a release** — it goes through a pull request
  like every other change (issue #238).

When in doubt, the doubt wins: report the state and ask, rather than undo a
merge.

## Tags are not covered

The push restriction is about branches. Ruleset `23177645` has `target: branch`
and does not catch tag refs, so `git push origin vX.Y.Z` is not a bypass and
needs no separate confirmation. The [`release` skill](../skills/release/SKILL.md)
confirms the target version before it tags anyway; its flow is drawn in
[`docs/release-flow.svg`](../../docs/release-flow.svg).

Until 2026-09-20 the bump ran via `npm version` straight on `main` and only got
through because of the `RepositoryRole` bypass; GitHub logged every release with
`Bypassed rule violations for refs/heads/main`. Both are gone: the bump goes
through a pull request (#238), the bypass is removed (#240). A direct push is
now rejected — if such a rejection shows up, something has slipped past the
process, and that is to be reported rather than worked around.

## Order

Issue → branch → commits → local tests → push → pull request with `Closes #N` →
pipeline → the review above → squash merge → delete branch → one sentence to
the user.
