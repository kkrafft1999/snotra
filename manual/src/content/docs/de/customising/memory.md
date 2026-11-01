---
title: Snotra etwas merken lassen
description: Bitte Snotra, sich etwas für jeden späteren Chat zu merken, in diesem Projekt oder überall, und sieh nach oder lösch, was es behält.
sidebar:
  order: 4
---

Snotra fängt nicht jeden Chat bei null an. Worum du es bittest, sich zu merken, ist in jedem späteren Chat wieder da — auch in einem neuen und nach einem Neustart.

## Was du brauchst

Nichts für das globale Gedächtnis. Für das Projektgedächtnis einen geöffneten Ordner.

## Schritte

1. Sag es im Chat: *Bitte merk dir, dass die Beete in Zentimetern gemessen sind.*
2. Snotra fragt, wer es lesen soll — außer du hast es schon gesagt (*merk dir global …*), oder es ist kein Ordner geöffnet:
   - **Nur du** — global, in jedem Ordner.
   - **Snotra in diesem Ordner** — im Projektgedächtnis.
   - **Alle Werkzeuge hier** — in der `AGENTS.md` des Ordners, die auch andere Coding-Werkzeuge lesen und die meist mit dem Team geteilt wird. [seit 1.30]
3. Prüf die Karte. [seit 1.30] Sie zeigt Snotras Vorschlag als zwei Reihen zur Auswahl: *Art* — ein Fakt, eine [Regel](../rules/) oder ein Ablauf — und *Wer liest es*. Hat Snotra falsch einsortiert, wähl etwas anderes: Ein anderer Leser oder *Fakt* wird so geschrieben, wie du es gewählt hast; *Regel* oder *Ablauf* geht an Snotra zurück, das es formuliert und erneut fragt. Dann klick *Merken*. Die Karte fragt in jedem Modus, auch in *Auto*, und jeden Eintrag einzeln.

Ab der nächsten Nachricht gehört der Satz zu dem, was das Modell weiß.

## Wo es aufbewahrt wird

| Ebene | Datei | Gilt für |
| --- | --- | --- |
| Projekt | `.agents/memory.md` im geöffneten Ordner | nur diesen Ordner |
| Global | `~/.snotra/memory.md` in deinem Benutzerordner | jeden Ordner |
| Alle Werkzeuge hier | der Abschnitt *Von Snotra ergänzt* am Ende der `AGENTS.md` | diesen Ordner und jedes Werkzeug, das `AGENTS.md` liest |

Beide sind gewöhnliche Markdown-Dateien: Du kannst sie in jedem Editor lesen und bearbeiten. Das Projektgedächtnis zieht mit dem Ordner um — und es liegt **in deinem Projekt**, kann also in einem Repository landen. Was nur dich betrifft, gehört ins globale Gedächtnis.

## Sehen und ändern, was es behält

*Einstellungen › Gedächtnis* zeigt beide Ebenen mit jedem Eintrag, seinem Datum und ob Snotra ihn sich selbst gemerkt hat.

![Einstellungen › Gedächtnis: der Schalter „Snotra darf sich von selbst etwas merken“, das Projektgedächtnis des Ordners gartenplaner in .agents/memory.md mit drei Einträgen — einer als „selbst gemerkt“ markiert —, jeder mit Papierkorb, und die Zahl der genutzten Zeichen.](screenshots/memory-settings.webp)

- Der Papierkorb neben einem Eintrag löscht ihn.
- *Mitschicken* schaltet eine Ebene ab, ohne sie zu löschen.
- ***Snotra darf sich von selbst etwas merken*** — Snotra behält auch von sich aus, was für später wichtig aussieht, immer mit Freigabe und sichtbar im Tool-Protokoll. Schalte es aus, und Snotra merkt sich nur, worum du bittest.

Änderungen in diesem Bereich wirken sofort.

## Was dann passiert

Das Gedächtnis geht mit jeder Anfrage an den Anbieter, bis zu 8.000 Zeichen pro Ebene; *Einstellungen › Gedächtnis* zeigt, wie viel genutzt ist. Weil ein Repository ein Projektgedächtnis mitbringen kann, liest das Modell es als Notizen, die im Ordner geführt werden, nicht als etwas, das du gesagt hast.

[seit 1.30] Das Projektgedächtnis wird wie die `AGENTS.md` des Projekts geprüft: Ein Gedächtnis, das so klingt, als verschweige es dir etwas, ist in der Aufschlüsselung hinter der Token-Anzeige markiert — siehe [Projektanweisungen](../project-instructions/#anweisungen-aus-einem-ordner-den-du-nicht-geschrieben-hast). Dein persönliches Gedächtnis wird nicht geprüft; es enthält, was du gesagt hast.

Löschen kannst nur du: Das Modell kann dem Gedächtnis etwas hinzufügen, aber nichts daraus entfernen — dafür ist der Papierkorb unter *Einstellungen › Gedächtnis* da.

## Wenn es nicht klappt

- **Speichere nie Passwörter, Schlüssel oder Zugangsdaten.** Das Gedächtnis geht mit jeder Anfrage an den Anbieter. Rutscht doch eines hinein, maskiert Snotra es vor dem Senden.
- **Die Projektebene fehlt.** Es ist kein Ordner geöffnet; öffne einen oder merk es dir global.
- **Ein Eintrag wird als gekürzt angezeigt.** Eine Ebene hat mehr als 8.000 Zeichen; nur der Anfang wird geschickt. Lösch, was nicht mehr gebraucht wird.
