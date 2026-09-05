# Übergabe nach Issue #65

Stand: 2026-09-05.

- [Sicherheitskonzept](./sicherheitskonzept.md) ausgearbeitet: drei Modi,
  sechs Risikoklassen, Matrix, sensible Daten, Freigaben, harte Grenzen,
  Audit und Referenzvergleich. Dies ist ein Konzept, keine neue Laufzeitfunktion.
- [Roadmap](./roadmap.md) verlinkt das Konzept und macht #62/#63 von der
  fertig getesteten Umsetzung von #66 und #67 abhängig.
- [#66](https://github.com/kkrafft1999/snotra/issues/66) und
  [#67](https://github.com/kkrafft1999/snotra/issues/67) auf GitHub anhand des
  Konzepts nachgeschärft; gespeicherte Beschreibungen vollständig zurückgelesen
  und abgeglichen. Die dortigen Konzeptlinks funktionieren nach dem Push.
- Review des Konzepts am 2026-09-05 eingearbeitet: Vertrauensmodell für den
  Renderer mit nativer Bestätigung schutzlockernder Aktionen, HMAC-signierte
  Policy-Datei mit fail-safe, Provider-Redaktion sensibler Tool-Nachrichten im
  Verlauf, Verfall statt Zehn-Minuten-Timeout, Wiederherstellungskopie beim
  Überschreiben. #66 und #67 entsprechend nachgeschärft (nativer Auto-Dialog,
  Verfall statt Zeitlimit).
- Markdown-Verarbeitung, lokale Links/Anker, alle zwölf Registry-Tools und die
  18 Matrixzellen geprüft. Keine Programmdateien geändert; daher kein App-Build
  oder Laufzeittest erforderlich. Quellen wurden am 2026-09-05 geprüft.

## Nächste Arbeitsphase in einer neuen Konversation

Mit #66 beginnen, danach #67. Zuerst Konzept und aktuelle Issue-Beschreibungen
lesen. Den inzwischen erreichten Stand von #68 zur Workspace-Autorität beachten.
Wesentliche Festlegungen: Deny schlägt Allow, `ask-all` fragt trotz gemerkter
Erlaubnis, Auto hebt harte Grenzen nicht auf. Sensitive Inhalte werden vor
Weitergabe geprüft; Freigaben binden den geprüften Aufruf und verlieren bei
relevanten Änderungen ihre Gültigkeit. Die offenen Entscheidungen stehen in
Abschnitt 11 des Konzepts.

Die Dokumentation wird lokal auf `main` gesichert und nicht automatisch gepusht.
Wegen paralleler Arbeit am Zweig `feat/68-main-owns-workspace-root` erfolgt dies
in einer separaten Arbeitskopie (`git worktree list` zeigt deren Ort). Die
parallelen Programmänderungen gehören nicht zu dieser Sicherung. Issue #65
bleibt bis zur Veröffentlichung und abschließenden Abnahme offen.
