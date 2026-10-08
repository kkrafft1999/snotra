---
title: Snotra einen Skill schreiben lassen
description: Mach aus einer Arbeitsweise einen Skill, indem du im Chat darum bittest, und nutze ihn in jedem Ordner, sobald er funktioniert.
sidebar:
  order: 6
---

Hast du eine Arbeitsweise einmal erklärt — wie du Protokolle geschrieben haben willst, was eine gute Prüfung abdeckt —, kannst du sie als Skill behalten. Snotra schreibt ihn für dich.

## Was du brauchst

- Einen geöffneten Ordner; der Skill wird dort hineingeschrieben.
- Den System-Skill `snotra-skill-authoring`, der standardmäßig an ist. Er sagt dem Modell, wohin ein Skill gehört und wie er aussehen muss.

## Schritte

1. Bitte im Chat darum: *Mach daraus einen Skill: wie man rät, was als Nächstes gesät wird.* Oder für einen bestehenden: *Nimm die Kräuterspirale in den Skill aussaat-tipps auf.*
2. Snotra schreibt `.agents/skills/<name>/SKILL.md` im geöffneten Ordner und weitere Dateien daneben, wenn der Skill sie braucht. Gib die Änderungen auf den Karten frei.
3. Öffne *Einstellungen › Skills*, hak den neuen Skill an und klick auf *Übernehmen*.

## Was dann passiert

- Snotra prüft jede `SKILL.md`, die es schreibt, sofort so, wie es die Skill-Liste tut: Front Matter, `name` und `description`, der Name gleich dem Ordner. Eine kaputte geht zum Reparieren an das Modell zurück.
- Das Tool-Protokoll zeigt das Schreiben als Teil des Skills: *1 Skill-Datei geschrieben*.
- Der neue Skill erscheint von selbst unter *Einstellungen › Skills* und bleibt, wie jeder Skill aus einem Ordner, aus, bis du ihn anhakst.

## Ihn in jedem Ordner nutzen

Snotra schreibt Skills **nur in den geöffneten Ordner**. Deine eigenen Skills in `~/.snotra/skills/` und die System-Skills sind für jedes Tool schreibgeschützt — so kann keine Anweisung, die in irgendeinem Projekt versteckt ist, einen Skill anlegen, der dann überall auftaucht.

Um einen Skill in jedem Ordner zu nutzen, verschieb seinen Ordner selbst, in deinem Dateimanager, von `.agents/skills/` nach `~/.snotra/skills/`. Hak ihn dann unter *Einstellungen › Skills* noch einmal an.

## Wenn es nicht klappt

- **Es ist kein Ordner geöffnet.** Snotra zeigt die `SKILL.md` dann im Chat, statt sie zu schreiben; speichere sie selbst.
- **Snotra schreibt den Skill nicht so, wie du es erwartest.** `snotra-skill-authoring` ist vielleicht unter *Einstellungen › Skills* ausgeschaltet.
