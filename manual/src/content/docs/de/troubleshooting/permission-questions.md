---
title: Fragen zu Freigaben
description: Kurze Antworten auf das, was bei Freigaben am meisten verwundert — warum Snotra noch einmal fragt, warum es nicht fragt, warum ein Aufruf ohne Karte abgelehnt wird —, jeweils mit der Seite, die es ausführlich erklärt.
sidebar:
  order: 3
---

Snotra entscheidet bei jedem Tool-Aufruf, ob er läuft, dich vorher fragt oder abgelehnt wird. Die meisten Überraschungen haben eine kurze Antwort; die Seiten unter *Modi, Freigaben und Sicherheit* geben die lange.

## Was du brauchst

Einen Chat, in dem Snotra gefragt, nicht gefragt oder etwas abgelehnt hat. Das Tool-Protokoll über der Antwort zeigt, wie jeder Schritt ausgegangen ist — *abgelehnt*, *blockiert*, *verfallen* —, und wenn du mit der Maus über den Schritt fährst, siehst du die Einzelheiten: [Verfolgen, was Snotra tut](../../chatting/follow-the-work/).

## Warum fragt Snotra noch einmal, obwohl ich es erlaubt habe?

- *Einmal erlauben* gilt nur für diesen einen Aufruf.
- *Für diese Sitzung erlauben* gilt für dasselbe Tool auf genau denselben Zielen, in diesem Chat. Eine andere Datei, ein anderer Chat, ein geänderter Modus oder eine geänderte Regel oder ein Neustart fragen wieder.
- *Diesen Befehl immer erlauben* merkt sich genau eine Befehlszeile. Eine andere Schreibweise — eine Option mehr, ein anderer Arbeitsordner, anderer Netzzugriff — ist ein anderer Befehl.
- Manches lässt sich nicht über einen Aufruf hinaus erlauben: Überschreiben ohne Rückweg und externe Dienste wie die Websuche oder MCP-Tools. In *Intelligent* fragen sie jedes Mal.

[Auf eine Freigabe-Anfrage antworten](../../safety/approve-a-request/) erklärt jeden Knopf.

## Warum hat Snotra nicht gefragt?

- In *Intelligent* läuft Lesen im geöffneten Ordner ohne Nachfrage.
- Eine Erlaubnis greift: eine für diese Sitzung, eine dauerhafte oder ein gemerkter Befehl. *Einstellungen › Tools & Sicherheit* listet sie auf und widerruft sie: [Sehen und ändern, was Snotra darf](../../safety/tools-and-security/#eine-freigabe-widerrufen-oder-zurücksetzen).
- Der Chat steht auf *Auto*, oder der Ordner hat *Auto* als Standard. Die Modus-Pille in der Chat-Eingabe zeigt es: [Einen Modus wählen](../../safety/choose-a-mode/).

## Warum wurde ein Aufruf ohne Karte abgelehnt?

- **Eine Sperre erfasst ihn.** Eine Sperre gewinnt in jedem Modus. Die Zeile der Risikoklasse unter *Einstellungen › Tools & Sicherheit* listet deine Sperren.
- **Das Tool ist ausgeschaltet.** Shell-Befehle und Python sind aus, bis du sie einschaltest, in der Zeile *Ausführen*.
- **Das Ziel wird nie angeboten:** dein Home-Ordner als Ganzes, das Wurzelverzeichnis einer Platte, Snotras eigener Speicher und zum Schreiben Orte mit Zugangsdaten wie `~/.ssh`.
- **Du hast denselben Aufruf in diesem Lauf schon abgelehnt.** Fragt das Modell unverändert noch einmal, endet der Lauf; die Ablehnung bleibt.

## Warum scheitert ein Befehl, obwohl ich ihn erlaubt habe?

Unter macOS und Linux läuft jeder Befehl in einer Sandbox, und deine Freigabe hebt sie nicht auf. Sieh nach dem Kasten *Die Sandbox hat … blockiert* unter dem Tool-Protokoll: Er sagt, was der Befehl erreichen wollte. [Befehle in der Sandbox ausführen](../../safety/sandbox/) zeigt, wie du es für den nächsten Lauf erlaubst.

## Warum sagt die Karte *Anfrage verfallen*?

Während die Karte wartete, hat sich etwas geändert, auf dem sie beruhte: der Chat, der Ordner, der Modus oder eine Regel. Der Lauf endet. Frag noch einmal, wenn du es noch willst.

## Warum kann ich *Auto* nicht wählen?

*Auto* und gemerkte Befehle brauchen den verschlüsselten Speicher des Systems, damit niemand deine Berechtigungen hinter deinem Rücken ändern kann. Ohne ihn — auf einem Linux-Desktop ohne Schlüsselring etwa — gehen *Intelligent* und *Immer fragen* wie gewohnt. Siehe [Schlüsselbund-Fragen und verschlüsselter Speicher](../keychain-and-storage/).

## Warum steht auf der Pille *Auto · nicht isoliert*?

In diesem Ordner liefen Befehle und Python ohne Sandbox und ohne Nachfrage: Du hast die Sandbox für den Ordner ausgeschaltet, oder das System hat keine, wie Windows. Das Modusmenü sagt, was zutrifft.

## Wenn es nicht klappt

- **Die Berechtigungsdatei war beschädigt oder verändert.** *Einstellungen › Tools & Sicherheit* sagt es. Snotra läuft dann in *Intelligent*, oder in *Immer fragen*, wenn das eingestellt war; Erlaubnisse werden verworfen, Sperren bleiben in Kraft. Richte ein, was du brauchst, neu ein.
- **Du willst von vorn anfangen.** *Workspace-Regeln zurücksetzen* oder *Alle Berechtigungen zurücksetzen*, unten unter *Einstellungen › Tools & Sicherheit*.
