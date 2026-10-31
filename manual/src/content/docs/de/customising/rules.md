---
title: Snotra Regeln geben
description: Schreib Regeldateien — „wenn das passiert, mach das" —, an die sich Snotra in diesem Projekt oder überall hält, immer oder wenn sie greifen.
sidebar:
  order: 4.5
---

[seit 1.30] Eine Regel sagt, was in einer Situation zu tun ist: *Wenn du eine Commit-Nachricht schreibst, schreib sie auf Englisch.* Snotra hält Regeln in **Regeldateien** fest — kleinen Markdown-Dateien, die es mit jeder Nachricht liest und befolgt, sobald die Situation eintritt, in diesem Projekt oder in jedem Ordner.

Eine Tatsache gehört ins [Gedächtnis](../memory/), ein Ablauf Schritt für Schritt in einen [Skill](../write-a-skill/). Eine Regel liegt dazwischen: Sie ist nichts, was stimmt, und keine ganze Aufgabe — sie ist eine Bedingung und was dann zu tun ist.

## Was du brauchst

Einen Texteditor. Für Regeln eines Projekts einen geöffneten Ordner.

## Schritte

1. Leg einen Ordner `rules` an und darin eine Datei, deren Name der Name der Regel ist — Kleinbuchstaben, Ziffern und Bindestriche, mit der Endung `.md`:
   - für dieses Projekt: `.agents/rules/commit-messages.md` im geöffneten Ordner,
   - für jeden Ordner: `~/.snotra/rules/commit-messages.md` in deinem Benutzerordner.
2. Schreib oben hin, wann die Regel greift, und darunter die Regel:

   ```markdown
   ---
   description: Wenn du eine Commit-Nachricht schreibst
   ---

   - Schreib sie auf Englisch, im Imperativ.
   - Verknüpf das Issue mit „Closes #…".
   ```

3. Für eine Regel, deren Bedingung immer gilt — *wenn du mir antwortest, antworte auf Deutsch* —, ergänze `always: true` unter der Beschreibung.

Ab der nächsten Nachricht gilt die Regel.

Du musst die Datei nicht selbst schreiben: Bitte Snotra, sich eine Regel zu merken — *merk dir: wenn du eine Commit-Nachricht schreibst, schreib sie auf Englisch* —, und es schlägt die Regeldatei, ihre Beschreibung und ob sie immer gilt auf einer Karte vor, die du freigibst. Siehe [Snotra etwas merken lassen](../memory/).

## Was dann passiert

- Eine Regel mit `always: true` geht mit jeder Nachricht vollständig mit.
- Jede andere Regel geht als eine Zeile mit: ihr Name und ihre Beschreibung. Kommt Snotra an einen Schritt, auf den die Beschreibung passt, holt es die Regel und befolgt sie — vor diesem Schritt, nicht nur zu Beginn. Der Chat zeigt dann *Regel commit-messages (Projekt)*.
- Eine Datei ohne Beschreibung zählt trotzdem: Snotra nimmt ihre erste Überschrift oder ihre erste Zeile als Beschreibung. Eine Beschreibung, die sagt, *wann*, wirkt besser als eine, die sagt, *was*.
- Jeder Listenpunkt ist eine Regel. Ein Datum am Zeilenanfang — `- 2026-10-31 — …` — sagt, wie alt sie ist.
- Regeldateien werden auch aus `~/.agents/rules/` gelesen, wo andere Werkzeuge ihre ablegen. Eine gleichnamige Datei in `~/.snotra/rules/` hat Vorrang.

### Wenn sich Regeln widersprechen

Was du im Chat sagst, geht jeder Regel vor. Zwischen zwei Regeln gewinnt die mit der genaueren Bedingung, dann die neuere. Sagen eine Regel des Projekts und eine deiner eigenen in derselben Situation Verschiedenes, sagt Snotra dir das und fragt — es sucht sich nicht still eine aus. Die Regeln eines Projekts können mit einem geklonten Repository kommen; sie wiegen nie mehr als das, was du sagst.

## Grenzen

| Was | Grenze |
| --- | --- |
| Dateien je Ordner | 50; weitere werden nicht gelesen |
| Name | 64 Zeichen: `a–z`, `0–9`, `-` |
| Beschreibung | 200 Zeichen |
| Eine Regeldatei | 20.000 Zeichen; eine längere wird sichtbar gekürzt |
| Alle `always`-Regeln einer Ebene | 8.000 Zeichen; die neueste Datei darüber wird stattdessen geholt, wenn sie greift |

Gedächtnis, `always`-Regeln, `AGENTS.md` und die Liste der Regeln nehmen zusammen höchstens ein Viertel des Platzes ein, den eine Anfrage hat. Brauchen sie mehr, zeigt die Liste der Regeln zuerst nur noch Namen, dann werden die `always`-Regeln des Projekts erst geholt, wenn sie greifen, dann wird `AGENTS.md` gekürzt, und zuletzt werden deine eigenen `always`-Regeln erst geholt, wenn sie greifen. Dein Gedächtnis geht immer vollständig mit. Die Aufschlüsselung hinter der Token-Anzeige im Eingabefeld zeigt jeden Schritt — siehe [Eine Nachricht schreiben](../../chatting/write-a-message/#sehen-was-eine-anfrage-kostet).

## Wenn es nicht klappt

- **Snotra beachtet die Datei nicht.** Prüf ihren Namen: Kleinbuchstaben, keine Leerzeichen, Endung `.md`, direkt im Ordner `rules`. Dateien in Unterordnern werden nicht gelesen.
- **Snotra befolgt eine Regel auf Abruf nicht.** Lass die Beschreibung die Situation nennen: *Wenn du einen Pull Request öffnest* statt *Pull Requests*.
- **Die Regeln eines Projekts überraschen dich.** Ein Ordner, den du nicht geschrieben hast, kann eigene Regeln mitbringen, wie seine `AGENTS.md`. Snotra prüft sie auf Anzeichen, dass sie dir etwas verschweigen, und markiert eine solche Datei in der Aufschlüsselung — siehe [Projektanweisungen](../project-instructions/#anweisungen-aus-einem-ordner-den-du-nicht-geschrieben-hast).
