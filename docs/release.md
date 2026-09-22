# Release and self-update

The app has an **update notifier** (stage 1): at startup, and via
*Help → Check for updates…* (or the link in the settings), it checks the
**latest GitHub release** of this repository and shows a banner with a download
link when a newer version exists. **Nothing is installed automatically** — the
download goes through the browser, the installation is manual.

For that to work there have to be releases in the first place. This is the
procedure that creates them.

## Prerequisites (once)

- The repository has to be **public**, otherwise the unsigned app cannot read
  the releases API without a token:
  ```sh
  gh repo edit kkrafft1999/snotra --visibility public
  ```
- `gh` has to be authenticated (`gh auth status`).

## The flow at a glance

![The release flow: the version commit goes through a pull request, then a tag push triggers the pipeline](release-ablauf.svg)

In short: the version commit goes through a pull request like every other
change. Only the merged state is tagged, and the tag push alone starts the
pipeline. `main` is never written to directly.

## The version as the single source of truth

The version that is displayed and compared comes from `version` in
[`package.json`](../package.json) (→ `app.getVersion()`). Exactly that value
decides whether a running installation recognises itself as out of date, so it
has to match the release tag.

Bump it before every release (SemVer), but **on a branch of its own**:

```sh
git switch -c release/vX.Y.Z
npm version patch --no-git-tag-version   # or: minor / major
git commit -am "vX.Y.Z"
git push origin release/vX.Y.Z
gh pr create --title "Release vX.Y.Z"
```

`--no-git-tag-version` is essential: without it, `npm version` commits to the
current branch and creates the tag straight away. Run on `main` that means a
direct commit — and ruleset `23177645` rejects it, now that no bypass actor is
left (issues #238 and #240). With the option, `npm version` only changes
`package.json` and `package-lock.json`.

Once the required checks are green, merge and put the tag on the merged state:

```sh
gh pr merge --squash --delete-branch
git switch main && git pull
git tag vX.Y.Z
```

The tag ref is not covered by the ruleset (`target: branch`), so pushing it is
uncritical.

## Build

```sh
npm run make            # macOS arm64  -> out/make/*.dmg + ZIP
npm run package:win     # Windows x64  -> out/<productName>-win32-x64/  (to be zipped)
npm run make:linux      # Linux x64    -> out/make/{deb,AppImage}/x64/* + out/<productName>-linux-x64/
```

The Linux run needs `dpkg`, `fakeroot` (deb) and `mksquashfs` (AppImage,
package `squashfs-tools`) — macOS has none of them, and Forge aborts there with
*"Cannot make for …"*; `npm run package:linux` (packaging only, without the
maker) does work from macOS.

The AppImage maker downloads the **type-2 runtime** from GitHub at build time.
By default it pulls it from the rolling `continuous` tag; in
[`package.json`](../package.json) a **dated release is pinned** instead, so that
a different foreign binary doesn't end up in the artifact with every build. A
test guards this. To raise it, point the `runtime` URL deliberately at a newer
tag — `continuous` is not a valid option.

The artifacts end up under `out/`. The app's comparison uses **the release tag
only**, not the file names — so the asset names can be chosen freely, but should
carry the version and the platform, e.g. `Snotra-AI-1.1.0-mac-arm64.dmg`.

### The app icon

`icon.icns` (macOS), `icon.ico` (Windows) and `icon.png` (Linux, 512 px) are
checked in and are **not** rebuilt by the pipeline. Their source are the SVGs in
`assets/icon/` (`icon-macos.svg` with the Apple icon grid and shadow,
`icon-windows.svg` full-bleed — both `.ico` **and** `.png` come from it). After
changing one of them, generate the icons locally once — this needs
`rsvg-convert` (`brew install librsvg`) and `iconutil` (Xcode command line
tools):

```sh
node scripts/build-icons.js
```

## What goes into the package (the allowlist)

The `app.asar` contains **runtime files only**: `src/`, `system-skills/`,
`node_modules/` (production dependencies), `package.json` and `LICENSE`.
Everything else — `.claude/` (including a local `settings.local.json`),
`.github/`, `docs/`, `test/`, `scripts/`, the icon sources, the README, the lock
file, `.env*` — stays out (issue #72). The source of truth is the negative regex
in [`package.json`](../package.json) → `config.forge.packagerConfig.ignore`; new
runtime folders have to be added to the allowlist there.

The pipeline checks the contents automatically after every build job
(`scripts/check-asar-contents.js`, which fails on excluded files or missing
mandatory ones). Locally, after `npm run package`:

```sh
npm run check-package
```

## Pipeline and test gate

Two GitHub Actions workflows under [`.github/workflows/`](../.github/workflows/):

- [`ci.yml`](../.github/workflows/ci.yml) runs the test suite (`npm test`, Node
  24) on **macOS, Windows and Linux** for every **pull request** and every
  **push to `main`**. A red run is visible on the pull request or on the commit.
- [`release.yml`](../.github/workflows/release.yml) starts on a tag push
  `vX.Y.Z`. Its first job runs the same test suite as a **test gate** (`ci.yml`
  via `workflow_call`); only when all three platforms are green do the build
  jobs (`build-macos`, `build-windows`, `build-linux`) run and attach their
  artifacts to the release. If a test fails, **no** build and **no** release
  comes into existence — fix the cause, set the tag again
  (`git tag -d vX.Y.Z && git push origin :vX.Y.Z`, then tag and push anew).

Watching runs:

```sh
gh run list --workflow ci.yml --limit 5
gh run watch
```

`main` is protected by ruleset `23177645`: changes need a pull request,
force-push and deletion are blocked, and the three contexts
`Tests (macos-14)` / `Tests (windows-latest)` / `Tests (ubuntu-latest)` are
mandatory. Since 2026-09-20 nobody is left in `bypass_actors` (#240) — the rules
apply to the owner as well. The ruleset has `target: branch` and therefore
covers **branches only** — tags can be pushed without a pull request, which is
what the release path above makes use of.

## Publishing the release

**Only the tag** is pushed — the state itself is already on `main` through the
merged pull request:

```sh
git push origin vX.Y.Z
```

This is the point of no return: the push starts `release.yml`, and at the end
there is a public release. If GitHub rejects the push, it was aimed at `main`
instead of at the tag — then look into it, don't work around it.

The run and its result:

```sh
gh run list --workflow=release.yml --limit 1
gh run watch <RUN_ID> --exit-status
gh release view vX.Y.Z --json url,assets -q '.url, (.assets[].name)'
```

The pipeline creates the release and the assets itself; the artifacts are named
uniformly `Snotra-AI-<version>-<mac|win|linux>-<arch>.<extension>`. By hand,
`gh release create` is only needed if the pipeline fails:

```sh
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "What's new …" \
  "out/make/Snotra AI.dmg#Snotra AI (macOS, Apple Silicon)"
```

The text from `--notes` becomes the release body and is available to the app as
`notes` in the banner.

### Pre-releases

Tags with a SemVer suffix (`v1.6.0-rc.1`, `v1.5.1-debtest`) are published by the
pipeline as a **prerelease**. That is the safeguard for test runs: the app calls
`GET /releases/latest`, and GitHub serves neither drafts nor prereleases there —
so a test build is never offered as an update to running installations. Without
a suffix, a regular release is created as before.

> Note: as long as the app is **not code-signed**, macOS shows the Gatekeeper
> dialog the first time a new version starts. That is expected and not a fault
> of the update path. Linux needs no signature; the only relevant point there is
> the sandbox note about the tarball (see the README).

## What the app checks

- Endpoint: `GET https://api.github.com/repos/kkrafft1999/snotra/releases/latest`
- Installations up to v1.0.4 still ask for `kkrafft1999/weyouze`; GitHub
  redirects to the renamed repository with a 301. Never **reuse the old
  repository name**, or the update notice of those old versions breaks.
- Comparison: `tag_name` (without the leading `v`) against `app.getVersion()`
  via SemVer.
- **Drafts** are ignored; **prereleases** are marked as such.
- Versions dismissed with *Skip* stop showing up in the automatic check; a
  manual check shows them again.

Implementation:
[`src/main/services/update-service.js`](../src/main/services/update-service.js),
tests: [`test/update-service.test.js`](../test/update-service.test.js).
