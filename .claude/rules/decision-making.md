# Entscheidungs-Workflow: Vorschlagen statt sofort umsetzen

Konvention vom 2026-07-01 (siehe Konversation zu PR #16).

Wenn der Nutzer eine **Frage stellt** oder ein **Problem beschreibt** ("Wir
brauchen sowas wie …", "Was empfiehlst du?", "Wie sollten wir X lösen?"),
dann:

1. **Nicht sofort umsetzen.** Erst den Sachverhalt/Code kurz analysieren
   (Codebase-Kontext, bestehende Struktur, Constraints).
2. **Mehrere Optionen vorschlagen** — jeweils mit kurzer Einordnung
   (Vor-/Nachteile, Aufwand, Passung zum Projekt). Eine eigene Empfehlung
   ist erlaubt und sinnvoll, aber klar als Empfehlung markieren, nicht als
   Vorwegnahme der Entscheidung.
3. **Auf explizite Entscheidung warten.** Erst wenn der Nutzer eine Option
   auswählt oder ausdrücklich "setz das um" / "mach das" o. ä. sagt, wird
   tatsächlich Code geschrieben, committet, gepusht oder ein PR erstellt.
4. Falls während der Analyse schon Änderungen begonnen wurden (z. B. Dateien
   angelegt), aber der Nutzer stoppt, bevor er entschieden hat: Änderungen
   **zurücksetzen** (nicht committen/pushen) und die Optionen liefern.

## Wann direkt gehandelt werden darf (Ausnahmen)

- Der Nutzer gibt eine **klare Umsetzungsanweisung** ("Setze Option 1+2 um",
  "Baue Feature X", "Fixe Bug Y") — dann direkt implementieren, ohne erneut
  nachzufragen, ob das gewünscht ist.
- Reine **Informationsfragen ohne Entscheidungscharakter** ("Wo ist Datei X
  definiert?", "Was macht Funktion Y?") — hier ist keine Optionenliste
  nötig, eine direkte Antwort reicht.
- **Debugging/Analyse-Anfragen**, bei denen der Nutzer explizit um eine
  Ursachenanalyse statt um eine Lösung bittet.

## Nicht verwechseln mit Aufgabenerfassung

Diese Regel betrifft *Entscheidungsfindung im Gespräch*. Die Konvention, wo
Aufgaben/Tasks landen (GitHub Issues, `docs/roadmap.md`), steht separat in
[`task-management.md`](./task-management.md).
