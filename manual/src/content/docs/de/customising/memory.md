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

[seit 1.30] **Was Snotra behält, und wie.** Snotra sortiert nach zwei Fragen. *Was ist es?* Was nur gerade gilt oder einmal passiert ist — *der Test schlägt fehl*, *heute haben wir den Login repariert* — wird nicht behalten: Der Chat hat es schon. Schritte zu einem Ziel werden ein [Skill](../write-a-skill/), was man befolgen oder brechen kann, eine [Regel](../rules/), und was wahr oder falsch ist, ein Fakt im Gedächtnis. *Wer liest es?* Nur du, Snotra in diesem Ordner oder alle Werkzeuge hier. Wirkt ein Eintrag falsch einsortiert, sagt die Karte das in einem Hinweis — Snotra lehnt ihn nie wegen seiner Art ab; du entscheidest.

Zum Aufräumen bitte *überprüf mein Gedächtnis*: Snotra geht Gedächtnis und Regeldateien durch und schlägt eine Änderung nach der anderen vor — einen Fakt, der eine Regel ist, verschieben, Doppeltes zusammenführen, Veraltetes streichen —, jede auf ihrer eigenen Karte.

## Mitnehmen, was von einem Chat bleibt

[seit 1.30] In einem Chat kommt oft etwas auf, das sich zu behalten lohnt: ein Fakt, der zur Sprache kam, eine Korrektur, die beim nächsten Mal gelten soll, ein Vorgehen, das funktioniert hat. Der Chat selbst wird nicht als Wissen behalten, also bitte Snotra, es herauszuziehen.

1. Frag am Ende des Chats: *Was nehmen wir daraus mit?* oder *Was bleibt aus diesem Chat?*
2. Snotra geht den Chat durch und schlägt **einen Eintrag nach dem anderen** vor, jeden auf seiner eigenen Karte mit seiner Art und mit dem, wer ihn liest — genau wie wenn du es bittest, sich etwas zu merken.
3. Ändere auf der Karte die Art oder den Leser, wenn er falsch einsortiert ist, und klick dann *Merken* — oder *Ablehnen*, um ihn wegzulassen. Der nächste Vorschlag kommt erst nach deiner Antwort.

Was nur in diesem Chat passiert ist — *heute schlägt der Test fehl* — wird nicht vorgeschlagen: Der Chat hat es schon. Bleibt nichts, sagt Snotra das. Weil du darum gebeten hast, geht das auch, wenn *Snotra darf sich von selbst etwas merken* ausgeschaltet ist. Snotra bietet das Herausziehen nie von sich aus an; es beginnt, wenn du fragst.

## Wo es aufbewahrt wird

| Ebene | Datei | Gilt für |
| --- | --- | --- |
| Projekt | `.agents/memory.md` im geöffneten Ordner | nur diesen Ordner |
| Global | `~/.snotra/memory.md` in deinem Benutzerordner | jeden Ordner |
| Alle Werkzeuge hier | der Abschnitt *Von Snotra ergänzt* am Ende der `AGENTS.md` | diesen Ordner und jedes Werkzeug, das `AGENTS.md` liest |

Beide sind gewöhnliche Markdown-Dateien: Du kannst sie in jedem Editor lesen und bearbeiten. Das Projektgedächtnis zieht mit dem Ordner um — und es liegt **in deinem Projekt**, kann also in einem Repository landen. Was nur dich betrifft, gehört ins globale Gedächtnis.

## Sehen und ändern, was es behält

*Einstellungen › Wissen* zeigt beide Ebenen mit jedem Eintrag, seinem Datum und ob Snotra ihn sich selbst gemerkt hat.

![Einstellungen › Wissen › Fakten: der Schalter „Snotra darf sich von selbst etwas merken“, das Projektgedächtnis des Ordners gartenplaner in .agents/memory.md mit drei Einträgen — einer als „selbst gemerkt“ markiert —, jeder mit Papierkorb, und die Zahl der genutzten Zeichen.](screenshots/memory-settings.webp)

- Der Papierkorb neben einem Eintrag löscht ihn.
- *Mitschicken* schaltet eine Ebene ab, ohne sie zu löschen.
- ***Snotra darf sich von selbst etwas merken*** — Snotra behält auch von sich aus, was für später wichtig aussieht, immer mit Freigabe und sichtbar im Tool-Protokoll. Schalte es aus, und Snotra merkt sich nur, worum du bittest.

Änderungen in diesem Bereich wirken sofort.

### Hinweise an Einträgen

[seit 1.30] *Einstellungen › Wissen* weist auf Einträge hin, die einen Blick brauchen könnten — ohne ein Modell zu fragen und ohne von sich aus etwas zu ändern. Ein Hinweis steht unter seinem Eintrag, mit dem, was du damit tun kannst:

![Einstellungen › Wissen › Fakten: unter dem Eintrag „Immer wenn du die Beete gießt, nimm zuerst die Regentonne“ der Hinweis „Liest sich wie eine Regel“ mit In Regeln verschieben… und Ausblenden; unter „Heute ist das Südbeet überflutet“ der Hinweis „Liest sich wie eine Episode“ mit Entfernen, Ausblenden und +1 weitere.](screenshots/memory-hints.webp)

| Hinweis | Was du tun kannst |
| --- | --- |
| *Liest sich wie eine Regel* — *immer*, *nie*, *immer wenn*, *muss* … | *In Regeln verschieben…* fragt nach Ebene und Regeldatei, schreibt die Regel dorthin und nimmt den Eintrag aus dem Gedächtnis. Siehe [Snotra Regeln geben](../rules/). |
| *Liest sich wie ein Ablauf* — Schritte, *zuerst … dann …* | *Skill erstellen…* fragt nach dem Namen des Skills und wofür er da ist, schreibt ihn nach `.agents/skills/` (beim globalen Gedächtnis nach `~/.snotra/skills/`) und nimmt den Eintrag aus dem Gedächtnis. Einen vorhandenen Skill gleichen Namens überschreibt er nie. |
| *Liest sich wie eine Episode* — *heute*, *gerade*, etwas, das einmal passiert ist | *Entfernen*. Eine Begründung (*weil …*) oder eine Entscheidung zählt nicht als Episode. |
| *Fast derselbe Eintrag wie …* — mindestens 80 % gleiche Wörter, im Gedächtnis oder in einer Regeldatei derselben Ebene; oder *steht auch global* | *Entfernen* oder *Bearbeiten*, das die Datei in deinem Editor öffnet. |
| *Notiert am … — stimmt das noch?* — älter als 180 Tage | *Entfernen* oder *Bearbeiten*. Ein Eintrag ohne Datum bekommt diesen Hinweis nie. |
| *Fast voll* — 80 % der 8.000 Zeichen einer Ebene belegt | Bitte Snotra im Chat: *sieh mein Gedächtnis durch*. |

Die Hinweise kennen jede Sprache, die Snotra spricht, egal in welcher Sprache die Oberfläche läuft. Hat ein Eintrag mehrere Hinweise, steht der erste da, und *+1 weitere* klappt die übrigen auf. *Ausblenden* blendet einen Hinweis für diesen Eintrag dauerhaft aus; er kommt erst wieder, wenn sich die Wörter des Eintrags ändern. Was ein Hinweis ändert, steht unter *Letzte Änderungen*, mit *Rückgängig*.

## Was dann passiert

Das Gedächtnis geht mit jeder Anfrage an den Anbieter, bis zu 8.000 Zeichen pro Ebene; *Einstellungen › Wissen* zeigt, wie viel genutzt ist. Weil ein Repository ein Projektgedächtnis mitbringen kann, liest das Modell es als Notizen, die im Ordner geführt werden, nicht als etwas, das du gesagt hast.

[seit 1.30] Das Projektgedächtnis wird wie die `AGENTS.md` des Projekts geprüft: Ein Gedächtnis, das so klingt, als verschweige es dir etwas, ist in der Aufschlüsselung hinter der Token-Anzeige markiert — siehe [Projektanweisungen](../project-instructions/#anweisungen-aus-einem-ordner-den-du-nicht-geschrieben-hast). Dein persönliches Gedächtnis wird nicht geprüft; es enthält, was du gesagt hast.

Löschen kannst nur du: Das Modell kann dem Gedächtnis etwas hinzufügen, aber nichts daraus entfernen — dafür ist der Papierkorb unter *Einstellungen › Wissen* da.

## Wenn es nicht klappt

- **Speichere nie Passwörter, Schlüssel oder Zugangsdaten.** Das Gedächtnis geht mit jeder Anfrage an den Anbieter. Rutscht doch eines hinein, maskiert Snotra es vor dem Senden.
- **Die Projektebene fehlt.** Es ist kein Ordner geöffnet; öffne einen oder merk es dir global.
- **Ein Eintrag wird als gekürzt angezeigt.** Eine Ebene hat mehr als 8.000 Zeichen; nur der Anfang wird geschickt. Lösch, was nicht mehr gebraucht wird.
