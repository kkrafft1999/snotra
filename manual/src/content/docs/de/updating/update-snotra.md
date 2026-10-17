---
title: Snotra Agent aktualisieren
description: Wie Snotra dich auf eine neue Version hinweist, wie du von Hand nachsiehst und die vier Schritte von „gefunden“ bis „installiert“.
sidebar:
  order: 1
---

Snotra Agent aktualisiert sich selbst – aber nie eigenmächtig. Es sucht still nach einer neuen Version, und jeder Schritt danach wartet auf deinen Klick und lässt sich bis zum letzten abbrechen.

## Was du brauchst

- Eine Verbindung zum Internet. Snotra fragt GitHub, wo die Releases liegen, und lädt von dort; ein Konto brauchst du nicht.
- Eine Installation, die sich selbst ersetzen darf. Das gilt für die macOS-App in *Programme*, den Windows-Ordner, das AppImage und den entpackten Linux-Ordner. Das `.deb`-Paket gehört nicht dazu, ebenso wenig eine App in einem Ordner, in den du nicht schreiben darfst – [Wenn Snotra sich nicht selbst aktualisiert](../by-hand/) behandelt diese Fälle.

## Schritte

**Auf den Hinweis warten oder selbst nachfragen.** Bei jedem Start sucht Snotra im Hintergrund nach einer neueren Version. Gibt es keine, sagt es nichts; gibt es eine, öffnet sich der Update-Dialog. [seit 1.24] Wer das nicht will, schaltet *Beim Start nach Updates suchen* unter [*Einstellungen › Allgemein*](../../customising/settings/#der-bereich-allgemein) aus. Selbst nachfragen kannst du in jedem Fall, jederzeit:

- *Hilfe › Nach Updates suchen…* oder
- *Einstellungen › Allgemein*, der Link *Nach Updates suchen* neben der Versionsnummer unten.

Bist du auf dem neuesten Stand, sagt der Dialog das und nennt deine Version.

![Einstellungen › Allgemein mit der Version unten links und dem Link „Nach Updates suchen“ daneben.](screenshots/update-check.webp)

**1. Gefunden.** Der Dialog nennt die neue Version, ihre Größe und deine aktuelle. Öffne *Was sich geändert hat*, um die Hinweise zu lesen – [Die Release Notes lesen](../release-notes/) sagt, was du dort findest. Dann wählst du:

![Der Update-Dialog „Version 1.18.0 ist verfügbar“ mit aufgeklappten Release Notes und den Knöpfen „Herunterladen“, „Später erinnern“ und „Diese Version überspringen“.](screenshots/update-found.webp)

- *Herunterladen* startet den Download.
- *Später erinnern* schließt den Dialog; beim nächsten Start fragt Snotra wieder.
- *Diese Version überspringen* bietet genau diese Version beim Start nicht mehr an. Die nächste Version wird wie gewohnt angeboten, und *Nach Updates suchen* zeigt auch eine übersprungene wieder.

**2. Wird geladen.** Der Dialog zeigt den Fortschritt. Du kannst in Snotra weiterarbeiten, während es läuft. *Abbrechen* stoppt den Download und löscht die halb geschriebene Datei.

**3. Bereit.** Erst jetzt fragt Snotra, ob es installieren soll. Beende vorher, was du gerade tippst: Beim Installieren wird die App beendet, und eine ungesendete Nachricht geht verloren. *Abbrechen* verwirft die geladene Datei.

![Der Update-Dialog „Version 1.18.0 ist bereit“ mit den Knöpfen „Installieren und neu starten“ und „Abbrechen“.](screenshots/update-ready.webp)

**4. Wird installiert.** *Installieren und neu starten* beendet Snotra, ersetzt es und startet die neue Version. Das ist der einzige Schritt ohne Weg zurück; der Dialog sagt es dazu.

## Was passiert

Deine Chats, Einstellungen und Schlüssel bleiben, wo sie sind: Sie liegen im [Profilordner](../../getting-started/install/#was-dann-passiert), den ein Update nicht anfasst.

Snotra lädt nur die Datei, die GitHub für deine Installation nennt, und prüft sie, bevor etwas ersetzt wird: Der Download muss zur Prüfsumme passen, die GitHub dafür angibt, und unter macOS muss die App darin Snotra Agent in der angekündigten Version sein. Schlägt eine Prüfung fehl, wird die Datei verworfen, und die laufende Version bleibt unangetastet.

[seit 1.25] Unter macOS und Linux bleibt die bisherige Version erhalten, bis die neue ihr Fenster geöffnet hat. Schließt sich die neue Version gleich wieder oder hat sie sich nach zwei Minuten nicht geöffnet, stellt Snotra die bisherige Version zurück, startet sie und sagt es dir beim nächsten Start.

## Wenn es nicht klappt

- ***Die Aktualisierung hat nicht geklappt.*** Der Dialog nennt den Grund, und die laufende Version ist unverändert. *Erneut versuchen* wiederholt den Download; mit *Release-Seite öffnen* holst du die Version selbst.
- ***Suche nach Updates fehlgeschlagen.*** Die Prüfung hat von GitHub keine brauchbare Antwort bekommen, Snotra kann also nicht sagen, ob es eine neue Version gibt. Der Dialog nennt den Grund; *Release-Seite öffnen* zeigt die neueste Version im Browser.
- ***GitHub begrenzt gerade die Anfragen aus deinem Netz.*** GitHub beantwortet von einer Netzwerkadresse nur eine begrenzte Zahl von Update-Prüfungen pro Stunde. Hinter einem VPN oder im Firmennetz teilst du dir dieses Kontingent mit allen anderen auf derselben Adresse, es kann also aufgebraucht sein, ohne dass du etwas getan hast. Der Dialog nennt die Uhrzeit, ab der es wieder geht – prüf dann noch einmal oder nutze die Release-Seite.
- ***Der Update-Server ist nicht erreichbar.*** Du bist offline, oder etwas zwischen dir und GitHub – ein Proxy, eine Firewall – blockiert. Versuch es später noch einmal oder nutze die Release-Seite von einer Verbindung, die funktioniert.
- ***Beim letzten Mal ließ sich Version … nicht einspielen*.** Das Austauschen ist gescheitert, nachdem Snotra sich beendet hatte. Unter Windows hatte meist ein Fenster oder ein anderes Programm den Ordner von Snotra Agent noch offen: Schließe sie und versuch es noch einmal. Der Dialog nennt den Pfad eines Protokolls mit den Einzelheiten. [seit 1.25] Auch macOS und Linux melden das.
- [seit 1.25] ***Beim letzten Mal wurde Version … eingespielt, startete aber nicht*.** Nur unter macOS und Linux. Die neue Version hat sich gleich wieder geschlossen oder ihr Fenster nicht innerhalb von zwei Minuten geöffnet, deshalb ist Snotra zur bisherigen zurückgekehrt. Deine Chats und Einstellungen sind davon nicht betroffen. Versuch es noch einmal; passiert es wieder, [melde es](../../troubleshooting/logs-and-reports/) und häng das Protokoll an, das der Dialog nennt.
- **Es wird nichts angeboten, obwohl es eine neue Version gibt.** Vielleicht hast du sie übersprungen, oder *Beim Start nach Updates suchen* ist aus: *Nach Updates suchen* zeigt sie trotzdem. Vorab-Versionen werden nie angeboten, nur das neueste reguläre Release.
