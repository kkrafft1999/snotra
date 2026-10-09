---
title: Schlüsselbund-Fragen und verschlüsselter Speicher
description: Warum macOS nach „Snotra AI Safe Storage“ fragt, was du antwortest, und was Snotra kann und was nicht, wenn das System keinen verschlüsselten Speicher hat.
sidebar:
  order: 2
---

Snotra verwahrt deine API-Keys, deinen Chat-Verlauf und deine dauerhaften Berechtigungen verschlüsselt. Der Schlüssel dafür gehört deinem System: dem Schlüsselbund unter macOS, deinem Windows-Konto, dem Schlüsselring deines Linux-Desktops. Wenn das System danach fragt oder ihn nicht anbietet, sagt dir diese Seite, was los ist.

## Was du brauchst

Nichts außer der App. Unter Linux einen Desktop mit Schlüsselring — GNOME Keyring oder KWallet —, den die meisten Desktops mitbringen.

## macOS fragt nach dem Schlüsselbund

macOS fragt unter Umständen, ob *Snotra Agent* das Schlüsselbund-Objekt **Snotra AI Safe Storage** verwenden darf. Das Objekt trägt den Namen der Plattform, Snotra AI; es enthält den Schlüssel, der deine API-Keys und deine Chats verschlüsselt. macOS fragt, wenn es die App noch nicht wiedererkennt — nach einem Update, das die Signatur der App geändert hat, nach einer Neuinstallation oder nachdem du sie verschoben hast.

1. Gib das Passwort ein, mit dem du dich an deinem Mac anmeldest.
2. Wähle **Immer erlauben**.

*Erlauben* allein gilt nur für diesen Start, und macOS fragt beim nächsten Mal wieder. *Ablehnen* lässt Snotra ohne seinen Schlüssel; wie das aussieht und wie du es rückgängig machst, steht weiter unten.

## Was passiert

Mit dem Schlüssel liest Snotra, was es vorher gespeichert hat: Die Modelle behalten ihre Keys, der Verlauf zeigt deine Chats, die Berechtigungen bleiben, wie sie waren. Nichts muss neu eingegeben werden.

## Wenn kein verschlüsselter Speicher verfügbar ist

Bietet das System keinen verschlüsselten Speicher — ein Linux-Desktop ohne Schlüsselring oder ein *Ablehnen* unter macOS —, legt Snotra Keys nicht ersatzweise im Klartext ab. Es sagt es stattdessen, in Rot oben unter *Einstellungen › Modelle*:

![Einstellungen › Modelle mit der roten Zeile: „Verschlüsselter Speicher ist auf diesem System nicht verfügbar. Ein Key kann nicht sicher gespeichert werden.“ Darunter die Liste der präferierten Modelle mit einem Eintrag.](screenshots/storage-unavailable.webp)

Was weiter geht und was nicht:

| | Ohne verschlüsselten Speicher |
| --- | --- |
| Cloud-Modelle, die einen Key brauchen (OpenAI, Gateways) | Nicht nutzbar: Es lässt sich kein Key speichern. Die Zeile über der Chat-Eingabe sagt *Verschlüsselter Speicher ist nicht verfügbar*. |
| Lokale Server ohne Key (LM Studio, Ollama) | Gehen wie gewohnt. |
| Der Chat-Verlauf | Wird unverschlüsselt gespeichert — außer, es liegt schon ein verschlüsselter Verlauf vor. Der bleibt dann für einen Start mit Schlüssel unangetastet, und die Chats dieses Starts werden nicht gespeichert. |
| Die Modi *Intelligent* und *Immer fragen* | Gehen wie gewohnt. |
| Der Modus *Auto*, *Diesen Befehl immer erlauben*, dauerhafte Erlaubnisse | Nicht verfügbar: Sie brauchen einen Eintrag, den niemand unbemerkt ändern kann. Siehe [Einen Modus wählen](../../safety/choose-a-mode/). |
| Keys von MCP-Servern, der Tavily-Key | Lassen sich nicht als Geheimnis speichern. |

## Schritte: den Speicher zurückholen

- **macOS, nach *Ablehnen*.** Beende Snotra und starte es neu; macOS fragt noch einmal. Wähle *Immer erlauben*. Fragt es nicht, öffne die App *Schlüsselbundverwaltung*, such **Snotra AI Safe Storage** und füge unter *Zugriff* *Snotra Agent* zu den Apps hinzu, die es verwenden dürfen.
- **Linux.** Installier und entsperr einen Schlüsselring — `gnome-keyring` oder KWallet — und melde dich neu am Desktop an. Starte dann Snotra.
- **Windows.** Der Speicher gehört zu deinem Benutzerkonto und ist immer da. Keys, die unter einem Windows-Konto gespeichert wurden, lassen sich unter einem anderen nicht lesen; gib sie dort neu ein.

## Wenn es nicht klappt

- **Bei den Modellen steht *Key neu eingeben*.** Der gespeicherte Key lässt sich nicht mehr entschlüsseln — etwa nach einem Umzug auf einen anderen Rechner oder nachdem das Schlüsselbund-Objekt gelöscht wurde. Gib den Key mit dem Stift des Eintrags unter *Einstellungen › Modelle* noch einmal ein.
- **macOS fragt bei jedem Start.** Du hast *Erlauben* statt *Immer erlauben* gewählt. Wähl beim nächsten Mal *Immer erlauben*.
- **Der Verlauf ist zurück, aber einzelne Chats fehlen.** Das sind die Chats eines Starts ohne Speicher; sie wurden nicht gespeichert, damit der verschlüsselte Verlauf nicht überschrieben wird.
- **Der Verlauf bleibt leer, obwohl der Speicher geht.** Der Verlauf ließ sich mit diesem Schlüssel nicht entschlüsseln — etwa nach einem Umzug auf einen anderen Rechner. Snotra überschreibt ihn nicht: Es legt ihn als `chat-history.json.undecryptable-…` im [Profilordner](../logs-and-reports/#der-profilordner) ab und beginnt einen neuen.
