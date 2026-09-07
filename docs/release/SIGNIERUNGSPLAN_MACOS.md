# Plan zur Signierung und Veröffentlichung einer macOS-App

## Ziel

Die App soll für die Distribution außerhalb des Mac App Store signiert, notarisiert und als DMG oder PKG veröffentlicht werden. Ziel ist, dass macOS Gatekeeper die App als vertrauenswürdig erkennt und Nutzer sie ohne Warnungen wegen einer unbekannten Quelle öffnen können.

> Dieser Plan gilt für eine klassische macOS-App mit **Developer ID**. Für den Mac App Store gelten zusätzlich App-Store-Connect-, Provisioning- und Sandbox-Anforderungen.

## 1. Entscheidungen und Voraussetzungen

- [ ] Vertriebsweg festlegen:
  - [ ] DMG mit `.app` für direkte Downloads
  - [ ] PKG für Installationen mit Installer/Privileged Helper
  - [ ] Mac App Store, falls erforderlich
- [ ] Bundle Identifier festlegen, z. B. `com.example.product`.
- [ ] Mindestversion von macOS und unterstützte Architekturen festlegen:
  - [ ] Apple Silicon (`arm64`)
  - [ ] Intel (`x86_64`)
  - [ ] Universal Binary, falls beide unterstützt werden
- [ ] Release- und Versionsschema definieren, z. B. `CFBundleShortVersionString = 1.4.0` und `CFBundleVersion = 1400`.
- [ ] Apple Developer Program und Zugriff auf das Team prüfen.
- [ ] Verantwortliche Personen für Zertifikate, Notarisierung und Release benennen.

## 2. Apple-Zertifikate und Schlüssel einrichten

Im Apple-Developer-Account beziehungsweise in Xcode folgende Identitäten bereitstellen:

- [ ] **Developer ID Application** für die Signierung der App und ihrer eingebetteten Komponenten.
- [ ] **Developer ID Installer** nur, wenn ein signiertes PKG veröffentlicht wird.
- [ ] Falls Xcode verwendet wird: passendes Team und Signing-Konfiguration für das Release auswählen.
- [ ] Private Schlüssel sicher im Schlüsselbund oder in einem CI-Secret-Store hinterlegen.
- [ ] Zertifikate niemals in das Repository committen.
- [ ] Ablaufdatum und Erneuerungsprozess dokumentieren.
- [ ] Für CI ein dediziertes Release-Zertifikat oder eine dedizierte Build-Maschine verwenden.

Für automatisierte Notarisierung:

- [ ] App-Store-Connect-API-Key für den zuständigen Benutzer oder eine geeignete Apple-ID- beziehungsweise Keychain-Konfiguration anlegen.
- [ ] `issuer ID`, `key ID` und die private `.p8`-Datei sicher speichern.
- [ ] Berechtigungen auf das notwendige Minimum beschränken.

## 3. Projekt für die Signierung vorbereiten

- [ ] Bundle Identifier in allen Targets, Extensions, XPC Services und Helper-Apps eindeutig konfigurieren.
- [ ] **Hardened Runtime** aktivieren.
- [ ] Nur die benötigten Hardened-Runtime-Entitlements aktivieren, zum Beispiel:
  - [ ] JIT, falls technisch erforderlich
  - [ ] unsigned executable memory, falls technisch erforderlich
  - [ ] Apple Events, falls die App andere Apps steuert
  - [ ] Netzwerk-, Datei- oder Hardware-Rechte nur entsprechend dem tatsächlichen Bedarf
- [ ] Entitlements-Dateien versionieren und fachlich begründen.
- [ ] Prüfen, dass sensible Berechtigungen nicht unnötig aktiviert sind.
- [ ] Sandbox und Datenschutzkonfiguration festlegen, falls die App sandboxed oder im Mac App Store verteilt wird.
- [ ] Alle Drittanbieter-Frameworks, dylibs, Plug-ins, Login Items, Services und Helper als signierungsfähige Bestandteile identifizieren.
- [ ] Keine unnötigen ausführbaren Dateien, Debug-Symbole oder Testdaten in das Release-Bundle aufnehmen.

## 4. Reproduzierbaren Release-Build erstellen

- [ ] Release-Konfiguration verwenden, niemals einen Debug-Build veröffentlichen.
- [ ] Build in einer sauberen Umgebung mit festgelegten Toolchain-Versionen durchführen.
- [ ] Abhängigkeiten sperren und reproduzierbar installieren.
- [ ] Architektur und Mindestbetriebssystem im Build prüfen.
- [ ] Unit-, Integrations- und UI-Tests ausführen.
- [ ] Bei Universal Apps die Binary für beide Architekturen separat testen.
- [ ] Build-Artefakte mit Versionsnummer, Commit-Hash und Builddatum kennzeichnen.
- [ ] Vor der Signierung keine Dateien mehr im App-Bundle verändern.

Beispiel mit Xcode:

```bash
xcodebuild \\
  -workspace MyApp.xcworkspace \\
  -scheme MyApp \\
  -configuration Release \\
  -archivePath build/MyApp.xcarchive \\
  archive

xcodebuild -exportArchive \\
  -archivePath build/MyApp.xcarchive \\
  -exportOptionsPlist ExportOptions.plist \\
  -exportPath build/export
```

Die konkreten Export-Optionen müssen zum Vertriebsweg und zu den verwendeten Targets passen.

## 5. Signieren

### Empfohlene Reihenfolge

Wenn manuell signiert wird, immer von innen nach außen signieren:

1. dylibs und Frameworks
2. Plug-ins und Helper-Executables
3. XPC Services und Login Items
4. App-Bundle
5. DMG oder PKG als Distributionscontainer

Xcode kann diese Schritte bei einer korrekt konfigurierten Archive-/Export-Konfiguration übernehmen. Das Ergebnis muss trotzdem unabhängig geprüft werden.

Beispiel für eine manuelle App-Signierung:

```bash
codesign --force --options runtime \\
  --entitlements MyApp.entitlements \\
  --sign "Developer ID Application: Example Corp (TEAMID)" \\
  "build/export/MyApp.app"
```

Falls eingebettete Komponenten vorhanden sind, ist sicherzustellen, dass jede ausführbare Komponente mit der richtigen Identität und den passenden Entitlements signiert wurde. Keine Platzhalter oder Zertifikatsnamen ungeprüft in ein produktives Skript übernehmen.

## 6. Signatur lokal prüfen

- [ ] Signatur vollständig und mit dem erwarteten Zertifikat prüfen:

```bash
codesign --verify --deep --strict --verbose=4 "build/export/MyApp.app"
codesign --display --verbose=4 "build/export/MyApp.app"
codesign -d --entitlements :- "build/export/MyApp.app"
```

- [ ] Autorisierung der gesamten App durch Gatekeeper prüfen:

```bash
spctl --assess --type execute --verbose=4 "build/export/MyApp.app"
```

- [ ] Alle verschachtelten ausführbaren Komponenten auf korrekte Signaturen prüfen.
- [ ] Prüfen, dass nach dem Signieren keine Ressource mehr verändert wurde.
- [ ] App auf einem sauberen Mac beziehungsweise in einer sauberen VM testen, idealerweise ohne vorherige Entwickler-Installation.
- [ ] Verhalten beim ersten Start, bei Updates, beim Entfernen der Quarantäne und bei fehlenden Berechtigungen testen.

## 7. Notarisierung bei Apple

Für die direkte Distribution muss die signierte Software an Apples Notarisierungsdienst übermittelt werden.

- [ ] Notarisierungs-Authentifizierung in der CI oder lokal konfigurieren.
- [ ] App als ZIP mit erhaltenem App-Bundle packen:

```bash
ditto -c -k --keepParent \\
  "build/export/MyApp.app" \\
  "build/notary/MyApp.zip"
```

- [ ] ZIP mit `notarytool` einreichen:

```bash
xcrun notarytool submit "build/notary/MyApp.zip" \\
  --key "$ASC_KEY_PATH" \\
  --key-id "$ASC_KEY_ID" \\
  --issuer "$ASC_ISSUER_ID" \\
  --wait
```

- [ ] Bei Fehlern das Protokoll abrufen und auswerten:

```bash
xcrun notarytool log <SUBMISSION-ID> \\
  --key "$ASC_KEY_PATH" \\
  --key-id "$ASC_KEY_ID" \\
  --issuer "$ASC_ISSUER_ID"
```

- [ ] Erst nach erfolgreicher Notarisierung das Distributionsartefakt veröffentlichen.

## 8. DMG oder PKG bauen und versiegeln

### DMG

- [ ] Nur die bereits signierte und notariserte App in das DMG aufnehmen.
- [ ] Keine nachträglichen Änderungen an der App durchführen.
- [ ] DMG erzeugen, anschließend DMG selbst mit **Developer ID Application** signieren:

```bash
hdiutil create -volname "MyApp" \\
  -srcfolder "build/export/MyApp.app" \\
  -ov -format UDZO \\
  "build/release/MyApp.dmg"

codesign --force --sign \\
  "Developer ID Application: Example Corp (TEAMID)" \\
  "build/release/MyApp.dmg"
```

- [ ] Das DMG entweder zusammen mit der App oder als finale Distribution notarisiert einreichen.
- [ ] Nach erfolgreicher Notarisierung das Ticket anheften:

```bash
xcrun stapler staple "build/release/MyApp.dmg"
xcrun stapler validate "build/release/MyApp.dmg"
```

### PKG

- [ ] Komponenten-PKG mit **Developer ID Installer** signieren.
- [ ] Das finale PKG einreichen, nach erfolgreicher Prüfung stapeln und validieren:

```bash
productbuild --component "build/export/MyApp.app" /Applications \\
  --sign "Developer ID Installer: Example Corp (TEAMID)" \\
  "build/release/MyApp.pkg"

xcrun notarytool submit "build/release/MyApp.pkg" --wait ...
xcrun stapler staple "build/release/MyApp.pkg"
xcrun stapler validate "build/release/MyApp.pkg"
```

Die Platzhalter `...` müssen durch die konfigurierte Authentifizierung ersetzt werden. Bei komplexen Installationsskripten ist besonders zu prüfen, ob diese ebenfalls signiert beziehungsweise von macOS akzeptiert werden.

## 9. Finale Integritäts- und Funktionstests

- [ ] Signatur des finalen DMG/PKG prüfen:

```bash
codesign --verify --verbose=4 "build/release/MyApp.dmg"
pkgutil --check-signature "build/release/MyApp.pkg"  # nur bei PKG
```

- [ ] Notarisierungsstatus und Stapling prüfen:

```bash
xcrun stapler validate "build/release/MyApp.dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 \\
  "build/release/MyApp.dmg"
```

- [ ] Artefakt auf einem sauberen System herunterladen und ausführen.
- [ ] Download über HTTPS sowie korrekten Dateinamen und Dateigröße prüfen.
- [ ] Prüfsumme veröffentlichen, wenn Nutzer die Integrität selbst verifizieren sollen:

```bash
shasum -a 256 "build/release/MyApp.dmg"
```

- [ ] Erststart ohne Xcode, lokale Entwicklungszertifikate oder lokale Build-Dateien testen.
- [ ] Upgrade von der vorherigen Version testen.
- [ ] Deinstallation und erneute Installation testen.
- [ ] Datenschutzdialoge, Keychain-Zugriff, Login Items, Updates und Netzwerkzugriffe testen.

## 10. CI/CD und Sicherheit

- [ ] Signierung und Notarisierung nur in einem geschützten Release-Job erlauben.
- [ ] Zertifikate und API-Schlüssel aus Secret Management beziehen, nicht aus Klartextdateien.
- [ ] Kurzlebige beziehungsweise dedizierte CI-Schlüssel verwenden, wenn möglich.
- [ ] Logs auf Zertifikats- und Secret-Leaks prüfen.
- [ ] Build, Signierung, Notarisierung und Veröffentlichung als getrennte Schritte mit Freigabe-Gate ausführen.
- [ ] Signierte Artefakte und zugehörige Prüfsummen archivieren.
- [ ] Commit-Hash, Xcode-Version, macOS-Version, Signaturidentität und Notarisierungs-ID protokollieren.
- [ ] Zertifikatsablauf und Notfallrotation überwachen.
- [ ] Bei kompromittierten Schlüsseln sofort widerrufen, CI-Secrets rotieren und eine neue Version veröffentlichen.

## 11. Release-Checkliste

- [ ] Versionsnummer und Release Notes aktualisiert
- [ ] Release-Tests erfolgreich
- [ ] Alle Targets und eingebetteten Komponenten signiert
- [ ] Hardened Runtime aktiv
- [ ] `codesign --verify` erfolgreich
- [ ] `spctl`-Prüfung erfolgreich
- [ ] Notarisierung erfolgreich
- [ ] Ticket an DMG/PKG angeheftet und validiert
- [ ] Sauberer Installations- und Upgrade-Test erfolgreich
- [ ] Prüfsumme erstellt
- [ ] Downloadseite und Dokumentation aktualisiert
- [ ] Artefakt, Logs und Notarisierungs-ID archiviert
- [ ] Rollback auf die vorherige Version vorbereitet

## Empfohlene Reihenfolge der Umsetzung

1. Bundle Identifier, Targets, Architekturen und Vertriebsweg festlegen.
2. Developer-ID-Zertifikate und sichere CI-Secrets einrichten.
3. Hardened Runtime und minimale Entitlements konfigurieren.
4. Reproduzierbaren Release-Build automatisieren.
5. Signierung aller verschachtelten Komponenten einrichten.
6. Lokale Signatur- und Gatekeeper-Prüfungen automatisieren.
7. Notarisierung mit `notarytool` integrieren.
8. DMG/PKG erstellen, signieren und stapeln.
9. Sauberinstallation, Upgrade und Erststart auf unterstützten macOS-Versionen testen.
10. Freigabeprozess, Überwachung und Zertifikatsrotation dokumentieren.
