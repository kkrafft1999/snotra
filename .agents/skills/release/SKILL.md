---
name: release
description: >-
  Erstellt ein neues Release von Weyouze Anything: bumpt die Version in
  package.json, legt den Git-Tag vX.Y.Z an und pusht ihn, womit die
  GitHub-Actions-Pipeline (.github/workflows/release.yml) macOS- und
  Windows-Builds baut und das Release veröffentlicht. Auslösen bei Sätzen wie
  "erstelle ein Release", "erstell ein neues Release", "Release erstellen",
  "mach ein Release", "neues Release", "release this", "cut a release",
  "Version veröffentlichen". Nur in diesem Repo (weyouze) sinnvoll.
---

# Release erstellen

Dieser Skill veröffentlicht eine neue Version, indem er einen `v*`-Tag pusht.
Das Bauen und Hochladen der Artefakte übernimmt die Pipeline
(`.github/workflows/release.yml`). Hintergrund und manueller Ablauf stehen in
[docs/release.md](../../../docs/release.md).

**Wichtig:** Ein gepushter Tag löst ein **öffentliches** GitHub-Release aus —
das ist nach außen gerichtet und nicht trivial rückgängig zu machen. Hole dir
deshalb vor dem Push **eine** explizite Bestätigung der Zielversion.

## Schritt 1 — Bump-Typ bestimmen

Standard ist **patch**. Leite den Typ aus der Nutzeräußerung ab:

- "patch" / "Bugfix" / nichts gesagt → `patch`
- "minor" / "neue Funktion" / "Feature-Release" → `minor`
- "major" / "Breaking" / "großes Release" → `major`

Bei Unklarheit kurz nachfragen, sonst `patch` annehmen.

## Schritt 2 — Pre-Flight-Checks (Abbruch bei Fehler)

Führe der Reihe nach aus und brich mit klarer Meldung ab, wenn etwas nicht passt:

1. Auf `main`? — `git rev-parse --abbrev-ref HEAD`. Wenn nicht, den Nutzer
   fragen, ob trotzdem von diesem Branch released werden soll (die Pipeline
   baut vom Tag-Commit, üblich ist `main`).
2. Arbeitsverzeichnis sauber? — `git status --porcelain`. Wenn nicht leer:
   abbrechen, denn `npm version` verweigert sonsthin den Dienst. Dem Nutzer
   sagen, dass uncommittete Änderungen erst committet/gestasht werden müssen.
3. Lokal aktuell? — `git fetch` und prüfen, dass `main` nicht hinter
   `origin/main` liegt. Wenn hinterher, zum `git pull` raten.
4. Tests grün? — `npm test`. Bei rotem Test abbrechen und Ausgabe zeigen.

## Schritt 3 — Zielversion berechnen und bestätigen

Aktuelle Version aus `package.json` lesen (`node -p "require('./package.json').version"`)
und die resultierende Version für den gewählten Bump nennen. Dann **bestätigen
lassen**, z. B.:

> „Aktuell 1.0.0 → neues Release **v1.0.1** (patch). Das pusht den Tag und
> veröffentlicht ein öffentliches Release über die Pipeline. Fortfahren?"

Erst nach Zustimmung weiter.

## Schritt 4 — Version bumpen (lokal, reversibel)

```sh
npm version <patch|minor|major>
```

Das aktualisiert `package.json`, committet und legt den Tag `vX.Y.Z` an — alles
noch **lokal**. Bis hierher ließe sich mit `git tag -d vX.Y.Z` und
`git reset --hard HEAD~1` zurückrollen.

## Schritt 5 — Pushen (Punkt ohne Wiederkehr)

```sh
git push origin main --tags
```

Der Push über SSH braucht `dangerouslyDisableSandbox: true` (Lesezugriff auf
`~/.ssh/known_hosts`).

## Schritt 6 — Pipeline beobachten und Ergebnis melden

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
  nur, sie taggt nicht.
- Artefakte sind **unsigniert** (Gatekeeper/SmartScreen erwartbar) — Stufe 1.
- Keine zusätzlichen Assets von Hand hochladen; das erledigt die Pipeline.
