---
name: install
description: >-
  Builds Snotra AI locally (electron-forge package, macOS/arm64) and replaces
  the installed app at /Applications/Snotra AI.app with the fresh build.
  Triggers on sentences like "bau die App und kopier sie nach Programme",
  "installier die App lokal", "App neu bauen und installieren", "lokalen Build
  nach Applications", "build the app and copy it to Applications", "install the
  app locally", "rebuild and install the app". Only makes sense in this
  repository (snotra) and on an Apple Silicon Mac.
---

# Build the app locally and install it into Applications

This skill produces a local, unsigned build and replaces the installed app with
it. Nothing is committed, pushed or published.

## Step 1 — pre-flight (brief, without asking)

1. Make sure Node is ≥ 24 (`node -v`). Usually the shell already provides v24
   through nvm. If it doesn't, put the nvm path in front of **every** bash call:
   ```sh
   export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH"
   ```
   (If that version doesn't exist: `ls ~/.nvm/versions/node/` and take the
   newest v24.) Experience says a wrong version comes from an absolute
   `export PATH=...` line in `~/.zshrc` that some tool wrote there. Mention that
   to the user briefly.
2. Is the app running right now? `pgrep -x "Snotra AI"`. If it is, don't ask the
   user — point out after copying that they have to restart the old instance.
   Only quit it (`osascript -e 'quit app "Snotra AI"'`) if the user explicitly
   wants that.
3. Uncommitted changes are **allowed**. That is exactly what the local build is
   for: trying out a state before committing it. Mention briefly that the build
   contains the working state, uncommitted changes included.

## Step 2 — build

```sh
npm run package
```

`npm run package` (see `package.json`) first syncs the renderer vendor files and
then calls `electron-forge package --arch arm64 --platform darwin`. The result:

```
out/Snotra AI-darwin-arm64/Snotra AI.app
```

On errors, stop and show the relevant output. Don't delete `node_modules` or run
`npm install` on suspicion. Only suggest `npm install` once the error message
points clearly at missing dependencies.

## Step 3 — install

```sh
rm -rf "/Applications/Snotra AI.app" && cp -R "out/Snotra AI-darwin-arm64/Snotra AI.app" /Applications/
```

The deletion only affects the copy of the app bundle in `/Applications`, no user
data (the settings live in `~/Library/Application Support/`). No confirmation
needed, therefore.

## Step 4 — verify and report

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/Applications/Snotra AI.app/Contents/Info.plist"
```

Report briefly: the installed version, the git commit of the build
(`git rev-parse --short HEAD`, plus a note "with uncommitted changes" when
`git status --porcelain` isn't empty), and whether a running instance has to be
restarted. Only start the app (`open -a "Snotra AI"`) when the user asked for
that.

## Notes

- The build is **unsigned**. Gatekeeper may complain on first launch. That is
  expected (stage 1, see `docs/release.md`).
- For a published release there is the separate `release` skill. This skill does
  not replace it.
- A Windows build (`npm run package:win`) is not part of this skill.
