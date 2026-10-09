---
title: Wenn Snotra sich nicht selbst aktualisiert
description: Welche Installationen sich selbst ersetzen und welche nicht, wie du diese von Hand aktualisierst und was du zur Schlüsselbund-Frage unter macOS und zu alten Windows-Versionen wissen musst.
sidebar:
  order: 3
---

Manche Installationen können sich nicht selbst ersetzen. Snotra sagt das im Update-Dialog mit dem Grund und verweist auf die Release-Seite, statt einen Download anzubieten, den es nicht installieren könnte.

## Was du brauchst

Die Datei für dein System von der [Release-Seite](https://github.com/kkrafft1999/snotra/releases/latest), dieselbe, mit der du installiert hast. [Snotra Agent installieren](../../getting-started/install/) nennt die Dateinamen.

## Wer sich selbst aktualisiert

| Installation | Aktualisiert sich selbst? | Wenn nicht |
| --- | --- | --- |
| macOS-App in *Programme* | Ja | |
| macOS-App, gestartet vom Disk-Image oder von einer Kopie, die macOS beiseitegelegt hat | Nein: Sie kann an ihrem Ort nicht schreiben | Verschiebe die App nach *Programme* und starte sie von dort. |
| Windows-Ordner, in den du schreiben darfst | Ja | |
| Windows-Ordner in `C:\Program Files` oder an einem anderen geschützten Ort | Nein: Er braucht Administratorrechte | Verschiebe den Ordner in deinen Benutzerordner oder aktualisiere von Hand. |
| Linux-AppImage | Ja | |
| Linux-Tarball in einem Ordner, in den du schreiben darfst | Ja | |
| Linux-Paket `.deb` | Nein: Das Ersetzen braucht Administratorrechte | `sudo apt install ./Snotra-Agent-<version>-linux-x64.deb` mit der neuen Datei. |
| Eine Kopie, die aus dem Quellcode gestartet wurde | Nein: Es gibt nichts zu ersetzen | Aktualisiere den Quellcode mit Git. |

## Schritte: von Hand aktualisieren

1. Klicke im Update-Dialog auf *Release-Seite öffnen* oder öffne die Release-Seite selbst.
2. Lade unter *Assets* die Datei für dein System herunter.
3. Beende Snotra Agent.
4. Installiere sie so wie beim ersten Mal: Unter macOS ziehst du die App auf *Programme* und bestätigst *Ersetzen*; unter Windows entpackst du die `.zip` über den alten Ordner oder in einen neuen und löschst den alten; unter Linux installierst du das `.deb` erneut oder ersetzt das AppImage bzw. den Ordner.
5. Starte Snotra Agent. Deine Chats, Einstellungen und Schlüssel sind noch da: Sie liegen im [Profilordner](../../getting-started/install/#was-passiert), nicht in der App.

## Was passiert

Die neue Version startet mit allem, was du hattest. Der Dialog bietet die Version nicht mehr an, sobald du sie ausführst.

## macOS fragt nach dem Schlüsselbund

Nach einem Update unter macOS fragt das System unter Umständen einmal, ob *Snotra Agent* das Schlüsselbund-Objekt **Snotra AI Safe Storage** verwenden darf. Dort verwahrt Snotra den Schlüssel, der deine API-Schlüssel und deinen Chat-Verlauf verschlüsselt; das Objekt trägt den Namen der Plattform, Snotra AI. Das passiert, wenn sich die Signatur der App geändert hat, etwa wenn eine ältere Version durch eine signierte ersetzt wurde.

Gib das Passwort deines Macs ein und wähle **Immer erlauben**. *Erlauben* allein fragt bei jedem Start erneut; *Ablehnen* lässt Snotra ohne seinen Schlüssel: Es meldet *Verschlüsselter Speicher ist nicht verfügbar*, die Modelle verschwinden aus dem Chat, und Chats werden nicht gespeichert. Beende Snotra, starte es neu und erlaube den Zugriff, wenn die Frage erscheint.

## Alte Versionen

Einige ältere Versionen brauchen einmal einen Schritt von Hand. Danach funktioniert das Selbst-Update wie oben beschrieben.

- **Windows bis Version 1.13.2.** Das Selbst-Update beendete die App, ließ aber die alte Version stehen, mit einem Ordner `.snotra-new-…` daneben. Beende Snotra, benenne den App-Ordner um (etwa in `Snotra-Agent.old`), entpacke die neue `.zip` unter dem alten Ordnernamen und starte sie. Lösche die übrig gebliebenen Ordner danach.
- **Windows und der Linux-Tarball, Version 1.16.0 und älter.** Sie können das umbenannte Paket *Snotra Agent* nicht selbst installieren. Aktualisiere einmal von Hand, auf dieselbe Weise; Verknüpfungen auf `Snotra AI.exe` musst du neu anlegen.
- **macOS, von Snotra AI zu Snotra Agent.** Das Selbst-Update ersetzt `Snotra AI.app` durch `Snotra Agent.app`; lege die neue App im Dock noch einmal ab. Hast du von Hand aus dem Disk-Image installiert, lösche danach die alte `Snotra AI.app`.
- **Das AppImage und das `.deb`-Paket** laufen wie bisher weiter.

## Wenn es nicht klappt

- **Der Update-Dialog bietet nur *Release-Seite öffnen* an.** Das gilt für die Installationen in der Tabelle oben; sein Text nennt den Grund, der auf deine zutrifft.
- **Windows: Nach dem Update startet noch die alte Version.** Du hast eine der alten Versionen oben, oder ein Fenster hatte den App-Ordner noch offen. Schließe es und versuch es noch einmal, oder aktualisiere von Hand.
