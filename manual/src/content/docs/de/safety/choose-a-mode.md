---
title: Einen Modus wählen
description: Stell einen Chat auf Intelligent, Immer fragen oder Auto. Der Ordner merkt sich deine Wahl für seine neuen Chats.
sidebar:
  order: 3
---

Der Modus entscheidet, wie oft Snotra dich fragt. Jeder Chat hat seinen eigenen, und du kannst ihn jederzeit wechseln. Der Ordner merkt sich, was du zuletzt gewählt hast: Neue Chats darin starten mit diesem Modus.

## Die drei Modi

| Modus | Lesen | Alles andere: sensible Dateien, Änderungen, Befehle, externe Dienste |
| --- | --- | --- |
| *Intelligent* — der Standard | läuft | fragt vorher |
| *Immer fragen* | fragt | fragt vorher |
| *Auto* | läuft | läuft ohne Rückfrage |

- ***Intelligent*** liest im geöffneten Ordner ohne Rückfrage und fragt vor allem anderen. Freigaben, die du für eine Sitzung oder dauerhaft gegeben hast, gelten.
- ***Immer fragen*** fragt vor jedem Tool-Aufruf, auch vor dem Lesen. Freigaben gelten nicht. Nimm diesen Modus für einen Ordner, dessen Inhalt du genau im Blick behalten willst.
- ***Auto*** fragt nichts. Die Ordnergrenze, deine Sperren und der Schutz von Snotras eigenen Schlüsseln bleiben bestehen; was [in jedem Modus gilt](../why-snotra-asks/#was-in-jedem-modus-gilt), gilt auch hier. Schalte ihn bewusst ein, für eine Aufgabe, der du vertraust.

## Schritte

1. Klick im Chat-Eingabefeld auf die Modus-Pille. Sie zeigt den aktuellen Modus, zum Beispiel *Intelligent*.
2. Wähl einen Modus aus dem Menü.
3. Bei *Auto* fragt das Betriebssystem noch einmal: *Auto / Vollzugriff aktivieren?* Der Dialog nennt den Ordner, weil neue Chats dort dann ebenfalls mit *Auto* starten. Bestätige mit *Auto aktivieren*.

Zurück zu *Intelligent* oder weiter zu *Immer fragen* fragt nie nach — wer Snotra vorsichtiger macht, muss nichts bestätigen.

![Das Modus-Menü über dem Chat-Eingabefeld: Intelligent, Immer fragen und Auto, jeweils mit einer kurzen Beschreibung, „Immer fragen“ ausgewählt und mit „Standard in gartenplaner“ markiert. Darunter der Link „Alle Berechtigungen unter Einstellungen › Tools › Autonomie“.](screenshots/mode-menu.webp)

## Der Standardmodus des Ordners

[seit 1.30] Der Modus, den du in einem Chat wählst, wird zugleich zum Standard des Ordners. Jeder neue Chat in diesem Ordner startet damit, auch nach einem Neustart — *Auto* eingeschlossen. Nur ein Ordner, in dem du noch nie einen Modus gewählt hast, startet in *Intelligent*.

- Das Menü markiert den Standard mit *Standard in ‹Ordner›*.
- Einen älteren Chat aus dem Verlauf zu öffnen ändert den Standard nicht; das tut nur die Wahl eines Modus.
- Du kannst den Standard auch ohne Chat festlegen: unter *Standardmodus* oben auf der Seite *Einstellungen › Tools › Autonomie*. *Auto* bestätigst du dort in einem Systemdialog, der den Ordner nennt, mit *„Auto“ als Standard*.

Der Standard liegt bei deinen Berechtigungen, nicht im Ordner. Ein Repository, das du herunterlädst, kann sich nicht selbst auf *Auto* stellen.

## Was dann passiert

- Die Pille zeigt den neuen Modus, und jeder Tool-Aufruf richtet sich ab jetzt danach.
- Ein Chat aus dem Verlauf kommt mit seinem eigenen Modus zurück.
- Nach einem Neustart kommt ein Chat mit dem Standard des Ordners zurück. Ein Chat auf *Auto*, dessen Ordner inzwischen einen anderen Standard hat — weil du ihn danach in den Einstellungen geändert hast —, läuft auf diesem Standard, bis du ihn wieder aus dem Verlauf öffnest.

## Wenn es nicht klappt

- **Die Pille zeigt *Auto · nicht isoliert*, in Bernstein.** In diesem Ordner liefen Befehle oder Python ohne Sandbox und ohne Rückfrage — weil du die Sandbox für den Ordner abgeschaltet hast oder weil das System keine hat (Windows). Das Menü sagt, was davon zutrifft. Siehe [Befehle in der Sandbox ausführen](../sandbox/).
- ***Auto* lässt sich nicht wählen.** Dafür braucht es den verschlüsselten Speicher des Systems, damit deine Berechtigungen vor Manipulation sicher sind. Ohne ihn — etwa auf einem Linux-Desktop ohne Schlüsselbund — funktionieren *Intelligent* und *Immer fragen* wie gewohnt.
- **Ein neuer Chat startet nicht mit dem Modus, den ich gewählt habe.** Der Standard gehört zu dem Ordner, in dem der Chat lag. In einem anderen Ordner, oder ohne geöffneten Ordner, starten neue Chats mit dessen Standard oder mit *Intelligent*.
