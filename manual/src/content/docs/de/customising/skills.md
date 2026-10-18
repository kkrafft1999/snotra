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

## Einen Skill des Ordners global machen

[seit 1.22] Einen Skill, den du in einem Projekt geschrieben hast und nun in jedem Ordner haben willst, musst du nicht von Hand verschieben.

1. Öffne [*Einstellungen › Skills*](#einen-skill-einschalten) und klapp den Skill unter *Ordner · .agents/skills* mit einem Klick auf.
2. Klick unter seinem Pfad auf *Global machen…*.
3. Snotra fragt erst nach und nennt beide Ordner: wo der Skill jetzt liegt, in `.agents/skills/` des offenen Ordners, und wohin er kommt, `~/.snotra/skills/`. Klick auf *Global machen* — oder auf *Abbrechen*, das tun auch `Enter` und `Esc`.

Der Skill verlässt das Projekt und steht sofort unter *Benutzer · ~/.snotra/skills*. War er in diesem Ordner angehakt, ist er danach für jeden Ordner angehakt; der Dialog sagt das vorher. Einer, der aus war, bleibt aus.

Das kannst nur du. Das Modell schreibt Skills nur in den offenen Ordner und verschiebt keinen aus ihm heraus.


Tipp `/` ins Eingabefeld: Eine Liste aller verfügbaren Skills öffnet sich, auch der ausgeschalteten. Tipp weiter, um sie einzugrenzen — sie durchsucht Namen und Beschreibungen —, und übernimm einen mit `Enter` oder `Tab`.

Der Text `/name` bleibt in deiner Nachricht, und der Skill gilt für den Rest dieses Chats. Deine Auswahl unter *Einstellungen › Skills* bleibt, wie sie war. Es zählt nur, was du tippst: Ein `/name` in einer Antwort oder in einer Datei schaltet nichts ein.

## Dir einen Skill vorschlagen lassen

Schreib deine Bitte und tipp dann `/`. Unter dem Eingabefeld schlägt Snotra einen passenden Skill vor, zum Beispiel *Passt dazu: /aussaat-tipps*. Ein Klick übernimmt ihn; `×` blendet ihn aus. Wie er gefunden wird, stellst du unter *Einstellungen › Skills › Vorschläge im Chat* ein:

- ***Aus den Beschreibungen (ohne Modell)*** — vergleicht deine Zeile mit den Skill-Beschreibungen, auf deinem Rechner und ohne Kosten. Der Standard.
- ***Das Modell fragen*** — versteht auch Fachkürzel, schickt dafür aber deine Zeile und die Skill-Namen an den Anbieter und braucht einen Moment.
- ***Keine Vorschläge.***

Ein Vorschlag wird nie von selbst eingeschaltet.

## Sehen, welche Skills ein Chat hat

[seit 1.20] In der Chat-Leiste, neben Modell und Modus, zählt eine Pille die Skills, die in diesem Chat eingeschaltet sind: *3 Skills* oder *Keine Skills*. Ein Klick darauf zeigt das ganze Bild:

![Das Popover der Pille „3 Skills“: unter Skills die drei System-Skills an und aussaat-tipps aus dem Ordner aus; unter Tools run_python und shell_execute ausgeschaltet mit je einem Knopf „Einschalten“, web_search und generate_image mit „Einrichten“, darunter zugeklappt „15 eingeschaltet“; ganz unten Links zu Einstellungen › Skills und Einstellungen › Tools › Autonomie.](screenshots/chat-config.webp)

- **Skills** – jeder Skill, die eingeschalteten zuerst, jeweils mit seiner Herkunft. Ein Skill, den du mit `/name` aufgerufen oder auf einer Karte für diesen Chat eingeschaltet hast, trägt die Marke *nur dieser Chat*.
- **Tools** – was fehlt, steht oben, mit dem Grund, etwa *ausgeschaltet* oder *kein Suchdienst-Schlüssel*. *Einschalten* oder *Einrichten* öffnet die Einstellung, die das ändert. Die eingeschalteten Tools sind in einer Zeile zusammengefasst; ein Klick darauf zeigt sie nach Gruppen.
- Die beiden Links unten öffnen *Einstellungen › Skills* und *Einstellungen › Tools › Autonomie*.

Die Pille zeigt nur an. Was du dauerhaft ein- oder ausschaltest, bleibt eine Entscheidung in den Einstellungen.

Das Modell sieht dieselbe Liste. Scheitert etwas oder scheint eine Fähigkeit zu fehlen, schaut es dort nach, statt zu raten, und sagt dir zum Beispiel, dass *pdf-export* passen würde, aber aus ist – und wo du ihn einschaltest. Selbst einschalten kann es nichts, und die Anleitung eines ausgeschalteten Skills erreicht es nie.

## Wenn das Modell vorschlägt, etwas einzuschalten

[seit 1.21] Würde ein ausgeschalteter Skill oder ein Tool bei deiner Anfrage helfen, kann das Modell vorschlagen, ihn einzuschalten – nur für diesen Chat. Snotra zeigt dann eine Karte im Chat:

![Eine Karte mit dem Titel „Für diesen Chat einschalten“: das Tool fetch_url mit seiner Beschreibung von Snotra, darunter „Externe Dienste · nur dieser Chat“, eine zugeklappte Zeile „Begründung des Modells“, die Knöpfe „Einschalten“ und „Ablehnen“ und der Hinweis, dass neue Chats deine Einstellungen behalten.](screenshots/config-proposal.webp)

### Was die Karte zeigt

- **Den Namen und was er tut**, in Snotras eigenen Worten. Bei einem Skill aus einem Ordner oder aus deinen eigenen Skills stammt die Beschreibung von seinem Autor, und die Karte sagt das.
- **Die Risikoklasse** eines Tools – *Lesen*, *Ändern*, *Ausführen*, *Externe Dienste* – oder **die Herkunft** eines Skills, dazu *nur dieser Chat*.
- ***Begründung des Modells***, zugeklappt. Klapp sie auf, um zu lesen, warum das Modell fragt; es ist der Satz des Modells, nicht der von Snotra.

### Schritte

- ***Einschalten*** schaltet ihn für diesen Chat ein. Das Modell arbeitet sofort damit weiter.
- ***Ablehnen*** lässt ihn aus. Denselben Vorschlag zeigt Snotra in diesem Chat nicht noch einmal. `Esc` lehnt ebenfalls ab.

Das Modell kann auch vorschlagen, etwas für einen Chat auszuschalten – etwa wenn du es gebeten hast, nur mit deinen Dokumenten zu arbeiten. Diese Karte fragt *Ausschalten* oder *Anlassen*.

### Was passiert

Die Änderung gilt nur für diesen Chat. Sie bleibt, wenn du einen anderen Chat öffnest und zurückkommst, und auch nach einem Neustart; ein neuer Chat beginnt wieder mit deinen Einstellungen. Die Skills-Pille markiert die Änderung mit *nur dieser Chat*. Dauerhaft einschalten kannst du unter [*Einstellungen › Tools › Autonomie*](../../safety/tools-and-security/) oder [*Einstellungen › Skills*](#einen-skill-einschalten).

Ein so eingeschaltetes Tool verhält sich wie eines aus den Einstellungen: Im Modus *Intelligent* fragt es weiterhin vor jedem Aufruf, der eine Freigabe braucht.

### Wenn es nicht klappt

- **Das Modell sagt, ein Tool lasse sich im Chat nicht einschalten.** Es muss erst eingerichtet werden – ein Schlüssel, ein Programm oder der Schalter für Python oder Shell-Befehle unter *Einstellungen › Tools › Autonomie*. Das bleibt in den Einstellungen.
- **Du hast versehentlich abgelehnt.** Schalte es in den Einstellungen ein, oder beginne einen neuen Chat und frag noch einmal.

## Was dann passiert

Das Modell liest die Anweisungen eines eingeschalteten Skills, wenn es sie braucht, zusammen mit den Dateien neben seiner `SKILL.md`, etwa `references/` oder `assets/`. Die sind schreibgeschützt: Was ein Skill behalten will, schreibt er nach `.agents/data/` im geöffneten Ordner, wie jede andere Änderung, die du freigibst.

Snotra beobachtet die Skill-Ordner, ein neuer oder geänderter Skill erscheint also von selbst in den Einstellungen und in der `/`-Liste. *Skills neu laden* gibt es für den seltenen Fall, dass das nicht klappt, etwa auf einem Netzlaufwerk. Einen Skill-Store oder Skill-Manager gibt es nicht: Ein Skill ist ein Ordner, und ihn an einen der Orte unter *Woher Skills kommen* zu legen, genügt.

## Wenn es nicht klappt

- **Das Modell nutzt einen Skill nicht, den du erwartet hast.** Klick auf die Skills-Pille in der Chat-Leiste: Ein ausgeschalteter Skill steht dort mit seiner Herkunft. Ein Skill aus dem Ordner braucht seinen Haken für genau diesen Ordner.
- **Ein Skill ist ausgegraut, mit einem Grund.** Seine `SKILL.md` fehlt, hat kein Front Matter, oder ihr `name` passt nicht zum Ordner. Der Grund steht daneben.
- **Ein Skill ist mit *Überdeckt von …* markiert.** Ein anderer Skill gleichen Namens kommt zuerst — der des Ordners vor deinen eigenen. Der Pfad sagt, welcher.
- ***Global machen* meldet, dass es schon einen globalen Skill dieses Namens gibt.** Nichts wurde verschoben. Benenne einen der beiden um — den Ordner und den `name` in seiner `SKILL.md` — oder entferne zuerst den in `~/.snotra/skills/`. Der Dialog nennt seinen Pfad.
- **Dein eigener Skill ist in einem Projekt aus.** Das Projekt hat einen Skill gleichen Namens; er überdeckt deinen dort und braucht seinen eigenen Haken.
