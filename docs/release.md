# Release and self-update

The app **updates itself** (#232): at startup, and via
*Help → Check for updates…* (or the link in the settings), it checks the
**latest GitHub release** of this repository. When a newer version exists, a
dialog walks through the update — download, install, restart — and **every step
needs the user's confirmation** and can be cancelled until installation starts.
Nothing is downloaded or installed without that confirmation. Installations
that cannot replace themselves (a `.deb` under `/opt`, a location without write
permission, a development build) get a link to the release page instead. The
user's side of this is described in the README, section *Updating*.

For that to work there have to be releases in the first place. This is the
procedure that creates them.

## Prerequisites (once)

- The repository has to be **public**, otherwise the app cannot read
  the releases API without a token:
  ```sh
  gh repo edit kkrafft1999/snotra --visibility public
  ```
- The **macOS signing secrets** are set in the repository (#662):
  `MACOS_CERT_P12_BASE64`, `MACOS_CERT_PASSWORD`, `APPLE_API_KEY_P8_BASE64`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` and `APPLE_TEAM_ID`. How they were made
  and when they expire is in
  [`release/macos-signing-plan.md`](release/macos-signing-plan.md).
- `gh` has to be authenticated (`gh auth status`).

## The flow at a glance

![The release flow: the version commit goes through a pull request, then a tag push triggers the pipeline](release-flow.svg)

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

Every AppImage starts with the **type-2 runtime**, a binary from
`AppImage/type2-runtime`. Left alone, the maker would download it at build time
from the rolling `continuous` tag, unchecked. Instead `npm run make:linux` first
runs [`scripts/fetch-appimage-runtime.js`](../scripts/fetch-appimage-runtime.js),
which downloads a **dated release** and writes it to
`out/appimage-runtime/runtime-x86_64` only if its SHA-256 matches the pinned one
(#573). The maker's `runtime` in [`package.json`](../package.json) points at
that file. A test guards both. To raise it, change URL and SHA-256 in the script
together — GitHub lists the digest next to each release asset.

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
  `vX.Y.Z`. Its first job checks the **tag**: `X.Y.Z` has to be exactly the
  `version` in `package.json` at the tagged commit, and that commit has to be on
  `main` (#570). A tag that fails either check stops the run before anything is
  built — a release is offered to every running installation, so a tag on the
  wrong commit must not get that far. Prerelease tags (with a `-`) are never
  offered as an update and skip this check. Then the same test suite runs as a
  **test gate** (`ci.yml` via `workflow_call`); only when all three platforms
  are green do the build
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

## Manual checks before tagging

What the tests cannot see is looked at by hand, in the packaged app of the
release branch.

### Keyboard in the file tree

The DOM tests (`test/file-tree-keyboard-dom.test.js`) cover where the keys
go. What they cannot cover is the focus ring as drawn, the native context menu
and a screen reader (#74). With a folder open that has subfolders:

1. Click into the chat input, then press `Shift+Tab` until the focus is in the
   tree. It lands on **one** row — the selected one, or the first — and that
   row shows a blue ring inside its edges. Pressing `Tab` again leaves the
   tree in one step (to the sidebar divider), not row by row.
2. `↓` / `↑` move the ring over the visible rows, `Home` / `End` jump to the
   first and the last. Rows inside a closed folder are skipped.
3. On a closed folder `→` opens it without selecting it (no blue stripe); a
   second `→` moves into it. `←` on a child goes back to the folder, `←` on the
   open folder closes it.
4. `Enter` on a file shows it in the middle column and selects the row;
   `Enter` on a folder opens or closes it.
5. The focused row shows its `@` button; `Shift+Enter` puts the reference into
   the chat input instead of clicking it. The button's tooltip names the key.
6. `Shift+F10` (and on Windows/Linux the context-menu key) opens the context
   menu **below the row's name** — not at the mouse pointer. `Esc` closes it,
   and the focus is back on the row.
7. With the row focused, have the agent or the terminal delete that file. The
   row disappears and the focus stays in the tree on another row.
8. With VoiceOver (`⌘F5`) on macOS: the tree is announced as "Files", a row as
   its name with level, "collapsed"/"expanded" and "selected"; a row with an
   agent mark reads the mark as its description, a folder that cannot be read
   reads the reason.

### Filtering the file tree

The DOM tests (`test/file-tree-filter-dom.test.js`) cover what the filter
finds, where the keys go and where the focus returns. What they cannot cover
is the menu's key equivalent, the drawn list and a screen reader (#350); the
look script `e2e/manual-tree-filter.mjs` photographs the states. With a folder
open:

1. Click into the chat input and press `Cmd+P` (`Ctrl+P`). The field opens
   above the tree with the focus in it; the tree stays visible until you type.
   With the sidebar hidden (`Cmd+B` first), `Cmd+P` brings it back.
2. Type a few letters of a file deep in a closed folder. The tree gives way to
   a list: name, folder underneath, matched letters underlined, the first
   entry selected, the count at the bottom. Type the same after `@` in the
   chat input — the first eight entries are the same, in the same order.
3. `↓` / `↑` move the selection; `Enter` shows the file in the middle column
   and the list stays. `Esc` brings the tree back, unfolded to that file and
   with it selected; the focus is back in the chat input.
4. Focus a row in the tree and type a letter: the field opens with it. `Esc`
   returns the focus to the row. A folder picked with `Enter` closes the
   filter and is shown open in the tree, with the focus on it.
5. Type something that matches nothing: one sentence names the query. Delete
   the field: the tree is back.
6. With the filter open on a query, create a matching file in Finder or
   Explorer: it appears in the list within a second, the selection stays.
7. Light and dark (*Settings › Appearance*): the selected row shows the blue
   bar on its left like the tree's selection, the underlines stay visible.
8. With VoiceOver: the field is announced as a combo box "Filter files"; the
   arrows read each entry as its name and folder; the count is read when it
   changes.

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

The text from `--notes` becomes the release body and is shown as "what has
changed" in the update dialog.

### Pre-releases

Tags with a SemVer suffix (`v1.6.0-rc.1`, `v1.5.1-debtest`) are published by the
pipeline as a **prerelease**. That is the safeguard for test runs: the app calls
`GET /releases/latest`, and GitHub serves neither drafts nor prereleases there —
so a test build is never offered as an update to running installations. Without
a suffix, a regular release is created as before.

> Note: the macOS build is signed with a Developer ID, notarised and stapled
> (#662) — the job `Build macOS` fails if Gatekeeper would not accept it. A
> prerelease is signed the same way, so a `-rc` tag is the test run for a change
> to the signing. Windows is still unsigned; SmartScreen warns there on first
> launch. Linux needs no signature; the only relevant point there is the sandbox
> note about the tarball (see the README).

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
