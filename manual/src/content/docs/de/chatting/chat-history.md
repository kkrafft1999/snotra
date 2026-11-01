---
title: Einen früheren Chat fortsetzen
description: Beginne einen neuen Chat, geh zu einem früheren zurück, lass einen Chat im Hintergrund weiterarbeiten, behalte die wichtigen und lösch, was du nicht mehr brauchst.
sidebar:
  order: 7
---

Snotra bewahrt deine Chats auf. Du kannst jederzeit einen neuen beginnen, zu einem früheren zurückgehen und dort weitermachen, wo du aufgehört hast.

## Was du brauchst

Nichts; jeder Chat, in dem du eine Nachricht abschickst, wird gespeichert.

## Den Verlauf einblenden

Klick auf den Knopf ganz rechts in der Titelleiste, *Chat-Verlauf einblenden*. Der Verlauf erscheint als Spalte neben dem Chat, der neueste Chat zuerst. Er enthält nur die Chats des geöffneten Ordners: Jeder Ordner hat seine eigenen. Ein weiterer Klick blendet ihn wieder aus.

![Die Chat-Spalte mit dem Chat „Überblick Gartenplaner“, daneben die Verlaufsspalte mit drei Chats — Überblick Gartenplaner, Abstand der Radieschen, Fruchtfolge fürs nächste Jahr — und oben dem Knopf „Neuer Chat“.](screenshots/history.webp)

## Schritte

- **Einen neuen Chat beginnen:** *Neuer Chat* oben im Verlauf, *Datei › Neuer Chat* oder `Cmd+N` / `Strg+N`.
- **Zu einem Chat zurückgehen:** Klick ihn im Verlauf an. Er kommt mit seinen Nachrichten, seinem Modell, seiner Reasoning-Stufe und seinem Modus zurück.
- **Einen Chat löschen:** Klick auf den Papierkorb daneben und bestätige *Diesen Chat löschen?* mit *Löschen*. Bilder, die du angehängt hattest, verschwinden mit ihm.
- [seit 1.30] **Einen Chat behalten:** Zeig auf ihn und klick auf das Lesezeichen neben dem Papierkorb, *Chat behalten*. Das Lesezeichen bleibt gefüllt; ein behaltener Chat wird nie entfernt, um Platz zu schaffen. Ein weiterer Klick nimmt die Markierung wieder weg.
- [seit 1.30] **Chats aus einem umbenannten Ordner zurückholen:** Gehören Chats zu einem Ordner, den es nicht mehr gibt, sagt ein Hinweis über der Liste, wie viele es sind, zum Beispiel *4 Chats aus Ordnern, die es nicht mehr gibt*. Klick auf *Ansehen*: Die Chats erscheinen nach dem Ordner gruppiert, in dem sie lagen. *Zuordnen* holt einen Chat in den gerade geöffneten Ordner, *Alle zuordnen* jeden Chat dieses alten Ordners.

![Die Verlaufsspalte. Oben der aufgeklappte Hinweis „4 Chats aus Ordnern, die es nicht mehr gibt“ mit dem alten Ordner „garten“ und drei Chats, jeder mit „Zuordnen“, und „Alle zuordnen“ neben dem Ordner; darunter „balkonkraeuter“ mit einem Chat. Unter dem Hinweis die Chats des Ordners; „Überblick Gartenplaner“ und „Fruchtfolge fürs nächste Jahr“ tragen ein gefülltes Lesezeichen.](screenshots/history-keep.webp)

## Was dann passiert

- **Ein Chat arbeitet im Hintergrund weiter.** Wechselst du zu einem anderen Chat, während Snotra noch antwortet, läuft die Antwort weiter. Der Verlauf markiert diesen Chat mit *Arbeitet…*, oder mit *Wartet auf deine Freigabe*, wenn dort eine Karte auf dich wartet; [seit 1.18] eine Systembenachrichtigung sagt es dir zusätzlich.
- **Snotra macht da weiter, wo du aufgehört hast.** Beim nächsten Start öffnet es den jüngsten Chat des Ordners.
- [seit 1.25] **Eine abgebrochene Antwort behält ihre fertigen Schritte.** Schließt sich Snotra oder stürzt ab, während eine Antwort läuft, oder lädst du das Fenster mit *Ansicht › Neu laden* neu, behält der Chat jeden Schritt, der schon fertig war. Die Antwort kommt mit dem Hinweis *Unterbrochen.* darunter zurück; schick deine Frage noch einmal, um weiterzumachen. Ein Neuladen hält die laufende Antwort an.
- [seit 1.23] **Jeder Chat zeigt, was er gekostet hat.** Neben der Uhrzeit stehen im Verlauf die geschätzten API-Kosten des Chats, zum Beispiel *~0,42 $*. Mehr unter [Sehen, was ein Chat kostet](../chat-cost/).
- **Ein neuer Chat beginnt frisch:** ohne das frühere Gespräch, ohne Markierungen im Baum, im Standardmodus des Ordners.
- [seit 1.30] **Jeder Ordner behält seine 200 jüngsten Chats.** Darüber hinaus geht der älteste, sobald ein neuer gespeichert wird — Chats, die du mit *Behalten* markiert hast, bleiben und zählen nicht mit. Was du in anderen Ordnern tust, verdrängt nie die Chats dieses Ordners; Chats ohne Ordner zählen als eigener Ordner.
- [seit 1.30] **Zugeordnete Chats gehören von da an zum geöffneten Ordner:** Sie stehen in seinem Verlauf und öffnen sich wie jeder andere Chat. Einen Chat aus einem fehlenden Ordner kannst du erst öffnen, wenn du ihn zugeordnet hast.
- [seit 1.30] **Über 2.000 Chats insgesamt sagt der Verlauf Bescheid.** Ein Hinweis am Ende der Liste sagt es dir; entfernt wird deshalb nichts. Lösch die Chats, die du nicht mehr brauchst.

Der Verlauf liegt verschlüsselt in deinem Profil, nicht im Projektordner.

## Wenn es nicht klappt

- **Die Verlaufsspalte fehlt.** Das Fenster ist zu schmal für alle Spalten; der Verlauf weicht und kommt in einem breiteren Fenster zurück. Blende die Seitenleiste oder die mittlere Spalte aus, um Platz zu machen.
- **Nach dem Umbenennen oder Verschieben eines Ordners fehlen Chats.** Sie sind noch da, unter dem alten Namen abgelegt. Öffne den Ordner unter seinem neuen Namen und ordne sie über *Ansehen* im Hinweis über dem Verlauf zu.
- **Ein Ordner auf einem externen Laufwerk gilt als nicht mehr vorhanden.** Solange das Laufwerk nicht angeschlossen ist, kann Snotra ihn nicht von einem gelöschten Ordner unterscheiden. Schließ das Laufwerk an, statt seine Chats anderswo zuzuordnen.
- **Ein Bild in einer Antwort eines älteren Chats zeigt einen Platzhalter.** Das Bild liegt in einem anderen Ordner als dem gerade geöffneten, oder die Datei ist weg. In Antworten zeigt Snotra Bilder nur aus dem geöffneten Ordner.
