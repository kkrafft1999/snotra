---
title: Wenn das Modell einen Fehler meldet
description: Was der rote Kasten unter deiner Nachricht bedeutet, welche Fehler vom Anbieter kommen und welche von Snotra, und was du bei den häufigen tust.
sidebar:
  order: 1
---

Manchmal bekommt eine Nachricht keine Antwort, sondern nur einen roten Kasten, der mit *Fehler:* beginnt. Die meisten dieser Fehler kommen vom Anbieter — OpenAI, einem lokalen Server, einem Gateway —, und Snotra gibt sie in den Worten des Anbieters weiter. Meist genügt es, den Kasten genau zu lesen, um zu wissen, was zu tun ist.

## Was du brauchst

Einen Chat, in dem eine Nachricht mit einem Fehler endete.

## Schritte

1. Lies den Kasten unter deiner Nachricht. Nach *Fehler:* steht der Grund: entweder der Satz des Anbieters, oft auf Englisch, egal welche Sprache Snotra hat, oder ein Satz von Snotra selbst.
2. Such den Fehler in der Tabelle unten und tu, was dort steht.
3. Schick die Nachricht noch einmal. Snotra wiederholt eine gescheiterte Anfrage nicht von selbst.

![Eine Frage im Chat, darunter ein roter Kasten: „Fehler: Incorrect API key provided: sk-proj-…7Qx2. You can find your API key at https://platform.openai.com/account/api-keys.“](screenshots/provider-error.webp)

## Häufige Fehler

| Was im Kasten steht | Was es bedeutet | Was du tust |
| --- | --- | --- |
| *Incorrect API key provided*, *Invalid API key*, HTTP 401 | Der Anbieter nimmt den Key nicht an. | Leg beim Anbieter einen neuen Key an und trag ihn unter *Einstellungen › Modelle* ein, mit dem Stift des Eintrags. |
| *You exceeded your current quota*, *insufficient_quota* | Dein Konto hat kein Guthaben mehr oder keine Zahlungsart. | Prüf die Abrechnung in deinem Konto beim Anbieter. |
| *Rate limit reached*, HTTP 429 | Zu viele Anfragen oder Tokens in kurzer Zeit. | Warte eine Minute und schick erneut. Ein langer Chat schickt jedes Mal mehr mit; ein neuer Chat hilft. |
| *The model … does not exist or you do not have access to it*, HTTP 404 | Der Modellname ist falsch, oder dein Konto darf das Modell noch nicht nutzen. | Prüf den Namen unter *Einstellungen › Modelle*; bei OpenAI brauchen manche Modelle eine verifizierte Organisation. |
| *Kein API-Key für … hinterlegt.* | Der Eintrag hat keinen Key. | Trag einen unter *Einstellungen › Modelle* ein. |
| *Verbindung zu … fehlgeschlagen.* mit *ECONNREFUSED* | Unter der Adresse lauscht nichts — meist ein lokaler Server, der nicht läuft. | Starte LM Studio, Ollama oder deinen Server und prüf die *Server-URL*. |
| *Verbindung zu … fehlgeschlagen.* mit *ENOTFOUND* oder *ETIMEDOUT* | Die Adresse ist nicht erreichbar: kein Netz, ein Tippfehler, ein Proxy oder ein VPN dazwischen. | Prüf die Verbindung und die Adresse. |
| *Zeitüberschreitung nach … s.* | Der Anbieter hat zu lange nicht geantwortet. | Versuch es erneut; passiert es immer wieder, ist der Anbieter oder das Netz langsam. |
| *… kann das Reasoning-Level … nicht.* | Das Modell nimmt die im Chat gewählte Stufe nicht. | Wähl im Modellmenü eine andere: [Modell oder Reasoning-Stufe wechseln](../../chatting/model-and-reasoning/). |
| *Der Anbieter hat die Antwort mit seinem Inhaltsfilter gestoppt.* | Der Anbieter hat sich geweigert weiterzumachen. | Formulier die Anfrage um. |

## Fehler, die von Snotra selbst kommen

Manche Kästen haben mit dem Anbieter nichts zu tun:

- ***Die Antwort wurde abgeschnitten: Das Modell hat seine Ausgabegrenze erreicht.*** Bitte Snotra weiterzumachen oder in kleineren Teilen zu antworten. Geschah es mitten in einem Tool-Aufruf, bitte um kleinere Schritte — eine Datei nach der anderen.
- ***Zu viele Tool-Runden (aktuell 14).*** Das Modell hat öfter hintereinander Tools aufgerufen als erlaubt. Stell eine engere Frage, oder erhöhe *Max. Tool-Runden* unter [*Einstellungen › Allgemein*](../../customising/settings/).
- ***Die Verbindung endete, bevor die Antwort vollständig war.*** Anbieter oder Netz haben abgebrochen. Schick die Nachricht noch einmal.
- ***Die Antwort ist nicht angekommen.*** Frag noch einmal.
- ***Snotra Agent ist auf einen eigenen Fehler gestoßen und hat die Antwort abgebrochen.*** Frag noch einmal. Passiert es wieder, [melde es](../logs-and-reports/) mit dem Text in Klammern.

## Was passiert

Der Fehler bleibt im Chat stehen, auch im Verlauf, und geht mit deiner nächsten Nachricht nicht ans Modell. Sonst ändert sich nichts: dein Key, deine Einstellungen und der bisherige Chat bleiben, wie sie waren.

## Wenn es nicht klappt

- **Der Senden-Knopf ist gesperrt, und es gibt gar keinen Kasten.** Es ist kein Modell eingerichtet, oder ihm fehlt der Key. Die Zeile über der Eingabe sagt, was: siehe [Ein Modell anbinden](../../getting-started/connect-a-model/).
- **Der Key stimmt, aber der Anbieter lehnt ihn trotzdem ab.** Achte auf mitkopierte Leerzeichen, und prüf, ob der Key zu dem Projekt oder der Organisation gehört, die das Guthaben hat.
- **Nach einem Update des lokalen Servers scheitert jede Anfrage.** Seine Adresse oder sein Port hat sich vielleicht geändert; bei LM Studio etwa kannst du den Port wählen. Vergleich ihn mit der *Server-URL*.
