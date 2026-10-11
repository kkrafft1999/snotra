---
title: Wenn das Diktat nicht klappt
description: Woran du erkennst, ob der Live-Text funktioniert, was Snotra tut, wenn nicht, und was du tun kannst, wenn gar kein Text kommt.
sidebar:
  order: 5
---

Das Diktat kennt zwei Wege, aus Sprache Text zu machen [seit 1.20]. Normalerweise erscheint der Text, während du sprichst: Das ist die **Live-Transkription** von OpenAI. Ist sie nicht erreichbar oder bricht sie ab, nimmt Snotra weiter auf und lässt den Rest beim Stoppen in einem Stück von **Whisper** transkribieren, ebenfalls von OpenAI — so, wie das Diktat bisher funktioniert hat. So oder so landet der Text im Eingabefeld; auf dem zweiten Weg siehst du ihn nur erst am Ende.

Beide Wege brauchen einen OpenAI-Schlüssel unter *Einstellungen › Modelle*. Ohne ihn gibt es gar kein Diktat.

## Was du brauchst

Eine Aufnahme, die nicht so gelaufen ist wie erwartet. Die Zeile neben dem Mikrofon sagt, was passiert ist — lies sie zuerst.

## Woran du erkennst, was passiert

| Was du siehst | Was es bedeutet |
| --- | --- |
| Der Text erscheint, während du sprichst, grau und schräg. Neben dem Mikrofon: *Aufnahme läuft …*, ein roter Pegel und eine Uhr. | Der Live-Text funktioniert. |
| *Aufnahme ohne Live-Text – der Text kommt beim Stoppen.* | Die Live-Transkription ist ausgefallen. Snotra nimmt weiter auf; was schon dasteht, bleibt. Sprich einfach weiter. |
| Nach dem Stoppen *Transkribiere mit Whisper …*, dann *Kein Live-Text (…). Stattdessen mit Whisper transkribiert.* | Der Fallback hat gegriffen: Der Rest der Aufnahme steht im Feld. Der Grund in der Klammer sagt, warum der Live-Text ausgefallen ist. |
| Nach dem Stoppen *Fehler: …* | Auch Whisper ist gescheitert. Was im Feld steht, bleibt; der Teil der Aufnahme, der noch keinen Text hatte, ist verloren. |
| *Fehler: Kein OpenAI-Key hinterlegt (die Spracheingabe braucht einen).* gleich nach dem Klick | Es gibt keinen Schlüssel, und das Mikrofon ist gar nicht erst angegangen. |
| Der Pegel neben dem Mikrofon bleibt flach, während du sprichst. | Das Mikrofon hört nichts — siehe [Wenn es nicht klappt](#wenn-es-nicht-klappt). |

## Wenn der Live-Text ausfällt

Der Grund steht in der Klammer von *Kein Live-Text (…)*.

| Der Grund | Was er bedeutet | Was du tun kannst |
| --- | --- | --- |
| *OpenAI-Spracherkennung nicht erreichbar. Prüf den OpenAI-Key und die Netzwerkverbindung.* | Die Live-Verbindung ist nicht zustande gekommen oder abgebrochen. Meist lässt eine Firewall, ein Proxy oder ein VPN normale Anfragen an OpenAI durch, die Live-Verbindung aber nicht (eine WebSocket-Verbindung zu `api.openai.com`). Ein Schlüssel, den OpenAI ablehnt, sieht von hier aus genauso aus. | Nichts Dringendes — der Fallback fängt es auf. Für den Live-Text: Prüf den Schlüssel unter *Einstellungen › Modelle*, versuch es ohne VPN oder bitte die Leute, die das Netzwerk betreuen, WebSocket-Verbindungen zu `api.openai.com` zu erlauben. |
| Ein englischer Satz von OpenAI, etwa *… does not exist or you do not have access to it* | Dein OpenAI-Konto darf das Live-Modell, `gpt-live-transcribe`, noch nicht nutzen. Bei OpenAI brauchen manche Modelle eine verifizierte Organisation. | Prüf die Organisation und ihre Limits in deinem OpenAI-Konto. Bis dahin transkribiert der Fallback jede Aufnahme. |
| *Rate limit reached*, *insufficient_quota* | Wie im Chat: zu viele Anfragen oder kein Guthaben mehr. | Siehe [Wenn das Modell einen Fehler meldet](../provider-errors/). |

## Wenn auch Whisper scheitert

*Fehler: …* nach dem Stoppen heißt, dass keiner der beiden Wege durchgekommen ist. Der Text im Feld bleibt; sprich den fehlenden Teil noch einmal, wenn die Ursache behoben ist.

- ***Verbindung zum Anbieter fehlgeschlagen.***, ***fetch failed***, ***Zeitüberschreitung nach … s.*** Es gibt gar keine Netzwerkverbindung zu OpenAI. Prüf die Verbindung.
- ***Incorrect API key provided***, ***insufficient_quota***. Der Schlüssel oder das Konto: siehe [Wenn das Modell einen Fehler meldet](../provider-errors/).
- ***Keine Sprache erkannt.*** Die Aufnahme war still oder zu leise — siehe unten.

## Was passiert

Ein Ausfall wirft nichts weg, was du diktiert hast: Was im Eingabefeld steht, bleibt dort als normaler Text, und du kannst es ändern oder abschicken. Eine gescheiterte Live-Verbindung kostet nichts extra; der Fallback schickt nur den Teil der Aufnahme, der noch keinen Text hat.

## Wenn es nicht klappt

- ***Mikrofonzugriff verweigert.*** Dein System lässt Snotra nicht ans Mikrofon. Unter macOS schalte *Snotra Agent* unter *Systemeinstellungen › Datenschutz & Sicherheit › Mikrofon* ein; unter Windows erlaube Desktop-Apps unter *Einstellungen › Datenschutz und Sicherheit › Mikrofon*. Dann versuch es noch einmal.
- **Der Pegel bleibt flach, und es kommt kein Text.** Das Mikrofon hört nichts. Snotra nimmt vom Standard-Eingang des Systems auf: Prüf in den Ton-Einstellungen, dass das das Mikrofon ist, in das du sprichst, und dass es nicht stummgeschaltet ist.
- **Sätze brechen an seltsamen Stellen.** Ein Satz endet an einer Pause von etwa 0,7 Sekunden. Ein langes Luftholen mitten im Satz beendet ihn dort; verloren geht nichts, nur der Punkt sitzt vielleicht falsch. Korrigier ihn im Feld.
- **Die Aufnahme hat von selbst aufgehört.** Eine Aufnahme dauert höchstens fünf Minuten; eine halbe Minute vorher sagt es die Zeile neben dem Mikrofon. Starte eine neue.
- **Die Aufnahme endete, als das Fenster minimiert wurde.** Wird das Fenster ausgeblendet, endet die Aufnahme, und der Text bis dahin bleibt. Lass das Fenster offen, während du diktierst.
- **`Cmd+D` / `Strg+D` tut nichts.** Das Kürzel wirkt, solange das Snotra-Fenster vorne ist.
