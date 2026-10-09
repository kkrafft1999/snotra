---
title: Eine Datei ansehen
description: Die mittlere Spalte zeigt Markdown formatiert, Code in Farbe, Bilder mit Zoom, PDFs Seite für Seite und HTML-Seiten, wie sie sind — alles offline.
sidebar:
  order: 5
---

Klick im Baum auf eine Datei, und die mittlere Spalte zeigt sie. Jede Art von Datei bekommt ihre eigene Ansicht; der Kopf darüber nennt die Datei und bietet an, was diese Ansicht kann.

## Was du brauchst

Einen geöffneten Ordner. Die Vorschau zeigt nur Dateien aus diesem Ordner.

## Zurück und vor

[seit 1.18] Die Vorschau merkt sich die Dateien, die sie gezeigt hat, wie ein Browser. `‹` und `›` vor dem Dateinamen führen zurück zur vorigen Datei und wieder vor; der Baum wählt die Datei dabei mit aus.

- **Jeder Weg zählt,** der eine Datei in die Vorschau bringt: ein Klick im Baum, *Dateien filtern…*, ein Link in einem Markdown-Dokument, ein Link in einer Chat-Antwort, *Änderungen anzeigen*.
- **Tastenkürzel:** `Cmd+[` und `Cmd+]` unter macOS, `Alt+←` und `Alt+→` unter Windows und Linux — auch unter *Ansicht › Zurück* und *Ansicht › Vor*. Die Seitentasten einer Maus wirken über dem Baum und der mittleren Spalte.
- **Die ganze Liste:** Rechtsklick auf `‹` oder `›` — oder `Shift+F10` darauf — zeigt alle Dateien auf dieser Seite; wähl eine, um direkt dorthin zu springen.
- **Wo du warst:** Zurück landet dort, wo du die Datei verlassen hast — an derselben Scrollposition und in einer Markdown-Datei auf derselben Seite von *Preview | Quelltext*.
- **Ein neuer Schritt schneidet ab, was vor dir lag.** Gehst du zweimal zurück und öffnest eine andere Datei, liegen die Dateien, von denen du zurückgegangen bist, nicht mehr vor dir.
- Die Liste gehört zum geöffneten Ordner. Ein Ordnerwechsel oder ein Neustart von Snotra beginnt sie leer.

## Markdown

Eine `.md`-Datei öffnet sich formatiert: Überschriften, Listen, Tabellen, Code. *Preview | Quelltext* im Kopf — oder `Cmd+Shift+M` / `Strg+Shift+M`, oder *Ansicht › Preview oder Quelltext* — wechselt zum reinen Text und zurück. Das Front Matter einer `SKILL.md` steht als kompakter Block über dem Text.

- Bilder aus dem geöffneten Ordner werden gezeigt. Bilder aus dem Netz werden nie geladen: Ein Platzhalter, *Bild aus dem Netz, nicht geladen*, sagt, wohin sie zeigen.
- Ein Link auf eine andere Datei des Ordners öffnet diese Datei und wählt sie im Baum aus. `‹` bringt dich zurück dorthin, wo du ihm gefolgt bist.
- [seit 1.19] Zoomen kannst du mit `−` und `+` im Kopf, oder mit `Cmd` / `Strg` und `+`, `−`, `0`, während die Vorschau den Fokus hat. Es wächst das ganze Dokument — Text, Bilder und Tabellen —, und jede Markdown-Datei öffnet sich in der Größe, die du zuletzt gewählt hast, auch nach einem Neustart. Der Quelltext wird nicht gezoomt.

## Code und Text

Quellcode und Konfigurationsdateien öffnen sich in Farbe — JavaScript und TypeScript, JSON, YAML, Python, Shell-Skripte, HTML und CSS und viele mehr, gewählt nach dem Dateinamen. Die Farben folgen dem hellen und dunklen Erscheinungsbild. Was du markierst und kopierst, ist die Datei genau so, wie sie ist.

![Die mittlere Spalte mit src/kalender.js: der Code mit Schlüsselwörtern, Zeichenketten, Kommentaren und Funktionsnamen in eigenen Farben, im Kopf die Dateigröße.](screenshots/code-preview.webp)

Reiner Text und Logs bleiben schlicht. Eine Datei über 512 KB erscheint ohne Farben, damit sie sofort aufgeht.

## Bilder

PNG, JPEG, GIF, WebP und SVG öffnen sich als Bild, eingepasst in die Spalte.

![Die mittlere Spalte mit gartenplan.png: im Kopf der Zoom mit −, 40 % und +, der Knopf Einpassen, die Dateigröße und die Größe in Pixeln; darunter das Bild.](screenshots/image-preview.webp)

- Zoomen kannst du mit `−`, `+` und *Einpassen* im Kopf, oder mit `Cmd` / `Strg` und `+`, `−`, `0`.
- Ein Bild, das größer ist als die Spalte, verschiebst du durch Ziehen oder mit den Pfeiltasten.
- Der Kopf nennt die Größe in Pixeln; ein Schachbrett hinter dem Bild zeigt, wo es durchsichtig ist.
- Ein SVG hat *Preview | Quelltext* wie eine Markdown-Datei.

## PDF

Eine PDF öffnet sich Seite für Seite, eingepasst in die Spaltenbreite. Der Kopf zeigt die Seite, auf der du bist — tipp eine Zahl, um dorthin zu springen —, und zoomt mit `−`, `+` und *Breite*. Eine passwortgeschützte PDF fragt direkt dort nach ihrem Passwort; es wird nicht gespeichert. Skripte in einer PDF laufen nie, und ihre Links tun nichts.

## HTML-Seiten

Eine `.html`-Datei öffnet sich als die Seite, die sie ist. Skripte laufen, ein interaktiver Entwurf oder ein Bericht funktioniert also wie im Browser. *Preview | Quelltext* wechselt zum Text.

![Die mittlere Spalte mit aussaatkalender.html: im Kopf Preview und Quelltext, Neu laden, Im Browser öffnen und die Größe; darunter der Hinweis, dass eine Anfrage blockiert wurde, weil die Vorschau offline bleibt und nur Dateien aus dem geöffneten Ordner lädt, mit dem Knopf Anzeigen, und die Seite — ein Aussaatkalender als Tabelle.](screenshots/html-preview.webp)

- **Sie bleibt offline.** Die Seite lädt nur Dateien aus dem geöffneten Ordner — ein Stylesheet oder Skript daneben funktioniert. Alles aus dem Netz oder von außerhalb des Ordners wird blockiert, und ein Hinweis über der Seite sagt, wie viel; *Anzeigen* listet es auf.
- **Links brauchen einen Klick.** Ein Link auf eine andere HTML-Datei des Ordners öffnet sie in der Vorschau, ein Weblink öffnet sich in deinem Browser — nur wenn du ihn anklickst, nie von selbst.
- **Sie bleibt aktuell.** Die Seite lädt neu, wenn sie oder eine ihrer Dateien sich ändert. *Neu laden* und *Im Browser öffnen* stehen im Kopf.
- **Tastatur:** `Tab` geht in die Seite hinein, `F6` wieder heraus.

Ein Link auf eine HTML-Datei in einer Chat-Antwort öffnet sie ebenfalls hier.

## Wenn es nicht klappt

- ***Zu groß für die Vorschau.*** Die Vorschau zeigt Bilder bis 10 MB, PDFs bis 50 MB und HTML-Dateien bis 1 MB. *Im Browser öffnen* geht bei einer HTML-Datei trotzdem; jede Datei öffnet sich über das Kontextmenü des Baums in ihrer eigenen App.
- **Die Datei zeigt über einen Link aus dem geöffneten Ordner hinaus** und wird deshalb nicht gezeigt. Die Vorschau zeigt nichts von außerhalb des Ordners.
- ***Kein lesbares Bild* oder *Keine PDF*.** Der Inhalt passt nicht zum Dateinamen. Die Ansicht prüft, was drinsteht, nicht die Endung.
- ***Die Seite reagiert nicht.*** Ein Skript der Seite hält sie beschäftigt. Snotra bleibt bedienbar; *Neu laden* startet die Seite neu.
- **`‹` überspringt eine Datei, oder die Liste zeigt sie ausgegraut.** Die Datei wurde gelöscht oder außerhalb von Snotra verschoben, seit du sie angesehen hast. Eine Datei, die du im Baum umbenennst oder verschiebst, bleibt unter ihrem neuen Namen in der Liste.
- **`Cmd` / `Strg` und `+` vergrößert das ganze Fenster statt des Dokuments.** Die Tasten zoomen das Dokument nur, während die Vorschau den Fokus hat — klick zuerst in den Text. *Ansicht › Zoom zurücksetzen* stellt das Fenster wieder her.
