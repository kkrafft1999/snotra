---
name: install
description: >-
  Baut Snotra AI lokal (electron-forge package, macOS/arm64) und ersetzt die
  installierte App unter /Applications/Snotra AI.app durch den frischen Build.
  Auslösen bei Sätzen wie "bau die App und kopier sie nach Programme",
  "installier die App lokal", "App neu bauen und installieren", "lokalen Build
  nach Applications", "install the app". Nur in diesem Repo (snotra) und auf
  einem Apple-Silicon-Mac sinnvoll.
---

# App lokal bauen und nach Programme installieren

Dieser Skill erzeugt einen lokalen, unsignierten Build und ersetzt damit die
installierte App. Es wird nichts committet, gepusht oder veröffentlicht.

## Schritt 1 — Pre-Flight (kurz, kein Nachfragen)

1. Node 24 verwenden. Die Default-Shell hat Node 20, damit scheitern Tests
   und ggf. der Build. Deshalb in **jedem** Bash-Aufruf den nvm-Pfad
   voranstellen:
   ```sh
   export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH"
   ```
   (Falls die Version nicht existiert: `ls ~/.nvm/versions/node/` und die
   neueste v24 nehmen.)
2. Läuft die App gerade? `pgrep -x "Snotra AI"`. Wenn ja, den Nutzer nicht
   fragen, sondern nach dem Kopieren darauf hinweisen, dass er die alte
   Instanz neu starten muss. Nur beenden (`osascript -e 'quit app "Snotra AI"'`),
   wenn der Nutzer das ausdrücklich möchte.
3. Uncommittete Änderungen sind **erlaubt**. Genau dafür ist der lokale
   Build da (Stand ausprobieren, bevor er committet wird). Kurz erwähnen,
   dass der Build den Arbeitsstand inkl. uncommitteter Änderungen enthält.

## Schritt 2 — Bauen

```sh
export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH" && npm run package
```

`npm run package` (siehe `package.json`) synchronisiert zuerst die
Renderer-Vendor-Dateien und ruft dann `electron-forge package --arch arm64
--platform darwin` auf. Ergebnis:

```
out/Snotra AI-darwin-arm64/Snotra AI.app
```

Bei Fehlern abbrechen und die relevante Ausgabe zeigen. Nicht auf Verdacht
`node_modules` löschen oder `npm install` ausführen. Erst wenn die Fehlermeldung
eindeutig auf fehlende Abhängigkeiten zeigt, `npm install` vorschlagen.

## Schritt 3 — Installieren

```sh
rm -rf "/Applications/Snotra AI.app" && cp -R "out/Snotra AI-darwin-arm64/Snotra AI.app" /Applications/
```

Das Löschen betrifft nur die App-Bundle-Kopie unter `/Applications`, keine
Nutzerdaten (Settings liegen unter `~/Library/Application Support/`). Deshalb
keine Rückfrage nötig.

## Schritt 4 — Verifizieren und melden

```sh
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/Applications/Snotra AI.app/Contents/Info.plist"
```

Kurz melden: installierte Version, Git-Commit des Builds
(`git rev-parse --short HEAD`, plus Hinweis „mit uncommitteten Änderungen“,
falls `git status --porcelain` nicht leer ist) und ob eine laufende Instanz
neu gestartet werden muss. Die App nur starten (`open -a "Snotra AI"`), wenn
der Nutzer das gesagt hat.

## Hinweise

- Der Build ist **unsigniert**. Beim ersten Start kann Gatekeeper meckern.
  Das ist erwartbar (Stufe 1, siehe `docs/release.md`).
- Für ein veröffentlichtes Release gibt es den separaten Skill `release`.
  Dieser Skill hier ersetzt ihn nicht.
- Windows-Build (`npm run package:win`) ist nicht Teil dieses Skills.
