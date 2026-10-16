---
title: Eine Textdatei bearbeiten
description: Einen Tippfehler korrigieren oder einen Wert ändern, direkt in der Vorschau — Snotra speichert beim Tippen und überschreibt nie, was jemand anderes geändert hat.
sidebar:
  order: 6
---

[seit 1.24] Für eine kleine Korrektur — einen Tippfehler in einer Notiz, einen Wert in einer Konfigurationsdatei — brauchst du keinen anderen Editor. Schalte die Vorschau auf *Bearbeiten*, tippe, und Snotra speichert die Datei von selbst.

![Die mittlere Spalte mit beete.json im Editor: im Kopf die gedrückte Schaltfläche Bearbeiten und der Stand Gespeichert; darunter der JSON-Text, in dem das Nordbeet jetzt 350 cm lang ist.](screenshots/edit-file.webp)

## Was du brauchst

- Einen geöffneten Ordner und eine Textdatei daraus in der [Vorschau](../preview/): Quellcode, eine Konfigurationsdatei, reinen Text oder eine Markdown-Datei auf ihrer Seite *Quelltext*.
- Die Datei ist UTF-8-Text. Das sind heute fast alle Textdateien.
- Keine Chat-Antwort läuft gerade. Solange der Agent arbeitet, ist *Bearbeiten* pausiert — siehe unten.

## Schritte

1. Klick im Baum auf die Datei. Die Vorschau zeigt sie, wie immer nur zum Lesen.
2. Klick im Kopf auf *Bearbeiten*. Bei einer Markdown-Datei wechselst du zuerst auf *Quelltext*; *Bearbeiten* steht neben *Preview | Quelltext*.
3. Tippe. Der Text bleibt an seinem Platz, beim Bearbeiten ohne Farben.
4. Zum Aufhören klickst du noch einmal auf *Bearbeiten* oder drückst `Esc`. Die Farben kommen zurück.

Einen Speichern-Knopf gibt es nicht. Snotra speichert eine Sekunde, nachdem du aufgehört hast zu tippen, wenn du woandershin klickst, wenn du den Editor verlässt und wenn du eine andere Datei öffnest. `Cmd+S` / `Strg+S` speichert sofort, wenn du sichergehen willst.

## Was dann passiert

- **Der Kopf sagt, wie es steht:** *Wird gespeichert …*, während geschrieben wird, *Gespeichert*, sobald die Datei auf dem Datenträger dein Text ist, *Nicht gespeichert*, wenn etwas im Weg steht — dann sagt eine Leiste über dem Text, was.
- **Rückgängig geht wie in jedem Textfeld:** `Cmd+Z` / `Strg+Z` oder *Bearbeiten › Rückgängig*; *Bearbeiten › Wiederholen* holt es zurück.
- **Zeilenenden bleiben, wie sie waren.** Eine Datei mit Windows-Zeilenenden wird wieder mit ihnen gespeichert.
- **`Tab` bewegt den Fokus weiter**, wie überall in Snotra. Zum Einrücken tippst du Leerzeichen.
- **Nichts wird stillschweigend überschrieben.** Vor jedem Speichern prüft Snotra, ob die Datei auf dem Datenträger noch die ist, mit der du angefangen hast. Hat ein anderes Programm sie inzwischen geändert, bietet die Leiste *Meine Version behalten* oder *Version auf dem Datenträger übernehmen* an. Geht nichts von dem verloren, was du getippt hast, zeigt Snotra einfach die neue Fassung.
- **Der Agent und du schreibt nie gleichzeitig.** Beginnt eine Chat-Antwort, speichert Snotra, was du getippt hast, schließt den Editor und pausiert *Bearbeiten*, bis die Antwort fertig ist. Halt den Zeiger über die Schaltfläche, dann steht da, warum.
- Gespeichert wird in einem Schritt: Ein Absturz mittendrin hinterlässt entweder die alte oder die neue Fassung, nie halb und halb. Eine Kopie im Papierkorb gibt es nicht — anders als bei den Änderungen des Agenten, die du unter *Änderungen anzeigen* siehst.

## Wenn es nicht klappt

- ***Bearbeiten* ist ausgegraut und sagt, dass der Agent arbeitet.** Warte, bis die Chat-Antwort fertig ist, oder halte sie an.
- ***Bearbeiten* ist ausgegraut: *kein UTF-8-Text*.** Die Datei hat eine andere Kodierung. Snotra zeigt sie mit Platzhalterzeichen und würde zerstören, was es nicht anzeigen kann, deshalb bearbeitet es sie nicht. Öffne sie über das Kontextmenü des Baums in ihrem eigenen Programm.
- ***Deine Änderungen konnten nicht gespeichert werden*.** Die Leiste nennt den Grund — keine Berechtigung, die Datei zu schreiben, die Datei ist größer als 2 MB, sie liegt in einem Ordner, in den Snotra nicht schreibt. *Erneut versuchen*, sobald die Ursache weg ist, oder *Meine Änderungen verwerfen*. Dein Text bleibt im Editor, bis du entscheidest; eine andere Datei öffnet sich nicht darüber.
- ***Ein anderes Programm hat die Datei geändert*.** Etwas anderes hat die Datei geschrieben, während du getippt hast. *Meine Version behalten* schreibt deine darüber; *Version auf dem Datenträger übernehmen* verwirft deine und macht mit der anderen weiter.
- ***Die Datei wurde gelöscht*.** *Meine Version behalten* schreibt sie wieder; *Meine Änderungen verwerfen* schließt sie.
- **Bilder, PDFs, HTML-Seiten und der Quelltext einer SVG lassen sich hier nicht bearbeiten.** Nur Textdateien und Markdown auf der Seite *Quelltext*.
