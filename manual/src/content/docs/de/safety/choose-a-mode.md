---
title: Einen Modus wählen
description: Stell einen Chat auf Intelligent, Immer fragen oder Auto, und gib einem Ordner einen eigenen Standardmodus.
sidebar:
  order: 3
---

Der Modus entscheidet, wie oft Snotra dich fragt. Er gehört zum Chat: Jeder Chat hat seinen eigenen, und du kannst ihn jederzeit wechseln.

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
3. Bei *Auto* fragt das Betriebssystem noch einmal: *Auto / Vollzugriff aktivieren?* Bestätige mit *Auto aktivieren*.

Zurück zu *Intelligent* oder weiter zu *Immer fragen* fragt nie nach — wer Snotra vorsichtiger macht, muss nichts bestätigen.

![Das Modus-Menü über dem Chat-Eingabefeld: Intelligent, Immer fragen und Auto, jeweils mit einer kurzen Beschreibung, „Immer fragen“ ausgewählt. Darunter das Kästchen „„Immer fragen“ auch für neue Chats in gartenplaner“ und der Link „Alle Berechtigungen unter Einstellungen › Tools & Sicherheit“.](screenshots/mode-menu.webp)

## Einem Ordner einen Standardmodus geben

Ein neuer Chat startet in *Intelligent*, außer sein Ordner hat einen eigenen Standard:

- **Aus dem Chat:** Stell den Chat auf den gewünschten Modus, öffne das Menü noch einmal und hak *„‹Modus›“ auch für neue Chats in ‹Ordner›* an.
- **Aus den Einstellungen:** Wähle ihn unter *Standardmodus* oben auf der Seite *Einstellungen › Tools & Sicherheit*.

*Auto* als Standard bestätigst du einmal in einem Systemdialog, der den Ordner nennt, mit *„Auto“ als Standard*. Ab dann markiert das Menü diesen Modus mit *Standard in ‹Ordner›*, und jeder neue Chat im Ordner startet damit, auch nach einem Neustart. Einen einzelnen Chat kannst du trotzdem umstellen; das bleibt eine Entscheidung für diesen Chat.

Der Standard liegt bei deinen Berechtigungen, nicht im Ordner. Ein Repository, das du herunterlädst, kann sich nicht selbst auf *Auto* stellen.

## Was dann passiert

- Die Pille zeigt den neuen Modus, und jeder Tool-Aufruf richtet sich ab jetzt danach.
- Ein Chat aus dem Verlauf kommt mit seinem eigenen Modus zurück.
- *Auto* für einen einzelnen Chat überdauert keinen Neustart: Nach dem Start läuft dieser Chat auf *Intelligent*, bis du ihn wieder aus dem Verlauf öffnest. Ein Ordner mit *Auto* als Standard bleibt auf *Auto*.

## Wenn es nicht klappt

- **Die Pille zeigt *Auto · nicht isoliert*, in Bernstein.** In diesem Ordner liefen Befehle oder Python ohne Sandbox und ohne Rückfrage — weil du die Sandbox für den Ordner abgeschaltet hast oder weil das System keine hat (Windows). Das Menü sagt, was davon zutrifft. Siehe [Befehle in der Sandbox ausführen](../sandbox/).
- ***Auto* lässt sich nicht wählen.** Dafür braucht es den verschlüsselten Speicher des Systems, damit deine Berechtigungen vor Manipulation sicher sind. Ohne ihn — etwa auf einem Linux-Desktop ohne Schlüsselbund — funktionieren *Intelligent* und *Immer fragen* wie gewohnt.
- **Das Kästchen für neue Chats fehlt.** Es erscheint, sobald der Chat oder der Standard des Ordners nicht auf *Intelligent* steht.
