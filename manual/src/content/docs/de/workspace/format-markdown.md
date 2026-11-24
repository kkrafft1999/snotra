---
title: Markdown in der Vorschau bearbeiten
description: Ein Markdown-Dokument dort ändern, wo du es liest — tippen, Text fett oder zur Überschrift machen, eine Liste anfangen — und Snotra schreibt nur zurück, was du geändert hast.
sidebar:
  order: 7
---

[seit 1.33] Eine Notiz, eine `README.md` oder ein Skill liest sich formatiert am besten — und genau dort kannst du sie jetzt ändern. Schalte die Vorschau auf *Bearbeiten*: Das Dokument behält sein Aussehen, unter dem Kopf erscheint eine Leiste für Formate, und Snotra speichert beim Tippen.

![Die mittlere Spalte mit fruchtfolge.md beim Bearbeiten: im Kopf Preview, Quelltext und die gedrückte Schaltfläche Bearbeiten; darunter die Leiste mit Absatz, dann fett, kursiv, durchgestrichen, Code und Link, dann Aufzählung, Nummerierung, Checkliste und Zitat. In der Liste ist das Wort „Nordbeet“ markiert, die Knöpfe für fett und Aufzählung sind gedrückt.](screenshots/format-markdown.webp)

## Was du brauchst

- Einen geöffneten Ordner und eine Markdown-Datei daraus (`.md`, `.markdown`, `.mdx`) in der [Vorschau](../preview/), auf ihrer Seite *Preview*.
- Die Datei ist UTF-8-Text. Das sind heute fast alle Textdateien.
- Keine Chat-Antwort läuft gerade. Solange der Agent arbeitet, ist *Bearbeiten* pausiert.

## Schritte

1. Klick im Baum auf die Datei. Die Vorschau zeigt sie formatiert.
2. Klick im Kopf auf *Bearbeiten*, neben *Preview | Quelltext*. Unter dem Kopf erscheint die Leiste, und die Schreibmarke steht im Text.
3. Tippe, lösche, drück `Enter` für einen neuen Absatz — wie in einer Textverarbeitung. `Shift+Enter` beginnt eine neue Zeile im selben Absatz.
4. Zum Formatieren markierst du den Text oder setzt die Schreibmarke in ein Wort und wählst das Format in der Leiste oder drückst seine Tasten. Von links nach rechts enthält die Leiste das Absatzformat, dann fett, kursiv, durchgestrichen, Code und Link, dann Aufzählung, Nummerierung, Checkliste und Zitat.
5. Zum Aufhören klickst du noch einmal auf *Bearbeiten* oder drückst `Esc`.

Einen Speichern-Knopf gibt es nicht. Snotra speichert eine Sekunde, nachdem du aufgehört hast zu tippen, wenn du das Bearbeiten beendest und wenn du eine andere Datei öffnest. `Cmd+S` / `Strg+S` speichert sofort.

| Format | macOS | Windows / Linux |
| --- | --- | --- |
| Absatz · Überschrift 1 · 2 · 3 | `Option+Cmd+0` · `1` · `2` · `3` | `Strg+Alt+0` · `1` · `2` · `3` |
| Fett | `Cmd+B` | `Strg+B` |
| Kursiv | `Cmd+I` | `Strg+I` |
| Durchgestrichen | `Shift+Cmd+X` | `Strg+Shift+X` |
| Code | `Cmd+E` | `Strg+E` |
| Link | `Cmd+K` | `Strg+K` |
| Aufzählung | `Shift+Cmd+8` | `Strg+Shift+8` |
| Nummerierung | `Shift+Cmd+7` | `Strg+Shift+7` |
| Checkliste | `Shift+Cmd+9` | `Strg+Shift+9` |

Die Tasten richten sich nach der Taste, nicht nach dem Zeichen darauf: `Shift+Cmd+7` funktioniert auch auf einer deutschen Tastatur, auf der `Shift+7` einen Schrägstrich tippt. Ein zweites Mal gedrückt, nimmt ein Knopf sein Format wieder weg.

## Was dann passiert

- **Geschrieben wird nur, was du geändert hast.** Snotra schreibt die Absätze, Überschriften und Listen zurück, die du angefasst hast. Alles andere in der Datei bleibt genau, wie es war: die Leerzeilen, die Schreibweise einer Liste, Kommentare in HTML. Ein geändertes Wort ist ein geänderter Absatz in der Datei, mehr nicht.
- **Die Leiste zeigt das Format an der Schreibmarke:** ein gedrückter Knopf für fett oder eine Liste, und im Menü steht *Absatz* oder *Überschrift 2*. In einer Überschrift ist *Fett* aus — eine Überschrift ist schon fett.
- **Tabellen, Codeblöcke, Bilder und HTML bleiben, wie sie sind.** Die Vorschau könnte sie nicht zurückschreiben, ohne etwas zu verlieren, deshalb lassen sie sich hier nicht bearbeiten. Beim Darüberfahren zeigt ein gestrichelter Rand, wo so ein Teil endet, und sein Tooltip schickt dich zum *Quelltext*. Dort bearbeitest du sie.
- **Kommentare bleiben.** Text, den du in einer [kommentierten Passage](../comment-on-markdown/) änderst, behält seinen Kommentar. Während du bearbeitest, sind die Sprechblasen ausgeblendet; sie kommen zurück, wenn du aufhörst. Löschst du die ganze Passage, geht ihr Kommentar mit.
- **Einfügen bringt den Text, nicht seine Formate.** Was du von einer Webseite oder aus einer anderen App einfügst, kommt als reiner Text an; formatiere ihn mit der Leiste.
- **Rückgängig geht für jeden Schritt:** `Cmd+Z` / `Strg+Z`.
- **Links:** Beim Bearbeiten setzt ein Klick die Schreibmarke in einen Link; `Cmd`-Klick / `Strg`-Klick folgt ihm. Der Link-Knopf oder `Cmd+K` / `Strg+K` öffnet ein kleines Formular für die Adresse — eine Webadresse oder einen Pfad im Ordner. *Link entfernen* nimmt den Link weg und lässt den Text stehen.
- **Vom Text zur Leiste:** `Alt+F10`. Die Pfeiltasten wechseln zwischen ihren Bedienelementen, `Esc` führt zurück in den Text.
- **Speichern, Konflikte und der Agent** funktionieren wie beim [Bearbeiten einer Textdatei](../edit-a-file/): Der Kopf zeigt *Wird gespeichert …* und *Gespeichert*, eine Datei, die ein anderes Programm geändert hat, wird nie still überschrieben, und eine Chat-Antwort, die beginnt, speichert deinen Text und beendet das Bearbeiten.

## Wenn es nicht klappt

- ***Bearbeiten* ist ausgegraut: *Dieses Dokument kannst du nur im Quelltext bearbeiten*.** Etwas darin lässt sich nicht seiner Stelle in der Datei zuordnen — selten, meist HTML, das als mehrere Blöcke erscheint. Wechsle auf *Quelltext* und bearbeite es dort.
- ***Bearbeiten* ist ausgegraut und sagt, dass der Agent arbeitet.** Warte, bis die Chat-Antwort fertig ist, oder halte sie an.
- **Eine Tabelle oder ein Codeblock nimmt die Schreibmarke nicht an.** Das ist Absicht, siehe oben. Wechsle auf *Quelltext*.
- **`Cmd+B` / `Strg+B` blendet die Seitenleiste aus.** Die Taste bedeutet nur fett, solange die Schreibmarke in dem Dokument steht, das du bearbeitest. Überall sonst blendet sie wie immer die Seitenleiste ein oder aus.
- **Ein geänderter Absatz steht anders in der Datei als vorher.** In einem Absatz, den du geändert hast, schreibt Snotra Markdown auf seine Weise: `**` für fett, `*` für kursiv, `-` für eine neue Liste. Eine Liste, die schon da war, behält ihr Zeichen. Absätze, die du nicht angefasst hast, werden nie neu geschrieben.
