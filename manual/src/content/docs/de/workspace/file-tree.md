---
title: Im Dateibaum arbeiten
description: Öffne Dateien, blende versteckte ein, nutze Kontextmenü und Tastatur und lies die Markierungen, die Snotra im Baum hinterlässt.
sidebar:
  order: 2
---

Der Dateibaum links zeigt den geöffneten Ordner so, wie er auf der Platte liegt. Er folgt Änderungen, während sie passieren — eine Datei, die Snotra oder ein anderes Programm schreibt, erscheint sofort.

## Was du brauchst

Einen geöffneten Ordner — siehe [Einen Ordner öffnen](../../getting-started/open-a-folder/).

## Eine Datei öffnen

Klick auf eine Datei, um sie in der mittleren Spalte zu zeigen; klick auf einen Ordner, um ihn auf- oder zuzuklappen. Alles, was sich zeigen lässt — Text, Code, Markdown, Bilder, PDFs, HTML-Seiten —, öffnet sich in der Vorschau: [Eine Datei ansehen](../preview/).

## Versteckte Dateien einblenden

Dateien und Ordner, deren Name mit einem Punkt beginnt — `.github`, `.gitignore`, `.env` —, sind zunächst ausgeblendet. Du blendest sie mit *Versteckte Dateien anzeigen* im `⋯`-Menü oben am Baum ein, mit `Cmd+Shift+.` / `Strg+Shift+.` oder mit *Ansicht › Versteckte Dateien anzeigen*. Sie erscheinen gedimmt an ihrem gewohnten Platz. Die Einstellung gilt für jeden Ordner und bleibt nach einem Neustart erhalten. `.git`, `.DS_Store`, `Thumbs.db` und `desktop.ini` bleiben in jedem Fall draußen.

![Die linke obere Ecke des Fensters mit dem geöffneten ⋯-Menü des Baums: Dateien filtern (⌘P), Neue Datei, Neuer Ordner und Versteckte Dateien anzeigen (⇧⌘.).](screenshots/tree-actions.webp)

## Das Kontextmenü

Klick mit der rechten Maustaste auf eine Zeile — oder mit `Cmd` / `Strg` gedrückt, oder drück `Shift+F10` auf einer fokussierten Zeile —, für das, was du damit tun kannst:

- ***Öffnen*** öffnet die Datei in der App, die dein System dafür nimmt. Bei einem Programm oder Skript — `setup.bat`, einer `.app`, einer ausführbar markierten Datei — heißt Öffnen Ausführen, mit deinen Rechten und außerhalb von Snotras Sandbox, deshalb fragt Snotra vorher, mit *Abbrechen* vorausgewählt.
- ***Im Finder anzeigen*** (*Im Explorer anzeigen* unter Windows, *Im Dateimanager anzeigen* unter Linux).
- ***Informationen*** öffnet ein kleines Fenster zum Eintrag: oben der Name mit Typ und Größe, darunter der vollständige Pfad, dann die Datumsangaben und die App, die *Öffnen* nehmen würde. Der Knopf neben dem Pfad legt ihn in die Zwischenablage; ***Im Finder anzeigen*** unten zeigt den Eintrag in seinem Ordner. Bei einem Ordner zählt es die Einträge direkt darin. `Esc` oder *OK* schließt das Fenster. [seit 1.19]
- ***Neue Datei…***, ***Neuer Ordner…*** und ***Umbenennen…*** — siehe [Anlegen, umbenennen, verschieben und löschen](../manage-files/).
- ***Löschen…*** verschiebt die Datei oder den Ordner in den Papierkorb, nachdem du es bestätigt hast.
- ***Änderungen anzeigen*** und ***Markierung entfernen*** bei Dateien, die Snotra geändert hat — siehe unten.

## Die Tastatur nutzen

Der Baum geht ohne Maus. Klick hinein oder geh mit `Tab` dorthin, dann:

| Tasten | Was sie tun |
| --- | --- |
| `↑` `↓` | Von Zeile zu Zeile |
| `→` | Einen Ordner aufklappen; bei einem offenen zu seinem ersten Eintrag |
| `←` | Einen Ordner zuklappen; bei allem anderen zu dem Ordner, in dem es liegt |
| `Pos1` `Ende` | Erste oder letzte Zeile |
| `Enter` | Die Datei öffnen oder den Ordner auf- oder zuklappen |
| `F2` | Die Zeile umbenennen |
| `Shift+Enter` | Die Zeile als `@pfad` ins Chat-Eingabefeld einfügen |
| `Shift+F10` | Das Kontextmenü öffnen |
| Ein Buchstabe | Den Filter damit starten — siehe [Eine Datei finden](../find-a-file/) |

## Die Markierungen, die Snotra hinterlässt

Während Snotra in einem Chat arbeitet, markiert der Baum am rechten Rand der Zeile, was es angefasst hat: ein gefülltes **M** für eine Datei, die es geändert hat und die du noch nicht angesehen hast, dessen Umriss, sobald du sie angesehen hast, und ein graues **R** für eine Datei, die es nur gelesen hat. Ein geschlossener Ordner trägt die Markierung dessen, was in ihm liegt. Fahr mit der Maus über eine Markierung, damit sie in Worten erklärt wird. Die Markierungen gehören zum Chat; der Radierer oben im Baum entfernt sie. Wohin sie führen, steht unter [Sehen, was Snotra geändert hat](../../chatting/review-changes/).

## Wenn es nicht klappt

- **Ein Ordner endet mit einer Zeile, wie viele Einträge nicht gezeigt werden.** Der Baum listet höchstens 2.000 Einträge pro Ordner. Die übrigen erreichst du über den Filter.
- **Eine Datei öffnet sich nicht in ihrer App.** Auf deinem System ist keine App für diesen Typ eingerichtet; die Meldung sagt das.
