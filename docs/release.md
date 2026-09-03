# Release & Self-Update

Die App hat einen **Update-Notifier** (Stufe 1): Beim Start und über
*Hilfe → Nach Updates suchen…* (bzw. den Link in den Einstellungen) prüft sie
das **neueste GitHub-Release** dieses Repos und blendet bei einer neueren
Version ein Banner mit Download-Link ein. Es wird **nichts automatisch
installiert** — der Download läuft über den Browser, Installation manuell.

Damit das funktioniert, muss es überhaupt Releases geben. Dieser Ablauf legt
sie an.

## Voraussetzungen (einmalig)

- Das Repo muss **öffentlich** sein, sonst kann die unsignierte App die
  Releases-API nicht ohne Token lesen:
  ```sh
  gh repo edit kkrafft1999/snotra --visibility public
  ```
- `gh` muss authentifiziert sein (`gh auth status`).

## Version als Single Source of Truth

Die angezeigte und verglichene Version kommt aus `version` in
[`package.json`](../package.json) (→ `app.getVersion()`). Vor jedem Release
hochzählen (SemVer):

```sh
npm version patch   # oder: minor / major  — setzt package.json + erstellt Git-Tag vX.Y.Z
```

`npm version` legt den Tag `vX.Y.Z` automatisch an und committet den Bump.
Alternativ die Version von Hand in `package.json` ändern und selbst taggen:

```sh
git tag vX.Y.Z
```

## Build

```sh
npm run make            # macOS arm64  -> out/make/*.dmg + ZIP
npm run package:win     # Windows x64  -> out/<productName>-win32-x64/  (zum Zippen)
```

Die Artefakte landen unter `out/`. Der Vergleich der App nutzt **nur den
Release-Tag**, nicht die Dateinamen — die Asset-Namen sind also frei wählbar,
sollten aber Version und Plattform enthalten, z. B.
`Snotra-AI-1.1.0-mac-arm64.dmg`.

### App-Icon

`icon.icns` (macOS) und `icon.ico` (Windows) sind eingecheckt und werden von
der Pipeline **nicht** neu gebaut. Quelle sind die SVGs in `assets/icon/`
(`icon-macos.svg` mit Apple-Icon-Raster und Schatten, `icon-windows.svg`
vollflächig). Nach einer Änderung daran einmal lokal erzeugen — braucht
`rsvg-convert` (`brew install librsvg`) und `iconutil` (Xcode Command Line
Tools):

```sh
node scripts/build-icons.js
```

## Release veröffentlichen

```sh
git push origin main --tags

gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "Was ist neu …" \
  "out/make/Snotra AI.dmg#Snotra AI (macOS, Apple Silicon)"
```

Weitere Assets (z. B. das Windows-ZIP) als zusätzliche Pfade anhängen. Der Text
aus `--notes` erscheint als Release-Body und steht der App im Banner als
`notes` zur Verfügung.

> Hinweis: Solange die App **nicht code-signiert** ist, zeigt macOS beim ersten
> Start der neuen Version den Gatekeeper-Dialog. Das ist erwartet und kein
> Fehler des Update-Wegs.

## Was die App prüft

- Endpoint: `GET https://api.github.com/repos/kkrafft1999/snotra/releases/latest`
- Installationen bis v1.0.4 fragen noch `kkrafft1999/weyouze` ab; GitHub leitet
  per 301 auf das umbenannte Repo um. Den alten Repo-Namen deshalb **nie
  wiederverwenden**, sonst bricht der Update-Hinweis alter Versionen.
- Vergleich: `tag_name` (ohne führendes `v`) gegen `app.getVersion()` via SemVer.
- **Drafts** werden ignoriert; **Prereleases** werden als solche markiert.
- Mit *Überspringen* gemerkte Versionen melden sich beim Auto-Check nicht mehr,
  ein manueller Check zeigt sie wieder.

Implementierung: [`src/main/services/update-service.js`](../src/main/services/update-service.js),
Tests: [`test/update-service.test.js`](../test/update-service.test.js).
