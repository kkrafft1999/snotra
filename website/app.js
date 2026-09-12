/* ==========================================================================
   Snotra AI — Landingpage snotra-ai.dev

   Enthaelt: Sprachumschaltung DE/EN, Download-Links aus der GitHub-API,
   die bedienbaren Bauteile (Modell-Menue, Freigabe-Karte) und die
   Scroll-Effekte.

   Grundsatz: Die Seite ist ohne dieses Skript vollstaendig lesbar und
   bedienbar. Der deutsche Text steht komplett im HTML, die Download-Knoepfe
   zeigen ohne JS auf .../releases/latest.

   Keine externe Bibliothek, keine externe Ressource ausser der GitHub-API
   fuer die Release-Daten (und die Seite funktioniert auch ohne sie).
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     1. Woerterbuecher
     ====================================================================== */
  var DE = {
    'meta.title': 'Snotra AI — Software wird nicht gekauft. Sie wird beschrieben.',
    'meta.description': 'Snotra AI ist eine Desktop-App, die auf genau einen Ordner zeigt: Dein Fachwissen bleibt eine Datei, jedes CLI auf deinem Rechner wird zum Werkzeug, das Modell ist austauschbar. Kein Server, kein Konto, keine Telemetrie.',
    'skiplink.text': 'Zum Inhalt springen',
    'nav.aria': 'Hauptnavigation',
    'nav.lang.aria': 'Sprache / Language',
    'nav.entscheidungen': 'Entscheidungen',
    'nav.einsatzfelder': 'Einsatzfelder',
    'nav.download': 'Download',
    'nav.github': 'GitHub',
    'nav.cta': 'Herunterladen',

    'hero.eyebrow': 'Desktop-App · macOS · Windows · Linux · Apache 2.0 · v1.5.1',
    'hero.h1.zeile1': 'Software wird nicht gekauft.',
    'hero.h1.zeile2': 'Sie wird beschrieben.',
    'hero.mission.teil1': 'Snotra AI ist die Werkbank dafür: eine Desktop-App, die auf genau einen Ordner zeigt. Das Fachwissen liegt als Textdatei daneben, die Fähigkeiten stecken in Werkzeugen, das Modell ist austauschbare Ware — auch gegen eines, das lokal auf deinem Rechner läuft. Angebunden wird, was ohnehin da ist: jedes CLI auf deiner Maschine.',
    'hero.mission.betont': 'Kein Server, kein Konto, keine Telemetrie.',
    'hero.cta.primaer': 'Für macOS laden — 126 MB',
    'hero.cta.sekundaer': 'Windows & Linux',
    'hero.cta.platform.mac': 'Für macOS laden',
    'hero.cta.platform.win': 'Für Windows laden',
    'hero.cta.platform.deb': 'Für Linux laden',
    'hero.note': 'Version 1.5.1 · quelloffen unter Apache 2.0 · keine Registrierung',
    'hero.appwin.aria': 'Nachbau des Snotra-AI-Fensters: links der Dateibaum des Ordners angebote, in der Mitte die Vorschau von angebot-q3.md, rechts der Chat mit Tool-Log, Freigabe-Karte und Eingabefeld.',
    'hero.stage.caption': 'Platzhalter — echter Screenshot folgt',
    'hero.side.aria': 'Datenblatt',
    'hero.side.version.label': 'Version',
    'hero.side.version.wert': '1.5.1',
    'hero.side.lizenz.label': 'Lizenz',
    'hero.side.lizenz.wert': 'Apache 2.0',
    'hero.side.plattformen.label': 'Plattformen',
    'hero.side.plattformen.wert': 'macOS · Windows · Linux',
    'hero.side.konten.label': 'Konten',
    'hero.side.konten.wert': '0',
    'hero.side.telemetrie.label': 'Telemetrie',
    'hero.side.telemetrie.wert': 'keine',

    'app.fenster.brand': 'Snotra AI',
    'app.baum.wurzel': 'angebote',
    'app.baum.docs': 'docs',
    'app.baum.protokoll': 'protokoll.md',
    'app.baum.angebot': 'angebot-q3.md',
    'app.baum.preise': 'preise.csv',
    'app.baum.skills': '.snotra/skills',
    'app.baum.skillmd': 'angebot/SKILL.md',
    'app.baum.readme': 'README.md',
    'app.vorschau.name': 'angebot-q3.md',
    'app.vorschau.meta': 'markdown · 4,1 KB',
    'app.vorschau.h1': '# Angebot Q3 — Migration & Schulung',
    'app.vorschau.stand': 'Stand: 12.09.2026',
    'app.vorschau.ansprechpartnerin': 'Ansprechpartnerin: M. Ehrt-Küver',
    'app.vorschau.h2.offen': '## Offene Punkte',
    'app.vorschau.offen.1': '- Migrationsfenster noch nicht bestätigt',
    'app.vorschau.offen.2': '- Schulungsumfang offen (2 oder 4 Tage)',
    'app.vorschau.offen.3': '- Wartung ab Q1 statt ab Abnahme',
    'app.vorschau.h2.positionen': '## Positionen',
    'app.vorschau.tabelle.kopf': '| Pos | Leistung        | Tage |',
    'app.vorschau.tabelle.zeile1': '| 1   | Migration       |   12 |',
    'app.vorschau.tabelle.zeile2': '| 2   | Schulung        |    4 |',
    'app.chat.titel': 'Angebot Q3 überarbeiten',
    'app.chat.nutzernachricht': 'Fass die offenen Punkte aus docs/protokoll.md ins Angebot ein.',
    'app.chat.toollog.summary': '4 Dateien gelesen · 2 Suchen · 1 Datei geschrieben',
    'app.chat.toollog.zeile1': 'Datei docs/protokoll.md gelesen',
    'app.chat.toollog.zeile2': 'Datei angebot-q3.md wird geschrieben … · wartet auf Freigabe',
    'app.freigabe.titel': 'Änderung bestätigen',
    'app.freigabe.headline': 'Snotra möchte docs/angebot-q3.md ändern (write_file_text).',
    'app.freigabe.fakt.wirkung.label': 'Wirkung',
    'app.freigabe.fakt.wirkung.wert': 'Ändern',
    'app.freigabe.fakt.ziel.label': 'Ziel',
    'app.freigabe.fakt.ziel.wert': 'Datei docs/angebot-q3.md',
    'app.freigabe.fakt.ziel.badge': 'Stand v3',
    'app.freigabe.fakt.grund.label': 'Grund',
    'app.freigabe.fakt.grund.wert': 'Offene Punkte aus dem Protokoll ergänzen',
    'app.freigabe.fakt.modus.label': 'Modus',
    'app.freigabe.fakt.modus.wert': 'Intelligent',
    'app.freigabe.vorschau': '▸ Vorschau: Ersetzung (alt → neu)',
    'app.freigabe.btn.einmal': 'Einmal erlauben',
    'app.freigabe.btn.sitzung': 'Für diese Sitzung erlauben',
    'app.freigabe.btn.ablehnen': 'Ablehnen',
    'app.freigabe.hinweis': 'Wartet auf deine Entscheidung. Esc lehnt ab.',
    'app.composer.platzhalter': 'Nachricht…',
    'app.composer.modellpille': 'OpenAI · gpt-4o',
    'app.composer.moduspille': 'Intelligent',
    'app.composer.tokens': '12,4 K Tokens',
    'app.composer.tippanimation': 'Prüf die Preise in preise.csv und aktualisiere das Angebot.',

    'zahlen.aria': 'Snotra AI in Zahlen',
    'zahlen.01.label': 'Ordner im Zugriff',
    'zahlen.02.label': 'Modellanbieter',
    'zahlen.03.label': 'Werkzeuge',
    'zahlen.04.label': 'Systeme per CLI',
    'zahlen.04.sr': 'Unbegrenzt viele ',
    'zahlen.05.label': 'Konten',

    'klammer.gross': 'Jede Abteilung ihr Werkzeug. Kein neuer Anbieter.',
    'klammer.klein': 'Der Assistent kommt zu den Dateien, nicht die Dateien zum Assistenten.',

    'saeulen.label': '// vier entscheidungen',
    'saeulen.h2': 'Vier Entscheidungen, die alles andere bestimmen',
    'saeulen.sub': 'Keine Feature-Liste. Was Snotra ausmacht, steckt im Schnitt der Software selbst.',

    'saeule.01.wort': 'Modell',
    'saeule.01.titel': 'Austauschbar, nicht ausgeliefert',
    'saeule.01.absatz1': 'Im Kern sitzt ein Port, kein Anbieter. OpenAI, Anthropic, Google — oder lokal über Ollama und MLX-LM, dann verlässt kein Wort deinen Rechner.',
    'saeule.01.absatz2': 'Du wettest nicht auf die Roadmap eines Konzerns.',
    'saeule.01.demo.caption': '// modell-pille aus dem composer — anklickbar',
    'saeule.01.demo.menu.aria': 'Verfügbare Modelle',
    'saeule.01.demo.tag.lokal': 'lokal',
    'saeule.01.demo.hinweis': 'Fünf Anbieter, ein Port. Zwei davon rechnen auf deinem Rechner.',
    'saeule.01.demo.hinweis.lokal': 'Läuft lokal: kein Wort verlässt deinen Rechner.',
    'saeule.01.demo.hinweis.api': 'Läuft über die API des Anbieters — austauschbar, kein Umbau.',

    'saeule.02.wort': 'Wissen',
    'saeule.02.titel': 'Dein Fachwissen bleibt eine Datei',
    'saeule.02.absatz': 'Ein Skill ist ein Ordner mit einer SKILL.md im offenen Agent-Skills-Format. Versionierbar in Git, lesbar für Menschen, übertragbar auf andere Werkzeuge — kein Datenbankeintrag bei einem Anbieter.',
    'saeule.02.demo.caption': '// ein skill, wie er auf der platte liegt',
    'saeule.02.demo.tree.ordner': '.snotra/skills/angebot/',
    'saeule.02.demo.tree.skillmd': 'SKILL.md',
    'saeule.02.demo.tree.vorlage': 'vorlage-angebot.md',
    'saeule.02.demo.tree.preisliste': 'preisliste.csv',
    'saeule.02.demo.filecard.pfad': '.snotra/skills/angebot/SKILL.md',
    'saeule.02.demo.filecard.badge': 'git-versioniert',
    'saeule.02.demo.skill.name': 'name: angebot',
    'saeule.02.demo.skill.description': 'description: Erstellt Angebote nach Hausvorlage.\n  Verwenden, wenn ein Angebot, ein Nachtrag oder\n  eine Preisauskunft gefragt ist.',
    'saeule.02.demo.skill.h1': '# Angebot erstellen',
    'saeule.02.demo.skill.schritt1': '1. Vorlage aus `vorlage-angebot.md` lesen.',
    'saeule.02.demo.skill.schritt2': '2. Positionen aus `preisliste.csv` ziehen.',
    'saeule.02.demo.skill.schritt3': '3. Rabattstaffel ab 10 Tagen anwenden.',
    'saeule.02.demo.skill.schritt4': '4. Vor dem Schreiben Summe gegenrechnen.',

    'saeule.03.wort': 'Anschluss',
    'saeule.03.titel': 'Verbindet sich mit allem, was schon da ist',
    'saeule.03.absatz': 'Jedes Kommandozeilen-Werkzeug auf deinem Rechner wird zum Werkzeug des Modells — git, docker, az, das CLI deines Hauses. Kein Konnektor, kein Adapter, keine Integrationsprojekte: Ein Skill beschreibt das Werkzeug, den Rest macht die Shell.',
    'saeule.03.badge': 'MCP-Server in Arbeit',
    'saeule.03.demo.caption1': '// tool-log, wie er im chat läuft',
    'saeule.03.demo.summary': '3 Ausführungen · 1 Datei geschrieben',
    'saeule.03.demo.zeile1': 'Befehl „git log --since=1.week --oneline“ ausgeführt',
    'saeule.03.demo.zeile2': 'Befehl „az webapp list -o table“ ausgeführt',
    'saeule.03.demo.zeile3': 'Befehl „docker compose ps“ wird ausgeführt …',
    'saeule.03.demo.caption2': '// was ohne integrationsprojekt schon geht',
    'saeule.03.demo.chip.haus': 'euer-haus-cli',

    'saeule.04.wort': 'Kontrolle',
    'saeule.04.titel': 'Nichts passiert ohne dich',
    'saeule.04.absatz1': 'Jeder schreibende, ausführende oder externe Aufruf kommt vorher als Karte in den Chat: Zielpfad, vollständiger Befehl, Vorschau.',
    'saeule.04.absatz2': 'Für Ausführung gibt es bewusst kein „für diese Sitzung merken“.',
    'saeule.04.badge': 'shell_execute: kommt mit der nächsten Version',
    'saeule.04.demo.caption': '// echte freigabe-karte — entscheide hier',
    'saeule.04.demo.titel': 'Ausführung bestätigen',
    'saeule.04.demo.headline': 'Snotra möchte einen Befehl in zsh ausführen (shell_execute).',
    'saeule.04.demo.fakt.wirkung.label': 'Wirkung',
    'saeule.04.demo.fakt.wirkung.wert': 'Ausführen',
    'saeule.04.demo.fakt.shell.label': 'Shell',
    'saeule.04.demo.fakt.shell.wert': 'zsh (Login-Shell)',
    'saeule.04.demo.fakt.ordner.label': 'Arbeitsordner',
    'saeule.04.demo.fakt.ordner.wert': '~/Projekte/angebote',
    'saeule.04.demo.fakt.grund.label': 'Grund',
    'saeule.04.demo.fakt.grund.wert': 'Stand der Ablage vor dem Schreiben prüfen',
    'saeule.04.demo.fakt.modus.label': 'Modus',
    'saeule.04.demo.fakt.modus.wert': 'Intelligent',
    'saeule.04.demo.warn.fett': 'Achtung: ',
    'saeule.04.demo.warn.text': 'Der Befehl läuft mit deinen Rechten und ist nicht auf den Projektordner begrenzt.',
    'saeule.04.demo.vorschau.summary': 'Vorschau: Befehl',
    'saeule.04.demo.btn.einmal': 'Einmal erlauben',
    'saeule.04.demo.btn.sitzung': 'Für diese Sitzung erlauben',
    'saeule.04.demo.btn.ablehnen': 'Ablehnen',
    'saeule.04.demo.hinweis.einzel': 'Für „Ausführen“ ist nur eine Einzelentscheidung möglich.',
    'saeule.04.demo.hinweis.status': 'Wartet auf deine Entscheidung. Esc lehnt ab.',
    'saeule.04.demo.ergebnis.erlaubt.titel': 'Einmal erlaubt',
    'saeule.04.demo.ergebnis.erlaubt.text': 'Ob der Aufruf gelang, zeigt die Tool-Zeile.',
    'saeule.04.demo.ergebnis.sitzung.titel': 'Für diese Sitzung erlaubt',
    'saeule.04.demo.ergebnis.sitzung.text': 'Gilt bis zum Schließen des Chats.',
    'saeule.04.demo.ergebnis.abgelehnt.titel': 'Abgelehnt',
    'saeule.04.demo.ergebnis.abgelehnt.text': 'Das Modell erhält: „Der Nutzer hat den Aufruf abgelehnt.“',
    'saeule.04.demo.btn.zuruecksetzen': 'Karte zurücksetzen',

    'einsatzfelder.label': '// einsatzfelder',
    'einsatzfelder.h2': 'Vier Abteilungen, dieselbe Werkbank',
    'einsatzfelder.sub': 'Was die App kann, entscheidet der Ordner, auf den sie zeigt — und die Skills, die daneben liegen.',
    'einsatzfeld.buero.titel': 'Büro',
    'einsatzfeld.buero.punkt1': 'Angebote erstellen',
    'einsatzfeld.buero.punkt2': 'Kampagnen planen',
    'einsatzfeld.buero.punkt3': 'Präsentationen vorbereiten',
    'einsatzfeld.hr.titel': 'HR',
    'einsatzfeld.hr.punkt1': 'Stellenausschreibungen',
    'einsatzfeld.hr.punkt2': 'Onboarding-Pakete',
    'einsatzfeld.hr.punkt3': 'Mitarbeiterkommunikation',
    'einsatzfeld.it.titel': 'IT',
    'einsatzfeld.it.punkt1': 'Runbooks',
    'einsatzfeld.it.punkt2': 'Incident-Begleitung',
    'einsatzfeld.it.punkt3': 'Doku-Pflege',
    'einsatzfeld.engineering.titel': 'Engineering',
    'einsatzfeld.engineering.punkt1': 'Projektbezogene Code- und Repo-Assistenz',

    'download.label': '// download',
    'download.h2': 'Version 1.5.1 — kostenlos, quelloffen, ohne Registrierung',
    'download.sub': 'Apache 2.0. Kein Konto, keine Telemetrie, kein Server dazwischen.',
    'download.mac.titel': 'macOS',
    'download.mac.meta': 'Apple Silicon (arm64) · DMG · 126 MB',
    'download.mac.btn': 'DMG laden',
    'download.windows.titel': 'Windows',
    'download.windows.meta': 'x64 · ZIP · 160 MB',
    'download.windows.btn': 'ZIP laden',
    'download.linux.titel': 'Linux',
    'download.linux.meta': 'x64 · DEB · 95 MB',
    'download.linux.btn': 'DEB laden',
    'download.linux.alt': 'DEB empfohlen, auch AppImage und tar.gz vorhanden.',

    'unsigniert.titel': 'Beim ersten Start warnt dein Betriebssystem',
    'unsigniert.absatz': 'Die Builds sind noch nicht signiert — macOS und Windows halten die App deshalb für unbekannt.',
    'unsigniert.macos.titel': 'macOS',
    'unsigniert.macos.schritt1': 'DMG öffnen, App nach Programme ziehen.',
    'unsigniert.macos.schritt2': 'Starten, Meldung wegklicken.',
    'unsigniert.macos.schritt3': 'Systemeinstellungen > Datenschutz & Sicherheit > Trotzdem öffnen.',
    'unsigniert.windows.titel': 'Windows',
    'unsigniert.windows.schritt1': 'ZIP entpacken, Snotra AI.exe starten.',
    'unsigniert.windows.schritt2': 'SmartScreen > Weitere Informationen.',
    'unsigniert.windows.schritt3': 'Trotzdem ausführen.',

    'fuss.copyright': '© 2026 Snotra AI · Apache 2.0',
    'fuss.nav.aria': 'Rechtliches und Quellcode',
    'fuss.impressum': 'Impressum',
    'fuss.datenschutz': 'Datenschutz',
    'fuss.github': 'GitHub'
  };

  var EN = {
    'meta.title': "Snotra AI — Software isn't bought. It's described.",
    'meta.description': "Snotra AI is a desktop app that points at exactly one folder: your know-how stays a file, every CLI on your machine becomes a tool, the model is swappable. No server, no account, no telemetry.",
    'skiplink.text': 'Skip to content',
    'nav.aria': 'Main navigation',
    'nav.lang.aria': 'Sprache / Language',
    'nav.entscheidungen': 'Decisions',
    'nav.einsatzfelder': 'Use cases',
    'nav.download': 'Download',
    'nav.github': 'GitHub',
    'nav.cta': 'Download',

    'hero.eyebrow': 'Desktop app · macOS · Windows · Linux · Apache 2.0 · v1.5.1',
    'hero.h1.zeile1': "Software isn't bought.",
    'hero.h1.zeile2': "It's described.",
    'hero.mission.teil1': "Snotra AI is the bench you do it on: a desktop app that points at exactly one folder. The know-how sits next to it as a text file, the capabilities sit in tools, the model is swappable stock — including for one that runs locally on your own computer. What gets connected is whatever is already there: every CLI on your machine.",
    'hero.mission.betont': 'No server, no account, no telemetry.',
    'hero.cta.primaer': 'Download for macOS — 126 MB',
    'hero.cta.sekundaer': 'Windows & Linux',
    'hero.cta.platform.mac': 'Download for macOS',
    'hero.cta.platform.win': 'Download for Windows',
    'hero.cta.platform.deb': 'Download for Linux',
    'hero.note': 'Version 1.5.1 · open source under Apache 2.0 · no sign-up',
    'hero.appwin.aria': 'Reconstruction of the Snotra AI window: on the left the file tree of the folder “angebote”, in the middle the preview of angebot-q3.md, on the right the chat with tool log, approval card and input field.',
    'hero.stage.caption': 'Placeholder — real screenshot to follow',
    'hero.side.aria': 'Fact sheet',
    'hero.side.version.label': 'Version',
    'hero.side.version.wert': '1.5.1',
    'hero.side.lizenz.label': 'Licence',
    'hero.side.lizenz.wert': 'Apache 2.0',
    'hero.side.plattformen.label': 'Platforms',
    'hero.side.plattformen.wert': 'macOS · Windows · Linux',
    'hero.side.konten.label': 'Accounts',
    'hero.side.konten.wert': '0',
    'hero.side.telemetrie.label': 'Telemetry',
    'hero.side.telemetrie.wert': 'none',

    'app.fenster.brand': 'Snotra AI',
    'app.baum.wurzel': 'angebote',
    'app.baum.docs': 'docs',
    'app.baum.protokoll': 'protokoll.md',
    'app.baum.angebot': 'angebot-q3.md',
    'app.baum.preise': 'preise.csv',
    'app.baum.skills': '.snotra/skills',
    'app.baum.skillmd': 'angebot/SKILL.md',
    'app.baum.readme': 'README.md',
    'app.vorschau.name': 'angebot-q3.md',
    'app.vorschau.meta': 'markdown · 4,1 KB',
    'app.vorschau.h1': '# Angebot Q3 — Migration & Schulung',
    'app.vorschau.stand': 'Stand: 12.09.2026',
    'app.vorschau.ansprechpartnerin': 'Ansprechpartnerin: M. Ehrt-Küver',
    'app.vorschau.h2.offen': '## Offene Punkte',
    'app.vorschau.offen.1': '- Migrationsfenster noch nicht bestätigt',
    'app.vorschau.offen.2': '- Schulungsumfang offen (2 oder 4 Tage)',
    'app.vorschau.offen.3': '- Wartung ab Q1 statt ab Abnahme',
    'app.vorschau.h2.positionen': '## Positionen',
    'app.vorschau.tabelle.kopf': '| Pos | Leistung        | Tage |',
    'app.vorschau.tabelle.zeile1': '| 1   | Migration       |   12 |',
    'app.vorschau.tabelle.zeile2': '| 2   | Schulung        |    4 |',
    'app.chat.titel': 'Angebot Q3 überarbeiten',
    'app.chat.nutzernachricht': 'Fass die offenen Punkte aus docs/protokoll.md ins Angebot ein.',
    'app.chat.toollog.summary': '4 Dateien gelesen · 2 Suchen · 1 Datei geschrieben',
    'app.chat.toollog.zeile1': 'Datei docs/protokoll.md gelesen',
    'app.chat.toollog.zeile2': 'Datei angebot-q3.md wird geschrieben … · wartet auf Freigabe',
    'app.freigabe.titel': 'Änderung bestätigen',
    'app.freigabe.headline': 'Snotra möchte docs/angebot-q3.md ändern (write_file_text).',
    'app.freigabe.fakt.wirkung.label': 'Wirkung',
    'app.freigabe.fakt.wirkung.wert': 'Ändern',
    'app.freigabe.fakt.ziel.label': 'Ziel',
    'app.freigabe.fakt.ziel.wert': 'Datei docs/angebot-q3.md',
    'app.freigabe.fakt.ziel.badge': 'Stand v3',
    'app.freigabe.fakt.grund.label': 'Grund',
    'app.freigabe.fakt.grund.wert': 'Offene Punkte aus dem Protokoll ergänzen',
    'app.freigabe.fakt.modus.label': 'Modus',
    'app.freigabe.fakt.modus.wert': 'Intelligent',
    'app.freigabe.vorschau': '▸ Vorschau: Ersetzung (alt → neu)',
    'app.freigabe.btn.einmal': 'Einmal erlauben',
    'app.freigabe.btn.sitzung': 'Für diese Sitzung erlauben',
    'app.freigabe.btn.ablehnen': 'Ablehnen',
    'app.freigabe.hinweis': 'Wartet auf deine Entscheidung. Esc lehnt ab.',
    'app.composer.platzhalter': 'Nachricht…',
    'app.composer.modellpille': 'OpenAI · gpt-4o',
    'app.composer.moduspille': 'Intelligent',
    'app.composer.tokens': '12,4 K Tokens',
    'app.composer.tippanimation': 'Prüf die Preise in preise.csv und aktualisiere das Angebot.',

    'zahlen.aria': 'Snotra AI in numbers',
    'zahlen.01.label': 'folder in scope',
    'zahlen.02.label': 'model providers',
    'zahlen.03.label': 'tools',
    'zahlen.04.label': 'systems via CLI',
    'zahlen.04.sr': 'Unlimited ',
    'zahlen.05.label': 'accounts',

    'klammer.gross': 'Every department its own tool. No new vendor.',
    'klammer.klein': 'The assistant comes to your files, not your files to the assistant.',

    'saeulen.label': '// four decisions',
    'saeulen.h2': 'Four decisions that determine everything else',
    'saeulen.sub': 'No feature list. What makes Snotra Snotra is in how the software itself is cut.',

    'saeule.01.wort': 'Model',
    'saeule.01.titel': 'Swappable, not beholden',
    'saeule.01.absatz1': "At the core there's a port, not a vendor. OpenAI, Anthropic, Google — or locally via Ollama and MLX-LM, and then not a word leaves your computer.",
    'saeule.01.absatz2': "You're not betting on some corporation's roadmap.",
    'saeule.01.demo.caption': '// model pill from the composer — clickable',
    'saeule.01.demo.menu.aria': 'Available models',
    'saeule.01.demo.tag.lokal': 'local',
    'saeule.01.demo.hinweis': 'Five providers, one port. Two of them compute on your own machine.',
    'saeule.01.demo.hinweis.lokal': 'Runs locally: not a word leaves your computer.',
    'saeule.01.demo.hinweis.api': "Runs through the provider's API — swap it out, nothing to rebuild.",

    'saeule.02.wort': 'Knowledge',
    'saeule.02.titel': 'Your know-how stays a file',
    'saeule.02.absatz': 'A Skill is a folder with a SKILL.md in the open Agent-Skills-Format. Versionable in Git, readable by humans, portable to other tools — not a database row at some vendor.',
    'saeule.02.demo.caption': '// a skill, the way it sits on disk',
    'saeule.02.demo.tree.ordner': '.snotra/skills/offer/',
    'saeule.02.demo.tree.skillmd': 'SKILL.md',
    'saeule.02.demo.tree.vorlage': 'offer-template.md',
    'saeule.02.demo.tree.preisliste': 'price-list.csv',
    'saeule.02.demo.filecard.pfad': '.snotra/skills/offer/SKILL.md',
    'saeule.02.demo.filecard.badge': 'git-versioned',
    'saeule.02.demo.skill.name': 'name: offer',
    'saeule.02.demo.skill.description': 'description: Creates offers from the house template.\n  Use when an offer, a change order or\n  a price enquiry is asked for.',
    'saeule.02.demo.skill.h1': '# Create an offer',
    'saeule.02.demo.skill.schritt1': '1. Read the template from `offer-template.md`.',
    'saeule.02.demo.skill.schritt2': '2. Pull line items from `price-list.csv`.',
    'saeule.02.demo.skill.schritt3': '3. Apply the volume discount from 10 days up.',
    'saeule.02.demo.skill.schritt4': '4. Check the total before writing.',

    'saeule.03.wort': 'Connection',
    'saeule.03.titel': "Connects to everything that's already there",
    'saeule.03.absatz': "Every command-line tool on your machine becomes a tool for the model — git, docker, az, your company's own CLI. No connector, no adapter, no integration projects: a Skill describes the tool, the shell does the rest.",
    'saeule.03.badge': 'MCP server in progress',
    'saeule.03.demo.caption1': '// tool log, the way it runs in the chat',
    'saeule.03.demo.summary': '3 executions · 1 file written',
    'saeule.03.demo.zeile1': 'Ran command “git log --since=1.week --oneline”',
    'saeule.03.demo.zeile2': 'Ran command “az webapp list -o table”',
    'saeule.03.demo.zeile3': 'Running command “docker compose ps” …',
    'saeule.03.demo.caption2': '// what already works without an integration project',
    'saeule.03.demo.chip.haus': 'your-company-cli',

    'saeule.04.wort': 'Control',
    'saeule.04.titel': 'Nothing happens without you',
    'saeule.04.absatz1': 'Every call that writes, executes or reaches outside shows up as a card in the chat first: target path, full command, preview.',
    'saeule.04.absatz2': 'For execution there is deliberately no “remember for this session”.',
    'saeule.04.badge': 'shell_execute: coming in the next version',
    'saeule.04.demo.caption': '// a real approval card — decide here',
    'saeule.04.demo.titel': 'Confirm execution',
    'saeule.04.demo.headline': 'Snotra wants to run a command in zsh (shell_execute).',
    'saeule.04.demo.fakt.wirkung.label': 'Effect',
    'saeule.04.demo.fakt.wirkung.wert': 'Execute',
    'saeule.04.demo.fakt.shell.label': 'Shell',
    'saeule.04.demo.fakt.shell.wert': 'zsh (login shell)',
    'saeule.04.demo.fakt.ordner.label': 'Working folder',
    'saeule.04.demo.fakt.ordner.wert': '~/Projects/offers',
    'saeule.04.demo.fakt.grund.label': 'Reason',
    'saeule.04.demo.fakt.grund.wert': 'Check the state of the folder before writing',
    'saeule.04.demo.fakt.modus.label': 'Mode',
    'saeule.04.demo.fakt.modus.wert': 'Intelligent',
    'saeule.04.demo.warn.fett': 'Careful: ',
    'saeule.04.demo.warn.text': 'The command runs with your permissions and is not limited to the project folder.',
    'saeule.04.demo.vorschau.summary': 'Preview: command',
    'saeule.04.demo.btn.einmal': 'Allow once',
    'saeule.04.demo.btn.sitzung': 'Allow for this session',
    'saeule.04.demo.btn.ablehnen': 'Deny',
    'saeule.04.demo.hinweis.einzel': 'For “Execute”, only a one-off decision is possible.',
    'saeule.04.demo.hinweis.status': 'Waiting for your decision. Esc denies.',
    'saeule.04.demo.ergebnis.erlaubt.titel': 'Allowed once',
    'saeule.04.demo.ergebnis.erlaubt.text': 'The tool line shows whether the call succeeded.',
    'saeule.04.demo.ergebnis.sitzung.titel': 'Allowed for this session',
    'saeule.04.demo.ergebnis.sitzung.text': 'Valid until the chat is closed.',
    'saeule.04.demo.ergebnis.abgelehnt.titel': 'Denied',
    'saeule.04.demo.ergebnis.abgelehnt.text': 'The model receives: “The user denied the call.”',
    'saeule.04.demo.btn.zuruecksetzen': 'Reset card',

    'einsatzfelder.label': '// use cases',
    'einsatzfelder.h2': 'Four departments, the same bench',
    'einsatzfelder.sub': 'What the app can do is decided by the folder it points at — and by the Skills lying next to it.',
    'einsatzfeld.buero.titel': 'Office',
    'einsatzfeld.buero.punkt1': 'Writing offers',
    'einsatzfeld.buero.punkt2': 'Planning campaigns',
    'einsatzfeld.buero.punkt3': 'Preparing presentations',
    'einsatzfeld.hr.titel': 'HR',
    'einsatzfeld.hr.punkt1': 'Job postings',
    'einsatzfeld.hr.punkt2': 'Onboarding packs',
    'einsatzfeld.hr.punkt3': 'Internal comms',
    'einsatzfeld.it.titel': 'IT',
    'einsatzfeld.it.punkt1': 'Runbooks',
    'einsatzfeld.it.punkt2': 'Incident support',
    'einsatzfeld.it.punkt3': 'Keeping docs current',
    'einsatzfeld.engineering.titel': 'Engineering',
    'einsatzfeld.engineering.punkt1': 'Project-scoped code and repo assistance',

    'download.label': '// download',
    'download.h2': 'Version 1.5.1 — free, open source, no sign-up',
    'download.sub': 'Apache 2.0. No account, no telemetry, no server in between.',
    'download.mac.titel': 'macOS',
    'download.mac.meta': 'Apple Silicon (arm64) · DMG · 126 MB',
    'download.mac.btn': 'Download DMG',
    'download.windows.titel': 'Windows',
    'download.windows.meta': 'x64 · ZIP · 160 MB',
    'download.windows.btn': 'Download ZIP',
    'download.linux.titel': 'Linux',
    'download.linux.meta': 'x64 · DEB · 95 MB',
    'download.linux.btn': 'Download DEB',
    'download.linux.alt': 'DEB recommended; AppImage and tar.gz are available too.',

    'unsigniert.titel': 'Your operating system will warn you on first launch',
    'unsigniert.absatz': "The builds aren't signed yet — so macOS and Windows treat the app as unknown.",
    'unsigniert.macos.titel': 'macOS',
    'unsigniert.macos.schritt1': 'Open the DMG, drag the app into Applications.',
    'unsigniert.macos.schritt2': 'Launch it, dismiss the warning.',
    'unsigniert.macos.schritt3': 'System Settings > Privacy & Security > Open Anyway.',
    'unsigniert.windows.titel': 'Windows',
    'unsigniert.windows.schritt1': 'Unzip, then start Snotra AI.exe.',
    'unsigniert.windows.schritt2': 'SmartScreen > More info.',
    'unsigniert.windows.schritt3': 'Run anyway.',

    'fuss.copyright': '© 2026 Snotra AI · Apache 2.0',
    'fuss.nav.aria': 'Legal and source code',
    'fuss.impressum': 'Legal notice',
    'fuss.datenschutz': 'Privacy',
    'fuss.github': 'GitHub'
  };

  var DICT = { de: DE, en: EN };

  /* ======================================================================
     2. Kleine Helfer
     ====================================================================== */
  var doc = document;
  function each(sel, fn, root) {
    Array.prototype.forEach.call((root || doc).querySelectorAll(sel), fn);
  }
  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) { /* Privatmodus o. Ae. — die Seite kommt auch ohne aus */ }
    return null;
  }

  var state = {
    lang: 'de',
    version: null,
    sizes: {},
    urls: {},
    platform: null,
    modelHintKey: 'saeule.01.demo.hinweis',
    typed: false,
    decisions: {}
  };

  function t(key) {
    var d = DICT[state.lang] || DE;
    return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : (DE[key] !== undefined ? DE[key] : key);
  }

  /* ======================================================================
     3. Sprachumschaltung
     Reihenfolge der Sprachwahl: ?lang= > gemerkte Wahl > navigator.language
     > Deutsch. Der deutsche Text steht vollstaendig im HTML, ohne JS aendert
     sich also nichts ausser dem fehlenden Umschalter-Zustand.
     ====================================================================== */
  var DECO_GLYPH = /^(\/\/|▸|▾)\s*/;

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function markCode(el, tokens) {
    var text = el.textContent;
    var parts = tokens.split('|').filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (!parts.length) return;
    var re = new RegExp('(' + parts.map(escapeRe).join('|') + ')', 'g');
    var frag = doc.createDocumentFragment();
    var last = 0, m, hit = false;
    while ((m = re.exec(text)) !== null) {
      var before = text.charAt(m.index - 1);
      var after = text.charAt(m.index + m[0].length);
      if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
      if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      var span = doc.createElement('span');
      span.className = 'inline-code';
      span.textContent = m[0];
      frag.appendChild(span);
      last = m.index + m[0].length;
      hit = true;
    }
    if (!hit) return;
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    el.textContent = '';
    el.appendChild(frag);
  }

  function setText(el, value) {
    /* YAML-Zeile: der Schluessel bis zum ersten Doppelpunkt bleibt blau. */
    if (el.hasAttribute('data-i18n-yaml')) {
      var idx = value.indexOf(':');
      el.textContent = '';
      if (idx > -1) {
        var k = doc.createElement('span');
        k.className = 'k';
        k.textContent = value.slice(0, idx + 1);
        el.appendChild(k);
        el.appendChild(doc.createTextNode(value.slice(idx + 1)));
      } else {
        el.textContent = value;
      }
      return;
    }
    /* Zierzeichen (// bzw. Chevron) stehen als eigenes aria-hidden-Element im
       Markup und bleiben stehen; aus dem Text werden sie entfernt, damit sie
       nicht vorgelesen werden. */
    var deco = el.querySelector(':scope > .deco');
    if (deco) {
      var rest = value.replace(DECO_GLYPH, '');
      while (deco.nextSibling) el.removeChild(deco.nextSibling);
      el.appendChild(doc.createTextNode(rest));
    } else {
      el.textContent = value;
    }
    var codes = el.getAttribute('data-i18n-code');
    if (codes) markCode(el, codes);
  }

  function applyLang(lang, opts) {
    state.lang = DICT[lang] ? lang : 'de';
    doc.documentElement.lang = state.lang;

    each('[data-i18n]', function (el) { setText(el, t(el.getAttribute('data-i18n'))); });

    each('[data-i18n-attr]', function (el) {
      el.getAttribute('data-i18n-attr').split(';').forEach(function (pair) {
        var bits = pair.split(':');
        if (bits.length < 2) return;
        el.setAttribute(bits[0].trim(), t(bits.slice(1).join(':').trim()));
      });
    });

    each('.lang-btn', function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-lang') === state.lang ? 'true' : 'false');
    });

    afterApply();

    if (!opts || !opts.silent) {
      store('snotra-lang', state.lang);
      try {
        var url = new URL(window.location.href);
        url.searchParams.set('lang', state.lang);
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch (e) { /* aeltere Browser: die Wahl steht dann nur im Speicher */ }
    }
  }

  /* Stellen, die nach dem Uebersetzen einen Zustand zurueckbekommen muessen. */
  function afterApply() {
    var hint = doc.getElementById('model-hint');
    if (hint) setText(hint, t(state.modelHintKey));

    var comp = doc.getElementById('composer-demo');
    if (comp && state.typed) {
      comp.classList.remove('ph');
      comp.textContent = t('app.composer.tippanimation');
    }

    each('.approval[data-demo]', function (card) {
      var kind = state.decisions[card.getAttribute('data-demo')];
      if (kind) renderResult(card, kind, false);
    });

    applyRelease();
  }

  function pickLang() {
    var fromUrl = null;
    try {
      fromUrl = new URL(window.location.href).searchParams.get('lang');
    } catch (e) {
      var m = /[?&]lang=([^&]+)/.exec(window.location.search);
      fromUrl = m ? decodeURIComponent(m[1]) : null;
    }
    if (fromUrl && DICT[fromUrl.toLowerCase()]) return fromUrl.toLowerCase();

    var saved = store('snotra-lang');
    if (saved && DICT[saved]) return saved;

    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    if (/^en\b/i.test(nav)) return 'en';
    return 'de';
  }

  each('.lang-btn', function (btn) {
    btn.addEventListener('click', function () {
      applyLang(btn.getAttribute('data-lang'));
      btn.focus();
    });
  });

  /* ======================================================================
     4. Download-Ziele aus dem letzten GitHub-Release
     Die Asset-Namen tragen die Version (Snotra-AI-1.5.1-mac-arm64.dmg),
     /releases/latest/download/<name> funktioniert damit nicht. Faellt der
     Aufruf aus (Rate-Limit, Blocker, kein Netz), bleiben die im HTML
     hinterlegten Links auf .../releases/latest stehen.
     ====================================================================== */
  var REPO = 'kkrafft1999/snotra';
  var DEFAULT_SIZES = { mac: '126 MB', win: '160 MB', deb: '95 MB' };
  var TARGETS = [
    { key: 'mac', test: function (n) { return /-mac-arm64\.dmg$/.test(n); } },
    { key: 'win', test: function (n) { return /-win-x64\.zip$/.test(n); } },
    { key: 'deb', test: function (n) { return /\.deb$/.test(n); } },
    { key: 'appimage', test: function (n) { return /\.AppImage$/.test(n); } },
    { key: 'targz', test: function (n) { return /\.tar\.gz$/.test(n); } }
  ];

  function detectPlatform() {
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var ua = navigator.userAgent || '';
    if (/Mac/i.test(p) || /Mac OS X/i.test(ua)) return 'mac';
    if (/Win/i.test(p) || /Windows/i.test(ua)) return 'win';
    if (/Linux|X11/i.test(p) || /Linux/i.test(ua)) return 'deb';
    return null;
  }
  state.platform = detectPlatform();

  function applyRelease() {
    if (state.version) {
      each('[data-version]', function (el) {
        el.textContent = el.textContent.replace(/1\.5\.1/g, state.version);
      });
    }
    each('[data-size]', function (el) {
      var size = state.sizes[el.getAttribute('data-size')];
      if (size) el.textContent = el.textContent.replace(/\d+(?:[.,]\d+)?\s?MB/, size);
    });
    each('[data-dl]', function (el) {
      var url = state.urls[el.getAttribute('data-dl')];
      if (url) el.href = url;
    });

    /* Hero-Knopf: beschriftet sich nach der Plattform des Besuchers. */
    var hero = doc.getElementById('hero-cta');
    if (hero && state.platform) {
      var key = state.platform;
      var size = state.sizes[key] || DEFAULT_SIZES[key];
      hero.textContent = t('hero.cta.platform.' + key) + (size ? ' — ' + size : '');
      if (state.urls[key]) hero.href = state.urls[key];
    }
  }

  function readRelease(release) {
    var version = (release.tag_name || '').replace(/^v/, '');
    if (version) state.version = version;
    (release.assets || []).forEach(function (asset) {
      for (var i = 0; i < TARGETS.length; i++) {
        if (TARGETS[i].test(asset.name) && !state.urls[TARGETS[i].key]) {
          state.urls[TARGETS[i].key] = asset.browser_download_url;
          state.sizes[TARGETS[i].key] = Math.round(asset.size / 1048576) + ' MB';
          return;
        }
      }
    });
    applyRelease();
  }

  if (window.fetch) {
    window.fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(readRelease).catch(function () { /* Fallback: Links bleiben stehen */ });
  }

  /* ======================================================================
     5. Bewegung — Einstellung wird auch nachtraeglich befolgt
     ====================================================================== */
  var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  var reduced = mq.matches;
  if (mq.addEventListener) {
    mq.addEventListener('change', function (ev) { reduced = ev.matches; });
  } else if (mq.addListener) {
    mq.addListener(function (ev) { reduced = ev.matches; });
  }

  /* ---- Reveal beim Scrollen ---- */
  var revealables = doc.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(revealables, function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    Array.prototype.forEach.call(revealables, function (el) { io.observe(el); });
    window.setTimeout(function () {
      Array.prototype.forEach.call(revealables, function (el) { el.classList.add('is-in'); });
    }, 2500);
  }

  /* ---- Zahlenzeile: hochzaehlen ---- */
  var counters = doc.querySelectorAll('[data-count]');
  if (!reduced && 'IntersectionObserver' in window) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target, target = parseInt(el.getAttribute('data-count'), 10);
        cio.unobserve(el);
        if (!target) { el.textContent = String(target); return; }
        var start = null, dur = 700;
        function step(ts) {
          if (start === null) start = ts;
          var p = Math.min(1, (ts - start) / dur);
          el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
          if (p < 1) window.requestAnimationFrame(step);
        }
        window.requestAnimationFrame(step);
      });
    }, { threshold: 0.6 });
    Array.prototype.forEach.call(counters, function (el) { cio.observe(el); });
  }

  /* ---- Composer: Schreibmaschine ----
     Bei reduzierter Bewegung wird nicht der Inhalt weggelassen, sondern nur
     die Bewegung: der Satz steht dann sofort da. */
  var comp = doc.getElementById('composer-demo');
  if (comp) {
    if (reduced) {
      state.typed = true;
      comp.classList.remove('ph');
      comp.textContent = t('app.composer.tippanimation');
    } else {
      var started = false;
      var type = function () {
        var text = t('app.composer.tippanimation');
        var i = 0;
        var tick = function () {
          i += 1;
          comp.classList.remove('ph');
          comp.textContent = text.slice(0, i);
          if (i < text.length) {
            var caret = doc.createElement('span');
            caret.className = 'caret';
            comp.appendChild(caret);
            window.setTimeout(tick, 34 + Math.random() * 40);
          } else {
            state.typed = true;   /* Cursor am Ende entfernen: nichts blinkt dauerhaft */
          }
        };
        window.setTimeout(tick, 900);
      };
      var startWhenVisible = function () {
        if (started) return;
        started = true;
        type();
      };
      if ('IntersectionObserver' in window) {
        var tio = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { if (e.isIntersecting) { startWhenVisible(); tio.disconnect(); } });
        }, { threshold: 0.25 });
        tio.observe(comp);
        /* Sicherheitsnetz wie beim Reveal: meldet sich der Beobachter nicht
           (verdeckte Render-Kontexte, alte WebKit-Versionen), stuende im
           Eingabefeld sonst dauerhaft nur der Platzhalter. */
        window.setTimeout(startWhenVisible, 3000);
      } else { startWhenVisible(); }
    }
  }

  /* ---- Shimmer stilllegen ----
     Der laufende Tool-Text schimmert wie in der App, aber nicht endlos: nach
     rund drei Durchlaeufen steht er still und wieder auf vollem Kontrast. */
  if (!reduced) {
    window.setTimeout(function () {
      each('.tool-line--running', function (el) { el.classList.add('tool-line--settled'); });
    }, 5600);
  }

  /* ======================================================================
     6. Modell-Pille mit Overlay-Menue (ARIA-Menu-Button)
     ====================================================================== */
  var pill = doc.getElementById('model-pill');
  var menu = doc.getElementById('model-menu');
  var pillLabel = doc.getElementById('model-pill-label');
  if (pill && menu) {
    var items = function () { return Array.prototype.slice.call(menu.querySelectorAll('button[data-model]')); };

    var openMenu = function (open, focusItem) {
      menu.hidden = !open;
      pill.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        var list = items();
        var current = list.filter(function (b) { return b.getAttribute('aria-checked') === 'true'; })[0];
        if (focusItem !== false) (current || list[0]).focus();
      }
    };

    var choose = function (btn) {
      pillLabel.textContent = btn.getAttribute('data-model');
      items().forEach(function (b) { b.setAttribute('aria-checked', b === btn ? 'true' : 'false'); });
      state.modelHintKey = btn.hasAttribute('data-local')
        ? 'saeule.01.demo.hinweis.lokal'
        : 'saeule.01.demo.hinweis.api';
      var hint = doc.getElementById('model-hint');
      if (hint) setText(hint, t(state.modelHintKey));
      openMenu(false);
      pill.focus();
    };

    pill.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openMenu(menu.hidden);
    });

    pill.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        openMenu(true);
      }
    });

    menu.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button[data-model]') : null;
      if (btn) { ev.stopPropagation(); choose(btn); }
    });

    menu.addEventListener('keydown', function (ev) {
      var list = items();
      var idx = list.indexOf(doc.activeElement);
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        list[(idx + 1 + list.length) % list.length].focus();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        list[(idx - 1 + list.length) % list.length].focus();
      } else if (ev.key === 'Home') {
        ev.preventDefault(); list[0].focus();
      } else if (ev.key === 'End') {
        ev.preventDefault(); list[list.length - 1].focus();
      } else if (ev.key === 'Tab') {
        openMenu(false);
      }
    });

    doc.addEventListener('click', function () { if (!menu.hidden) openMenu(false); });
    doc.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !menu.hidden) { openMenu(false); pill.focus(); }
    });
  }

  /* ======================================================================
     7. Freigabe-Karte: echte Entscheidung
     Das Ergebnis wird in die Live-Region geschrieben (nicht daneben), und der
     Fokus wandert auf den neuen Knopf — sonst faellt er beim Entfernen des
     geklickten Knopfes auf den Seitenanfang zurueck.
     ====================================================================== */
  var RESULT_KEYS = {
    allowed: ['saeule.04.demo.ergebnis.erlaubt.titel', 'saeule.04.demo.ergebnis.erlaubt.text'],
    session: ['saeule.04.demo.ergebnis.sitzung.titel', 'saeule.04.demo.ergebnis.sitzung.text'],
    denied: ['saeule.04.demo.ergebnis.abgelehnt.titel', 'saeule.04.demo.ergebnis.abgelehnt.text']
  };

  function renderResult(card, kind, moveFocus) {
    var actions = card.querySelector('.approval-actions');
    var status = card.querySelector('[data-role="status"]');
    if (!actions || !status) return;
    var keys = RESULT_KEYS[kind];
    card.setAttribute('data-state', kind === 'denied' ? 'denied' : 'allowed');
    actions.textContent = '';
    status.textContent = '';

    var p = doc.createElement('p');
    p.className = 'approval-result';
    var b = doc.createElement('b');
    b.textContent = t(keys[0]);
    p.appendChild(b);
    p.appendChild(doc.createTextNode(' ' + t(keys[1])));
    status.appendChild(p);

    var replay = doc.createElement('button');
    replay.type = 'button';
    replay.className = 'approval-replay';
    replay.textContent = t('saeule.04.demo.btn.zuruecksetzen');
    replay.addEventListener('click', function () { resetCard(card); });
    actions.appendChild(replay);

    if (moveFocus) replay.focus();
  }

  var cardTemplates = {};

  function resetCard(card) {
    var id = card.getAttribute('data-demo');
    var tpl = cardTemplates[id];
    delete state.decisions[id];
    card.setAttribute('data-state', 'pending');
    var actions = card.querySelector('.approval-actions');
    actions.innerHTML = tpl.actions;
    /* Die Knoepfe kommen aus dem HTML-Original, also auf Deutsch — nach dem
       Wiederherstellen muessen sie erneut uebersetzt werden. */
    each('[data-i18n]', function (el) { setText(el, t(el.getAttribute('data-i18n'))); }, actions);
    var status = card.querySelector('[data-role="status"]');
    status.textContent = '';
    setText(status, t('saeule.04.demo.hinweis.status'));
    bindCard(card);
    var first = card.querySelector('.approval-actions button:not([disabled])');
    if (first) first.focus();
  }

  function bindCard(card) {
    each('button[data-decision]', function (btn) {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        state.decisions[card.getAttribute('data-demo')] = btn.getAttribute('data-decision');
        renderResult(card, btn.getAttribute('data-decision'), true);
      });
    }, card.querySelector('.approval-actions'));
  }

  each('.approval[data-demo]', function (card) {
    cardTemplates[card.getAttribute('data-demo')] = {
      actions: card.querySelector('.approval-actions').innerHTML
    };
    bindCard(card);
    card.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && card.getAttribute('data-state') === 'pending') {
        ev.stopPropagation();
        state.decisions[card.getAttribute('data-demo')] = 'denied';
        renderResult(card, 'denied', true);
      }
    });
  });

  /* ======================================================================
     8. Orientierung: aktiver Abschnitt und aktive Saeule
     ====================================================================== */
  if ('IntersectionObserver' in window) {
    var navLinks = Array.prototype.slice.call(doc.querySelectorAll('.head-nav a[href^="#"]'));
    var navTargets = navLinks.map(function (a) {
      var href = a.getAttribute('href');
      return href.length > 1 ? doc.querySelector(href) : null;
    });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        navLinks.forEach(function (a, i) {
          if (navTargets[i] === e.target) a.setAttribute('aria-current', 'true');
          else a.removeAttribute('aria-current');
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    navTargets.forEach(function (target) { if (target) spy.observe(target); });

    var pillarEls = doc.querySelectorAll('.pillar');
    if (pillarEls.length) {
      var pio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          Array.prototype.forEach.call(pillarEls, function (p) {
            p.classList.toggle('is-current', p === e.target);
          });
        });
      }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
      Array.prototype.forEach.call(pillarEls, function (p) { pio.observe(p); });
    }
  }

  /* ======================================================================
     9. Start
     ====================================================================== */
  applyLang(pickLang(), { silent: false });
})();
