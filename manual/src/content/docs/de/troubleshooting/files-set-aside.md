---
title: Wenn Einstellungen oder der Verlauf neu anfangen
description: Was der Hinweis unter der Titelleiste bedeutet, wenn Snotra eine seiner Dateien nicht lesen konnte, wo die alte Datei geblieben ist und wie du sie zurückholst.
sidebar:
  order: 6
---

Snotra verwahrt deine Einstellungen, die Liste der zuletzt geöffneten Ordner und den Chatverlauf in Dateien im [Profilordner](../logs-and-reports/#der-profilordner). [seit 1.24] Lässt sich eine davon nicht lesen, schreibt Snotra nicht darüber. Es legt die Datei unverändert beiseite und sagt dir das in einem Hinweis unter der Titelleiste.

## Was du brauchst

Nichts außer der App. Um die alte Datei zu zeigen, nutzt Snotra deinen Dateimanager: den Finder unter macOS, den Explorer unter Windows.

## Schritte: wenn eine Datei beiseitegelegt wurde

Der Hinweis lautet ***Deine Modelleinstellungen wurden zurückgesetzt.***, ***Der Chatverlauf beginnt leer.*** oder ähnlich, je nach Datei. Darunter stehen der Name der Datei und der vollständige Pfad der Kopie, die Snotra aufbewahrt hat, zum Beispiel `llm-config.json.unreadable-2026-10-16T09-12-44-120Z`.

1. Wähle im Hinweis *Im Finder anzeigen* (unter Windows *Im Explorer anzeigen*), um die Kopie zu sehen.
2. Richte wieder ein, was zurückgesetzt wurde: deine Modelle unter *Einstellungen › Modelle*, den Schlüssel für die Websuche und die MCP-Server unter *Einstellungen › Tools › Einrichtung*. Die Ansichtseinstellungen und die Liste der zuletzt geöffneten Ordner füllen sich beim Arbeiten von selbst wieder.
3. Schließ den Hinweis mit ×. Für diese Datei kommt er erst wieder, wenn ihr erneut etwas passiert.

Behalte die Kopie, bis du sicher bist, dass du sie nicht mehr brauchst. Snotra löscht sie nie.

## Was passiert

Die Datei war nicht zu verstehen. Ihr Inhalt war beschädigt — durch einen Absturz beim Schreiben, ein Sync-Programm, eine Änderung von Hand —, oder eine neuere Snotra-Version hat sie geschrieben als die, die gerade läuft, etwa nachdem du zu einem älteren Release zurückgegangen bist. Snotra benennt die Datei um, hängt `.unreadable-` und die Uhrzeit an und fängt diesen Teil neu an. Jedes Byte der alten Datei steckt noch in der Kopie.

Beim Chatverlauf ist die Kopie der ganze Ordner, `chat-history.unreadable-…`, oder `chat-history.undecryptable-…`, wenn er sich mit dem Schlüssel dieses Systems nicht entschlüsseln ließ; für diesen Fall siehe [Schlüsselbund-Fragen und verschlüsselter Speicher](../keychain-and-storage/). [seit 1.25] Ist nur die Datei eines einzelnen Chats beschädigt, legt Snotra nur diese Datei im Ordner beiseite, und der Hinweis sagt ***Ein Chat ließ sich nicht lesen und fehlt im Verlauf.*** Deine anderen Chats bleiben. Ein Verlauf von vor 1.25 bleibt als `chat-history.json.unreadable-…` oder `chat-history.json.undecryptable-…` liegen.

## Wenn Änderungen nicht gespeichert werden

Ein roter Hinweis lautet ***Änderungen an deinen Modelleinstellungen werden nicht gespeichert.*** oder dasselbe für eine andere Datei. Snotra hat die Datei gefunden, konnte sie aber nicht lesen oder nicht beiseitelegen — ein anderes Programm hält sie fest, oder ihre Berechtigungen haben sich geändert. Deshalb lässt Snotra die Datei, wie sie ist, und überspringt das Speichern, statt über ihren Inhalt zu schreiben.

1. Wähle im Hinweis *Im Finder anzeigen* (unter Windows *Im Explorer anzeigen*), um die Datei zu sehen.
2. Schließ das Programm, das sie festhalten könnte — ein Sync- oder Backup-Programm, einen Editor —, oder gib deinem Benutzerkonto wieder das Recht, sie zu lesen und zu schreiben.
3. Ändere die Einstellung noch einmal.

Was dann passiert: Sobald ein Speichern durchgeht, verschwindet der rote Hinweis von selbst.

Der Chatverlauf hat für diesen Fall ein eigenes Banner im Chat; siehe [Wenn ein Chat nicht gespeichert wird](../keychain-and-storage/#wenn-ein-chat-nicht-gespeichert-wird).

## Wenn es nicht klappt

- **Ich will die alten Einstellungen zurück.** Beende Snotra. Lösche oder benenne im Profilordner die neue Datei um, dann gib der Kopie wieder ihren ursprünglichen Namen — zum Beispiel `llm-config.json`. Starte Snotra. War die Kopie beschädigt, wird sie wieder beiseitegelegt; hat eine neuere Version sie geschrieben, installiere diese Version wieder.
- **Der Hinweis kommt bei jedem Start wieder.** Etwas beschädigt die Datei immer wieder — meistens ein Sync-Programm, das im Profilordner arbeitet. Halte den Profilordner aus OneDrive, Dropbox oder iCloud Drive heraus.
- **Der rote Hinweis bleibt.** Die Datei ist weiter festgehalten oder nicht lesbar. Starte den Computer neu, damit nichts sie mehr festhält, und ändere die Einstellung dann noch einmal.
