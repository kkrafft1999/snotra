---
title: Die Release Notes lesen
description: Wo du siehst, was eine neue Version für dich ändert, bevor du sie installierst, und wie du die Warnungen darin liest.
sidebar:
  order: 2
---

Bevor du eine Version herunterlädst, kannst du sehen, was sie für dich ändert. Der Update-Dialog zeigt die Hinweise, die für dich geschrieben sind, in der Sprache der Oberfläche.

## Schritte

1. Bietet der Update-Dialog eine Version an, klicke unter dem Text auf *Was sich geändert hat*. Die Hinweise klappen im Dialog auf; lange scrollen.
2. Lies die Punkte von oben nach unten. Jeder beginnt mit einem fett gesetzten Satz, der sagt, was dir auffallen wird: eine neue Funktion, ein geänderter Standard, etwas, das anders funktioniert, ein behobenes Problem.
3. Achte auf einen zitierten Absatz am Anfang. Dort warnt ein Release vor etwas – einer Einstellung, die neu vorzunehmen ist, einem Schritt von Hand, einer Version, von der es kein Zurück gibt.
4. Dann entscheidest du: *Herunterladen*, *Später erinnern* oder *Diese Version überspringen*. Siehe [Snotra Agent aktualisieren](../update-snotra/).

Das Feld gibt es auch im Schritt *Bereit*, nach dem Download, falls du die Hinweise vor dem Neustart lesen willst.

## Was du siehst

[seit 1.25] Der Dialog zeigt nur, was sich für dich ändert. Arbeit im Hintergrund – Tests, Build, Dokumentation, interne Umbauten – bleibt weg. Bringt eine Version nichts, was dir auffällt, sagen die Hinweise das in einem Satz.

Die Hinweise folgen der Oberflächensprache: Stellst du sie unter [*Einstellungen › Allgemein*](../../customising/settings/#der-bereich-allgemein) um, wechselt der offene Dialog mit. Die vollständige Liste aller Änderungen mit Links zu den Pull Requests steht auf Englisch in den [Releases auf GitHub](https://github.com/kkrafft1999/snotra/releases). Bei einer Installation, die sich nicht selbst aktualisiert, führt dich der Knopf *Release-Seite öffnen* im Dialog dorthin. Auf GitHub stehen auch die Hinweise übersprungener und älterer Versionen.

## Snotra nach Versionen fragen

[seit 1.27.2] Du musst keinen Dialog öffnen, um zu erfahren, was eine Version geändert hat. Frag im Chat:

- *Was hat sich seit 1.25.0 geändert?* – alles zwischen dieser und der installierten Version.
- *Was ist in meiner Version neu?* – die Hinweise der installierten Version.
- *Gibt es eine neuere Version, und was bringt sie mir?* – die Hinweise der Versionen nach deiner.

Snotra liest die Hinweise der Releases mit dem Tool `list_release_notes`, in der Sprache der Oberfläche, und antwortet gegliedert – was neu ist, was besser wurde, was behoben ist – mit den Versionsnummern und verlinkt die Handbuchseite, auf der eine Funktion beschrieben ist. Dafür fragt es bei GitHub die öffentliche Liste der Releases ab, dieselbe Anfrage wie die Update-Prüfung; nichts aus deinen Dateien oder dem Chat geht mit, deshalb fragt es nicht vorher. Die Anfrage geht nur, wenn du fragst – egal, was die Einstellung *Beim Start nach Updates suchen* sagt.

## Wenn es nicht klappt

- **Das Feld *Was sich geändert hat* fehlt.** Das Release hat keine für dich geschriebenen Hinweise – Versionen vor 1.25 haben keine. Die Release-Seite zeigt trotzdem, was sich geändert hat.
- **Du willst die Hinweise einer Version, die du schon installiert hast.** Der Dialog zeigt sie nur, solange ein Update angeboten wird. Frag Snotra im Chat, siehe oben, oder lies sie auf der [Releases-Seite](https://github.com/kkrafft1999/snotra/releases).
- **Snotra sagt, es konnte die Release-Historie nicht lesen.** Die Abfrage braucht eine Verbindung zu GitHub, und GitHub begrenzt Anfragen aus einem gemeinsam genutzten Netz nach einer Weile. Versuche es später noch einmal; die Hinweise stehen auch auf der [Releases-Seite](https://github.com/kkrafft1999/snotra/releases). Snotra füllt die Lücke nicht aus dem Gedächtnis.
- **Snotra sagt, zu einer Version gibt es keine Hinweise für dich.** Versionen vor 1.25 haben keine; Snotra nennt sie und erfindet keine Änderungen.
