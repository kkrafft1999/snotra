---
name: release
description: >-
  Erstellt ein neues Release von Snotra AI: bumpt die Version in
  package.json über einen Pull Request, legt danach den Git-Tag vX.Y.Z an
  und pusht ihn, womit die GitHub-Actions-Pipeline
  (.github/workflows/release.yml) macOS-, Windows- und Linux-Builds baut und
  das Release veröffentlicht. Auslösen bei Sätzen wie
  "erstelle ein Release", "erstell ein neues Release", "Release erstellen",
  "mach ein Release", "neues Release", "release this", "cut a release",
  "Version veröffentlichen". Nur in diesem Repo (snotra) sinnvoll.
---

# Release erstellen

Dieser Skill veröffentlicht eine neue Version, indem er einen `v*`-Tag pusht.
Das Bauen und Hochladen der Artefakte übernimmt die Pipeline
(`.github/workflows/release.yml`). Hintergrund und manueller Ablauf stehen in
[docs/release.md](../../../docs/release.md), der Ablauf als Diagramm in
[docs/release-ablauf.svg](../../../docs/release-ablauf.svg).

**Wichtig:** Ein gepushter Tag löst ein **öffentliches** GitHub-Release aus —
das ist nach außen gerichtet und nicht trivial rückgängig zu machen. Hole dir
deshalb vor dem Tag-Push **eine** explizite Bestätigung der Zielversion.

**Ebenso wichtig:** Der Versions-Commit geht über einen **Pull Request**, nicht
direkt auf `main`. `npm version` ohne `--no-git-tag-version` würde auf dem
aktuellen Branch committen — beim Release also auf `main`, was nur per
Ruleset-Bypass durchgeht und [`git-workflow.md`](../../rules/git-workflow.md)
widerspricht (Issue #238). Der Tag-Push selbst ist unkritisch: Ruleset `23177645`
hat `target: branch` und erfasst Tags nicht.

## Schritt 1 — Bump-Typ bestimmen

Standard ist **patch**. Leite den Typ aus der Nutzeräußerung ab:

- "patch" / "Bugfix" / nichts gesagt → `patch`
- "minor" / "neue Funktion" / "Feature-Release" → `minor`
- "major" / "Breaking" / "großes Release" → `major`

Bei Unklarheit kurz nachfragen, sonst `patch` annehmen. Hilfreich für die
Einordnung: `git log --oneline vX.Y.Z..HEAD` seit dem letzten Tag.

## Schritt 2 — Pre-Flight-Checks (Abbruch bei Fehler)

Führe der Reihe nach aus und brich mit klarer Meldung ab, wenn etwas nicht passt:

1. Auf `main`? — `git rev-parse --abbrev-ref HEAD`. Wenn nicht, den Nutzer
   fragen, ob trotzdem von diesem Branch released werden soll (die Pipeline
   baut vom Tag-Commit, üblich ist `main`).
2. Arbeitsverzeichnis sauber? — `git status --porcelain`. Wenn nicht leer:
   abbrechen. Dem Nutzer sagen, dass uncommittete Änderungen erst
   committet/gestasht werden müssen.
3. Lokal aktuell? — `git fetch` und prüfen, dass `main` nicht hinter
   `origin/main` liegt. Wenn hinterher, zum `git pull` raten.
4. Tests grün? — `npm test` **und** `npm run test:e2e`. Bei rotem Test
   abbrechen und Ausgabe zeigen.

## Schritt 3 — Zielversion berechnen und bestätigen

Aktuelle Version aus `package.json` lesen (`node -p "require('./package.json').version"`)
und die resultierende Version für den gewählten Bump nennen. Dann **bestätigen
lassen**, z. B.:

> „Aktuell 1.0.0 → neues Release **v1.0.1** (patch). Der Bump geht über einen
> PR, danach wird getaggt und ein öffentliches Release veröffentlicht.
> Fortfahren?"

Erst nach Zustimmung weiter.

## Schritt 4 — Bump auf einem eigenen Branch (lokal, reversibel)

```sh
git switch -c release/vX.Y.Z
npm version <patch|minor|major> --no-git-tag-version
git commit -am "vX.Y.Z"
git push origin release/vX.Y.Z
```

`--no-git-tag-version` ist der springende Punkt: `npm version` ändert damit nur
`package.json` und `package-lock.json` und legt **weder Commit noch Tag** an.
Der Commit enthält genau diese beiden Dateien, sonst nichts.

## Schritt 5 — Pull Request und Pflicht-Checks

```sh
gh pr create --title "Release vX.Y.Z" --body "…"
```

Der Release-PR schließt kein Issue, braucht also kein `Closes #N`. Warten, bis
die drei Pflicht-Checks `Tests (macos-14)`, `Tests (windows-latest)` und
`Tests (ubuntu-latest)` grün sind:

```sh
gh pr checks --watch
```

Rot heißt: nicht mergen, Ursache beheben, erneut pushen.

## Schritt 6 — Mergen und `main` holen

```sh
gh pr merge --squash --delete-branch
git switch main && git pull
node -p "require('./package.json').version"   # muss X.Y.Z zeigen
```

Die letzte Zeile ist die Kontrolle, dass der Tag gleich auf den richtigen Stand
zeigt.

## Schritt 7 — Taggen und pushen (Punkt ohne Wiederkehr)

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

Nur der Tag-Ref wird gepusht — **kein** `git push origin main`, der Stand liegt
ja bereits über den Merge dort. Der Push über SSH braucht
`dangerouslyDisableSandbox: true` (Lesezugriff auf `~/.ssh/known_hosts`).

Sieht GitHub beim Push eine Meldung `Bypassed rule violations for
refs/heads/main`, ist etwas schiefgelaufen — dann wurde doch auf `main`
geschrieben. Melden, nicht ignorieren.

## Schritt 8 — Pipeline beobachten und Ergebnis melden

```sh
gh run list --workflow=release.yml --limit 1
gh run watch <RUN_ID> --exit-status
```

Nach Erfolg den Release-Link nennen:

```sh
gh release view vX.Y.Z --json url,assets -q '.url, (.assets[].name)'
```

Bei rotem Run die fehlgeschlagenen Jobs benennen und auf
`gh run view <RUN_ID> --log-failed` verweisen. Der Tag bleibt in dem Fall
bestehen; ein erneuter Push desselben Tags baut nicht automatisch neu — dann
mit dem Nutzer klären, ob Tag/Release gelöscht und nach Fix neu getaggt wird.

## Hinweise

- Versionierung ist Single Source of Truth in `package.json`; die Pipeline baut
  nur, sie taggt nicht. Die App vergleicht `app.getVersion()` (also
  `package.json`) mit dem `latest`-Release — deshalb muss der getaggte Commit
  die passende Version tragen.
- Artefakte sind **unsigniert** (Gatekeeper/SmartScreen erwartbar) — Stufe 1.
- Die Pipeline beginnt mit einem **Test-Gate** (Job `Test-Gate`, ruft
  `ci.yml` auf: `npm test` auf macOS, Windows und Linux). Rot dort heißt: kein
  Build, kein Release — lokal `npm test` reproduzieren, fixen, neu taggen.
- Keine zusätzlichen Assets von Hand hochladen; das erledigt die Pipeline.
- Solange der Bump über den PR läuft, laufen die Tests zweimal (PR und
  Test-Gate). Das ist gewollt: Der getaggte Commit hat das Gate bestanden,
  **bevor** er auf `main` lag.
