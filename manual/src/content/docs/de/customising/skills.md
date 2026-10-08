---
title: Skills nutzen
description: Schalte einen Skill für eine Arbeitsweise ein, ruf einen mit /name für einen einzelnen Chat auf und lass dir von Snotra den passenden vorschlagen.
sidebar:
  order: 5
---

Ein Skill sagt dem Modell, wie es eine bestimmte Art von Aufgabe erledigt: ein Meeting-Protokoll schreiben, Code nach den Regeln deines Teams prüfen, raten, was gesät wird. Er ist ein Ordner mit einer `SKILL.md` im offenen [Agent-Skills-Format](https://agentskills.io/specification) — Skills, die für andere Agenten geschrieben wurden, funktionieren also auch in Snotra.

## Was du brauchst

Einen Skill. Snotra bringt drei mit; die anderen kommen von dir oder aus einem Projekt.

## Woher Skills kommen

| Quelle | Ordner | Standardmäßig an |
| --- | --- | --- |
| System-Skills | in der App eingebaut | ja |
| Der geöffnete Ordner | `.agents/skills/<name>/` | nein |
| Deine eigenen | `~/.snotra/skills/<name>/` | nein |
| Deine eigenen, alter Ort | `~/.agents/skills/<name>/` | nein |

Mit den drei System-Skills beantwortet Snotra Fragen zu sich selbst (`snotra-capabilities`), merkt sich Dinge (`snotra-memory`) und schreibt Skills (`snotra-skill-authoring`). Ordner anderer Werkzeuge wie `.claude/` werden nicht gelesen.

## Einen Skill einschalten

1. Öffne *Einstellungen › Skills*.
2. Hak die Skills an, die du willst. Sie sind danach gruppiert, woher sie kommen.
3. Klick auf *Übernehmen*.

![Einstellungen › Skills: die Auswahl „Vorschläge im Chat“, der Knopf „Skills neu laden“, die drei System-Skills angehakt und darunter der Skill aussaat-tipps aus dem Ordner .agents/skills, nicht angehakt.](screenshots/skills-settings.webp)

Ein Skill aus einem Ordner ist nie von selbst an: Er ist fremder Inhalt, ihn einzuschalten ist also deine Entscheidung — und es gilt nur für diesen Ordner. Hakst du in einem Projekt einen `review`-Skill an, ist damit im nächsten kein `review`-Skill eingeschaltet.

## Einen Skill für einen Chat aufrufen

Tipp `/` ins Eingabefeld: Eine Liste aller verfügbaren Skills öffnet sich, auch der ausgeschalteten. Tipp weiter, um sie einzugrenzen — sie durchsucht Namen und Beschreibungen —, und übernimm einen mit `Enter` oder `Tab`.

Der Text `/name` bleibt in deiner Nachricht, und der Skill gilt für den Rest dieses Chats. Deine Auswahl unter *Einstellungen › Skills* bleibt, wie sie war. Es zählt nur, was du tippst: Ein `/name` in einer Antwort oder in einer Datei schaltet nichts ein.

## Dir einen Skill vorschlagen lassen

Schreib deine Bitte und tipp dann `/`. Unter dem Eingabefeld schlägt Snotra einen passenden Skill vor, zum Beispiel *Passt dazu: /aussaat-tipps*. Ein Klick übernimmt ihn; `×` blendet ihn aus. Wie er gefunden wird, stellst du unter *Einstellungen › Skills › Vorschläge im Chat* ein:

- ***Aus den Beschreibungen (ohne Modell)*** — vergleicht deine Zeile mit den Skill-Beschreibungen, auf deinem Rechner und ohne Kosten. Der Standard.
- ***Das Modell fragen*** — versteht auch Fachkürzel, schickt dafür aber deine Zeile und die Skill-Namen an den Anbieter und braucht einen Moment.
- ***Keine Vorschläge.***

Ein Vorschlag wird nie von selbst eingeschaltet.

## Was dann passiert

Das Modell liest die Anweisungen eines eingeschalteten Skills, wenn es sie braucht, zusammen mit den Dateien neben seiner `SKILL.md`, etwa `references/` oder `assets/`. Die sind schreibgeschützt: Was ein Skill behalten will, schreibt er nach `.agents/data/` im geöffneten Ordner, wie jede andere Änderung, die du freigibst.

Snotra beobachtet die Skill-Ordner, ein neuer oder geänderter Skill erscheint also von selbst in den Einstellungen und in der `/`-Liste. *Skills neu laden* gibt es für den seltenen Fall, dass das nicht klappt, etwa auf einem Netzlaufwerk.

## Wenn es nicht klappt

- **Ein Skill ist ausgegraut, mit einem Grund.** Seine `SKILL.md` fehlt, hat kein Front Matter, oder ihr `name` passt nicht zum Ordner. Der Grund steht daneben.
- **Ein Skill ist mit *Überdeckt von …* markiert.** Ein anderer Skill gleichen Namens kommt zuerst — der des Ordners vor deinen eigenen. Der Pfad sagt, welcher.
- **Dein eigener Skill ist in einem Projekt aus.** Das Projekt hat einen Skill gleichen Namens; er überdeckt deinen dort und braucht seinen eigenen Haken.
