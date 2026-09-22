---
name: release
description: >-
  Publishes a new release of Snotra AI: bumps the version in package.json
  through a pull request, then creates the git tag vX.Y.Z and pushes it, which
  makes the GitHub Actions pipeline (.github/workflows/release.yml) build the
  macOS, Windows and Linux artifacts and publish the release. Triggers on
  sentences like "erstelle ein Release", "erstell ein neues Release", "Release
  erstellen", "mach ein Release", "neues Release", "Version veröffentlichen",
  "release this", "cut a release", "create a release", "publish a new version".
  Only makes sense in this repository (snotra).
---

# Cut a release

This skill publishes a new version by pushing a `v*` tag. Building and uploading
the artifacts is the pipeline's job
(`.github/workflows/release.yml`). The background and the manual procedure are
in [docs/release.md](../../../docs/release.md), the flow as a diagram in
[docs/release-ablauf.svg](../../../docs/release-ablauf.svg).

**Important:** a pushed tag triggers a **public** GitHub release — that is
outward-facing and not trivial to undo. So get **one** explicit confirmation of
the target version before pushing the tag.

**Just as important:** the version commit goes through a **pull request**, not
straight onto `main`. `npm version` without `--no-git-tag-version` would commit
to the current branch — which during a release means `main`, which only gets
through with a ruleset bypass and contradicts
[`git-workflow.md`](../../rules/git-workflow.md) (issue #238). Since #240 nobody
is left in `bypass_actors` — so a direct push is rejected, not merely logged.
The tag push itself is uncritical: ruleset `23177645` has `target: branch` and
does not cover tags.

## Step 1 — determine the bump type

The default is **patch**. Derive the type from what the user said:

- "patch" / "bugfix" / nothing said → `patch`
- "minor" / "new feature" / "feature release" → `minor`
- "major" / "breaking" / "big release" → `major`

When it's unclear, ask briefly; otherwise assume `patch`. Helpful for judging
it: `git log --oneline vX.Y.Z..HEAD` since the last tag.

## Step 2 — pre-flight checks (stop on failure)

Run these in order and stop with a clear message when something doesn't fit:

1. On `main`? — `git rev-parse --abbrev-ref HEAD`. If not, ask the user whether
   to release from this branch anyway (the pipeline builds from the tagged
   commit; `main` is the usual one).
2. Working tree clean? — `git status --porcelain`. If it isn't empty: stop. Tell
   the user that uncommitted changes have to be committed or stashed first.
3. Up to date locally? — `git fetch`, then check that `main` isn't behind
   `origin/main`. If it is, advise a `git pull`.
4. Tests green? — `npm test` **and** `npm run test:e2e`. On a red test, stop and
   show the output.

## Step 3 — compute the target version and confirm it

Read the current version from `package.json`
(`node -p "require('./package.json').version"`) and name the version that
results from the chosen bump. Then **have it confirmed**, for example:

> "Currently 1.0.0 → new release **v1.0.1** (patch). The bump goes through a
> pull request, after which it is tagged and a public release is published.
> Proceed?"

Only continue after agreement.

## Step 4 — the bump on a branch of its own (local, reversible)

```sh
git switch -c release/vX.Y.Z
npm version <patch|minor|major> --no-git-tag-version
git commit -am "vX.Y.Z"
git push origin release/vX.Y.Z
```

`--no-git-tag-version` is the crucial part: with it, `npm version` only changes
`package.json` and `package-lock.json` and creates **neither a commit nor a
tag**. The commit holds exactly those two files and nothing else.

## Step 5 — pull request and required checks

```sh
gh pr create --title "Release vX.Y.Z" --body "…"
```

The release pull request closes no issue, so it needs no `Closes #N`. Wait until
the three required checks `Tests (macos-14)`, `Tests (windows-latest)` and
`Tests (ubuntu-latest)` are green:

```sh
gh pr checks --watch
```

Red means: don't merge, fix the cause, push again.

## Step 6 — merge and fetch `main`

```sh
gh pr merge --squash --delete-branch
git switch main && git pull
node -p "require('./package.json').version"   # has to show X.Y.Z
```

That last line is the check that the tag is about to point at the right state.

## Step 7 — tag and push (the point of no return)

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

Only the tag ref is pushed — **no** `git push origin main`, that state is
already there through the merge. Pushing over SSH needs
`dangerouslyDisableSandbox: true` (read access to `~/.ssh/known_hosts`).

If GitHub rejects the push because it aimed at `main`, something went wrong —
since the bypass was removed (#240) there is no way through for that any more.
Report it, don't work around it.

## Step 8 — watch the pipeline and report the result

```sh
gh run list --workflow=release.yml --limit 1
gh run watch <RUN_ID> --exit-status
```

Once it succeeds, name the release link:

```sh
gh release view vX.Y.Z --json url,assets -q '.url, (.assets[].name)'
```

On a red run, name the failed jobs and point to
`gh run view <RUN_ID> --log-failed`. The tag stays in place in that case; pushing
the same tag again does not rebuild automatically — then settle with the user
whether the tag and release are deleted and re-tagged after a fix.

## Notes

- Versioning has its single source of truth in `package.json`; the pipeline only
  builds, it does not tag. The app compares `app.getVersion()` (that is,
  `package.json`) against the `latest` release — which is why the tagged commit
  has to carry the matching version.
- The artifacts are **unsigned** (Gatekeeper and SmartScreen warnings are
  expected) — stage 1.
- The pipeline starts with a **test gate** (the job `Test-Gate`, calling
  `ci.yml`: `npm test` on macOS, Windows and Linux). Red there means: no build,
  no release — reproduce `npm test` locally, fix it, tag anew.
- Don't upload additional assets by hand; the pipeline does that.
- As long as the bump goes through the pull request, the tests run twice (the
  pull request and the test gate). That is intended: the tagged commit passed
  the gate **before** it landed on `main`.
