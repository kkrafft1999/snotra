---
title: Snotra Agent installieren
description: Lade Snotra Agent für macOS, Windows oder Linux herunter und installiere es.
sidebar:
  order: 1
---

Snotra Agent ist eine Desktop-App für macOS, Windows und Linux. Ein Konto brauchst du nicht: Du lädst eine Datei herunter, installierst sie und startest die App.

## Was du brauchst

- **macOS:** einen Mac mit Apple-Chip (M1 oder neuer) und macOS 13 Ventura oder neuer.
- **Windows:** Windows 10 oder 11 in der 64-Bit-Version.
- **Linux:** eine 64-Bit-Distribution (x64). Das `.deb`-Paket passt zu Debian, Ubuntu, Linux Mint, Pop!_OS und ihren Verwandten; die beiden anderen Varianten laufen überall.
- **Später zum Chatten:** einen API-Schlüssel von OpenAI, Anthropic oder Google oder ein Sprachmodell, das auf deinem eigenen Rechner läuft. Beides erklärt [Ein Modell anbinden](../connect-a-model/).

## Herunterladen

Jede Version liegt auf der [Release-Seite auf GitHub](https://github.com/kkrafft1999/snotra/releases/latest). Unter *Assets* wählst du die Datei für dein System:

| System | Datei |
| --- | --- |
| macOS (Apple-Chip) | `Snotra-Agent-<version>-mac-arm64.dmg` |
| Windows (x64) | `Snotra-Agent-<version>-win-x64.zip` |
| Linux (x64) | `Snotra-Agent-<version>-linux-x64.deb` (empfohlen), `.AppImage` oder `.tar.gz` |

## Auf macOS installieren

1. Öffne die heruntergeladene `.dmg`-Datei.
2. Zieh im Fenster, das sich öffnet, *Snotra Agent* auf den Ordner *Programme*.
3. Wirf das Disk-Image aus und starte Snotra Agent aus *Programme* oder dem Launchpad.
4. macOS fragt einmal, ob du eine aus dem Internet geladene App öffnen willst. Bestätige mit *Öffnen*.

Die App ist vom Entwickler signiert und von Apple notarisiert, deshalb bleibt es bei dieser einen Frage.

## Auf Windows installieren

1. Klick mit der rechten Maustaste auf die heruntergeladene `.zip`-Datei und wähle *Alle extrahieren…*. Wähl einen Ort in deinem Benutzerordner, zum Beispiel `C:\Users\<du>\Snotra Agent`.
2. Öffne diesen Ordner und starte `Snotra Agent.exe`.
3. Windows SmartScreen warnt, dass es die App nicht kennt, weil der Windows-Build noch nicht signiert ist. Klick auf *Weitere Informationen* und dann auf *Trotzdem ausführen*. Windows fragt das nur beim ersten Start.

Leg die App in einen Ordner, in den du schreiben darfst, nicht nach `C:\Program Files`. Snotra aktualisiert sich selbst, indem es seinen eigenen Ordner ersetzt, und das geht nicht, wo Windows nach Administratorrechten fragt. Damit du die App später aus dem Startmenü oder der Taskleiste startest, heftest du `Snotra Agent.exe` per Rechtsklick dort an.

## Auf Linux installieren

Es gibt drei Varianten. Nimm das `.deb`, wenn deine Distribution es versteht.

**`.deb`, empfohlen** für Debian, Ubuntu, Linux Mint, Pop!_OS und ihre Verwandten:

```bash
sudo apt install ./Snotra-Agent-<version>-linux-x64.deb
```

Danach steht Snotra Agent in deinem Anwendungsmenü. Das Paket installiert außerdem `bubblewrap`, `socat` und `ripgrep`, die Snotra braucht, um Shell-Befehle und Python in einer Sandbox auszuführen. Nur in dieser Variante ist auch die eigene Sandbox der App vollständig eingerichtet. Eine `.deb`-Installation aktualisiert sich nicht selbst: Die nächste Version installierst du auf dieselbe Weise.

**AppImage**, eine einzelne Datei, ohne Installation und ohne Administratorrechte:

```bash
chmod +x Snotra-Agent-<version>-linux-x64.AppImage
./Snotra-Agent-<version>-linux-x64.AppImage
```

Auf dem Weg durch den Browser verliert die Datei ihr Ausführungsrecht, deshalb ist `chmod +x` einmal nötig.

**Tarball**, der Ausweg, wenn keine der beiden anderen Varianten passt:

```bash
tar -xzf Snotra-Agent-<version>-linux-x64.tar.gz
cd snotra-agent-<version>-linux-x64
./"Snotra Agent"
```

Mit dem AppImage oder dem Tarball installierst du die Sandbox-Pakete selbst: `sudo apt install bubblewrap socat ripgrep` oder das Gegenstück deiner Distribution.

## Was dann passiert

Snotra Agent öffnet ein leeres Fenster: noch kein Ordner, noch kein Modell. [Der erste Start](../first-start/) zeigt, was du dort siehst und wie es weitergeht.

Einstellungen und Chats liegen in einem eigenen Profilordner außerhalb der App: auf macOS `~/Library/Application Support/Snotra AI`, auf Windows `%APPDATA%\Snotra AI` und auf Linux `~/.config/Snotra AI`. Er trägt den Namen der Plattform, Snotra AI, und bleibt erhalten, wenn du die App aktualisierst oder neu installierst. Spätere Versionen installieren sich nach deiner Bestätigung selbst; [Snotra Agent aktualisieren](../../updating/update-snotra/) zeigt, wie.

## Wenn es nicht klappt

- **Windows bietet kein *Trotzdem ausführen* an.** Der Knopf erscheint erst, nachdem du auf *Weitere Informationen* geklickt hast. Auf einem Rechner, den eine Organisation verwaltet, kann eine Richtlinie unsignierte Apps ganz sperren; dann kann sie nur deine IT freigeben.
- **Linux, Tarball: Die App startet nicht und meldet** *The SUID sandbox helper binary was found, but is not configured correctly.* Manche Distributionen, darunter Ubuntu ab 24.04, schränken ein, was die Browser-Engine in Snotra braucht. Behebe das einmal im entpackten Ordner:

  ```bash
  cd snotra-agent-<version>-linux-x64
  sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
  ```

- **Linux, AppImage: Die App startet auf Ubuntu ab 24.04 nicht.** Dieselbe Ursache wie oben, aber im AppImage greift die Abhilfe nicht, weil es nur lesbar eingehängt wird. Nimm stattdessen das `.deb`.
