---
title: Sehen und ändern, was Snotra darf
description: Einstellungen › Tools & Sicherheit zeigt für den geöffneten Ordner, welche Tools Snotra hat, wann es fragt und wo es handeln darf — und lässt dich das ändern.
sidebar:
  order: 4
---

Eine Seite in den Einstellungen zeigt alles, was im geöffneten Ordner über einen Tool-Aufruf entscheidet: welche Tools Snotra hat, ob es vorher fragt und wo oder was genau es anfassen darf. Sie wird aus denselben Regeln berechnet, die jeden Aufruf entscheiden, kann also nichts anderes zeigen als das, was passiert.

## Die Seite öffnen

Öffne die Einstellungen — auf macOS *Snotra Agent › Einstellungen…*, auf Windows und Linux *Ansicht › Einstellungen…*, oder mit `Cmd+,` / `Strg+,` — und wähle *Tools & Sicherheit*. Auch der Link unten im Modus-Menü des Chats führt dorthin.

![Einstellungen › Tools & Sicherheit für den Ordner gartenplaner: oben der Standardmodus Intelligent und eine Zusammenfassung — liest ohne Rückfrage, fragt vor jeder Dateiänderung, fragt vor jedem Befehl (in der Sandbox), fragt, bevor Web oder MCP genutzt werden. Darunter die Zeilen Lesen (Läuft), Sensible Daten lesen, Ändern und Überschreiben ohne Rückweg (jeweils Fragt).](screenshots/tools-and-security.webp)

## Was sie zeigt

- **Oben** den Ordner, für den sie gilt, seinen *Standardmodus* und einen Satz, der zusammenfasst, was Snotra dort tut. Wie der Standardmodus funktioniert, steht unter [Einen Modus wählen](../choose-a-mode/#einem-ordner-einen-standardmodus-geben).
- **Sechs Zeilen**, eine pro Risikoklasse — *Lesen*, *Sensible Daten lesen*, *Ändern*, *Überschreiben ohne Rückweg*, *Ausführen*, *Externe Dienste*. Jede sagt, wie viele Tools sie hat, warum sie sich so verhält und ob ihre Aufrufe *Läuft*, *Fragt* oder *Aus* sind.
- **Eine aufgeklappte Zeile** beantwortet drei Fragen: Darf Snotra das (die Tools, jedes mit seinem Schalter)? Fragt es vorher (der Modus, deine Freigaben, gemerkte Befehle, Sitzungsfreigaben)? Und wo oder was genau (die Ordner, die sensiblen Muster, die Sandbox, deine Sperren, was deinen Rechner verlässt)?
- **Unten** die *Sitzungsfreigaben*, die noch gelten, und die beiden Wege zum Zurücksetzen.

Alles auf dieser Seite wirkt sofort. Was den Schutz lockert, bestätigst du vorher in einem Dialog des Betriebssystems.

## Ein Tool ein- oder ausschalten

Klapp die Zeile auf und nutze den Schalter des Tools. Zwei Tools sind aus, bis du sie einschaltest, beide in der Zeile *Ausführen*: *Shell-Befehle erlauben* und *Python-Ausführung erlauben*. Lies vorher, was sie können: [Befehle in der Sandbox ausführen](../sandbox/).

## Etwas sperren

1. Klapp die Zeile auf, zum Beispiel *Ändern*, und klick auf *Sperre anlegen…*. Das Formular öffnet sich an Ort und Stelle, mit der Risikoklasse schon ausgewählt.
2. Wähle, ob die Sperre für *Dieser Workspace* oder *Alle Workspaces* gilt und ob sie ein *Einzelnes Tool* oder die ganze *Risikoklasse* erfasst.
3. Gib ein *Pfadmuster* ein: `*` bleibt innerhalb eines Ordners, `**` geht auch durch Unterordner. `docs/**` erfasst alles unter `docs`.
4. Klick auf *Regel anlegen*.

Eine Sperre gewinnt immer, in jedem Modus, auch in *Auto*. Sie wieder zu löschen, bestätigst du in einem Systemdialog.

## Etwas dauerhaft erlauben

In den Zeilen *Lesen* und *Ändern* öffnet *Dauerhaft erlauben…* dasselbe Formular für eine Erlaubnis: Passende Aufrufe fragen dann in *Intelligent* nicht mehr nach. Das Betriebssystem lässt dich das mit *Erlaubnis anlegen* bestätigen. Alles andere — sensible Dateien, Überschreiben ohne Rückweg, Befehle, externe Dienste — lässt sich nur pro Aufruf erlauben oder, wo die Karte es anbietet, für eine Sitzung. Einen einzelnen Befehl merkst du dir stattdessen von seiner Karte aus: siehe [Auf eine Freigabe-Anfrage antworten](../approve-a-request/).

## Weitere Dateien als sensibel markieren

Die Zeile *Sensible Daten lesen* listet die eingebauten Muster — `.env*`, `*.pem`, `*.key`, `id_*`, `credentials*`, `secrets*`, `*.p12`, `*.pfx`, `.netrc`, `.npmrc`, `.pypirc` und die Ordner `.ssh/`, `.aws/`, `.gnupg/`, `.kube/`. Unter *Deine eigenen Muster* tippst du ein Muster wie `privat/**` in *Neues sensibles Pfadmuster* und klickst auf *Hinzufügen*. Eines deiner Muster zu entfernen, fragt in einem Systemdialog nach, weil die erfassten Dateien danach ohne Rückfrage beim Modell landen können.

## Eine Freigabe widerrufen oder zurücksetzen

- ***Sitzungsfreigaben*** listet jedes *Für diese Sitzung erlauben*, das noch gilt, nach Chat gruppiert, mit dem, was es umfasst, und wann du es gegeben hast. Widerruf sie einzeln oder mit *Alle widerrufen*.
- ***Workspace-Regeln zurücksetzen*** löscht die Sperren und Erlaubnisse nur des geöffneten Ordners, schaltet seine Sandbox wieder ein und setzt seinen Standardmodus zurück auf *Intelligent*.
- ***Alle Berechtigungen zurücksetzen*** löscht jede Regel, deine eigenen sensiblen Muster, jede Freigabe pro Programm und jede Sitzungsfreigabe, schaltet die Sandbox überall wieder ein und stellt *Intelligent* wieder her, auch als Standard jedes Ordners. Das fragt immer in einem Systemdialog nach, der aufzählt, welcher Schutz dabei wegfällt.

## Wenn es nicht klappt

- **Die Seite sagt *Kein Workspace offen*.** Sie zeigt dann, was in jedem Ordner gilt, bis du einen öffnest. Regeln für *Dieser Workspace* brauchen einen geöffneten Ordner.
- **Eine Zeile steht auf *Aus*.** Kein Tool dieser Art ist eingeschaltet, oder eine Sperre erfasst jeden Pfad.
- **Die Seite meldet, die Berechtigungsdatei sei beschädigt oder verändert.** Snotra läuft dann in *Intelligent*, oder in *Immer fragen*, wenn das eingestellt war; Erlaubnisse werden verworfen, Sperren bleiben in Kraft. Richte ein, was du brauchst, neu ein.
