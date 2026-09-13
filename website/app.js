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

  /* Das Inline-Script im <head> hat .reveal versteckt und einen Not-Timer
     gestellt, der den Inhalt nach 2,5 s auch ohne uns zeigt. Wir sind da —
     Timer abbestellen, das Skript uebernimmt. */
  window.clearTimeout(window.__snotraReveal);

  /* ======================================================================
     1. Woerterbuecher
     ====================================================================== */
  var DE = {
    'meta.title': 'Snotra AI — Fachwissen wird nicht programmiert. Es wird beschrieben.',
    'meta.description': "Snotra AI ist eine Desktop-App, die auf genau einen Ordner zeigt: Dein Fachwissen bleibt eine Datei, das Modell ist austauschbar, angebunden wird, was ohnehin da ist. Kein Server, kein Konto, keine Telemetrie. Quelloffen für macOS, Windows und Linux.",
    'skiplink.text': 'Zum Inhalt springen',
    'nav.aria': 'Hauptnavigation',
    'nav.lang.aria': 'Sprache / Language',
    'nav.entscheidungen': 'Entscheidungen',
    'nav.einsatzfelder': 'Einsatzfelder',
    'nav.download': 'Download',
    'nav.github': 'GitHub',
    'nav.cta': 'Herunterladen',

    'hero.eyebrow': 'Desktop-App · macOS · Windows · Linux · Apache 2.0 · v1.5.1',
    'hero.h1.zeile1': 'Fachwissen wird nicht programmiert.',
    'hero.h1.zeile2': 'Es wird beschrieben.',
    'hero.mission.teil1': 'Snotra AI ist die Werkbank dafür: eine Desktop-App, die auf genau einen Ordner zeigt. Das Fachwissen liegt als Textdatei daneben, die Fähigkeiten stecken in Werkzeugen, das Modell ist austauschbare Ware — auch gegen eines, das lokal auf deinem Rechner läuft. Angebunden wird, was ohnehin da ist: jedes CLI auf deiner Maschine.',
    'hero.mission.betont': 'Kein eigener Server, kein Konto, keine Telemetrie.',
    'hero.cta.primaer': 'Für macOS laden — 127 MB',
    'hero.cta.sekundaer': 'Windows & Linux',
    'hero.cta.platform.mac': 'Für macOS laden',
    'hero.cta.platform.win': 'Für Windows laden',
    'hero.cta.platform.deb': 'Für Linux laden',
    'hero.note': 'Version 1.5.1 · quelloffen unter Apache 2.0 · keine Registrierung',
    'hero.appwin.aria': 'Nachbau des Snotra-AI-Fensters: links der Dateibaum des Ordners angebote, in der Mitte die Vorschau von angebot-q3.md, rechts der Chat mit Tool-Log, Freigabe-Karte und Eingabefeld.',
    'hero.stage.caption': 'Die Oberfläche der App, maßgetreu in HTML nachgebaut',
    /* „keine“ stimmt: es gehen keine Nutzungsdaten raus. Die App fragt beim
       Start aber bei GitHub nach einer neueren Version — eine Verbindung, also
       gehoert sie an die absolute Stelle dazu. */

    'app.fenster.brand': 'Snotra AI',
    'app.baum.wurzel': 'angebote',
    'app.baum.docs': 'docs',
    'app.baum.protokoll': 'protokoll.md',
    'app.baum.angebot': 'angebot-q3.md',
    'app.baum.preise': 'preise.csv',
    'app.baum.skills': '.agents/skills',
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

    'klammer.gross': 'Jede Abteilung ihr Werkzeug. Aus dem, was schon da ist.',
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
    'saeule.02.demo.tree.ordner': '.agents/skills/angebot/',
    'saeule.02.demo.tree.skillmd': 'SKILL.md',
    'saeule.02.demo.tree.vorlage': 'vorlage-angebot.md',
    'saeule.02.demo.tree.preisliste': 'preisliste.csv',
    'saeule.02.demo.filecard.pfad': '.agents/skills/angebot/SKILL.md',
    'saeule.02.demo.filecard.badge': 'git-versioniert',
    'saeule.02.demo.filecard.aria': 'Inhalt von SKILL.md',
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
    'saeule.03.demo.caption1': '// tool-log, wie er im chat läuft',
    'saeule.03.demo.summary': '3 Ausführungen · 1 Datei geschrieben',
    'saeule.03.demo.zeile1': 'Befehl „git log --since=1.week --oneline“ ausgeführt',
    'saeule.03.demo.zeile2': 'Befehl „az webapp list -o table“ ausgeführt',
    'saeule.03.demo.zeile3': 'Befehl „docker compose ps“ wird ausgeführt …',
    'saeule.03.demo.caption2': '// was ein einziger skill erreicht — ohne integrationsprojekt',
    'saeule.03.demo.chip.haus': 'euer-haus-cli',

    'saeule.04.wort': 'Kontrolle',
    'saeule.04.titel': 'Nichts passiert ohne dich',
    'saeule.04.absatz1': 'Jeder schreibende, ausführende oder externe Aufruf kommt vorher als Karte in den Chat: Zielpfad, vollständiger Befehl, Vorschau.',
    'saeule.04.absatz2': 'Für Ausführung gibt es bewusst kein „für diese Sitzung merken“.',
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
    'download.sub': 'Apache 2.0. Kein Konto, keine Telemetrie, kein eigener Server dazwischen — geladen wird direkt bei GitHub.',
    'download.mac.titel': 'macOS',
    'download.mac.meta': 'Apple Silicon (arm64) · DMG · 127 MB',
    'download.mac.btn': 'DMG laden',
    'download.windows.titel': 'Windows',
    'download.windows.meta': 'x64 · ZIP · 161 MB',
    'download.windows.btn': 'ZIP laden',
    'download.linux.titel': 'Linux',
    'download.linux.meta': 'x64 · DEB · 96 MB',
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
    'fuss.github': 'GitHub',

    /* ---- Rechtsseiten (impressum.html, datenschutz.html) ----
       Beide Seiten binden dieses Skript ein und haengen an derselben
       Umschaltung wie die Startseite. Die Platzhalter (Anschrift, E-Mail)
       stehen als <span class="todo"> im HTML und werden hier bewusst nicht
       uebersetzt — sie sind keine Sprache, sondern eine offene Angabe. */
    'legal.nav.aria': 'Seiten und Sprache',
    'legal.fuss.aria': 'Rechtliches',
    'legal.nav.start': 'Startseite',
    'legal.zurueck': '\u2190 Zur\u00fcck zur Startseite',
    'legal.land': 'Deutschland',
    'legal.mail.label': 'E-Mail:',
    'legal.apache.link': 'Apache-Lizenz 2.0',

    'impressum.meta.title': 'Impressum \u2014 Snotra AI',
    'impressum.h1': 'Impressum',
    'impressum.angaben.h2': 'Angaben gem\u00e4\u00df \u00a7 5 DDG',
    'impressum.kontakt.h2': 'Kontakt',
    'impressum.verantwortlich.h2': 'Verantwortlich f\u00fcr den Inhalt nach \u00a7 18 Abs. 2 MStV',
    'impressum.verantwortlich.text': 'Konrad Krafft, Anschrift wie oben',
    'impressum.angebot.h2': 'Art des Angebots',
    'impressum.angebot.teil1': 'Snotra AI ist ein privates, nicht kommerzielles Hobby- und Experimentier-Projekt. Es wird keine entgeltliche Leistung angeboten; die Software steht quelloffen unter der',
    'impressum.angebot.teil2': ' zur Verf\u00fcgung. Ein Zusammenhang mit dem Arbeitgeber des Betreibers besteht nicht.',
    'impressum.haftung.inhalte.h2': 'Haftung f\u00fcr Inhalte',
    'impressum.haftung.inhalte.text': 'Als Diensteanbieter sind wir f\u00fcr eigene Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich. Wir sind als Diensteanbieter jedoch nicht verpflichtet, \u00fcbermittelte oder gespeicherte fremde Informationen zu \u00fcberwachen oder nach Umst\u00e4nden zu forschen, die auf eine rechtswidrige T\u00e4tigkeit hinweisen. Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den allgemeinen Gesetzen bleiben hiervon unber\u00fchrt. Eine diesbez\u00fcgliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung m\u00f6glich. Bei Bekanntwerden entsprechender Rechtsverletzungen werden wir diese Inhalte umgehend entfernen.',
    'impressum.haftung.links.h2': 'Haftung f\u00fcr Links',
    'impressum.haftung.links.text': 'Unser Angebot enth\u00e4lt Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Deshalb k\u00f6nnen wir f\u00fcr diese fremden Inhalte auch keine Gew\u00e4hr \u00fcbernehmen. F\u00fcr die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter oder Betreiber der Seiten verantwortlich. Die verlinkten Seiten wurden zum Zeitpunkt der Verlinkung auf m\u00f6gliche Rechtsverst\u00f6\u00dfe \u00fcberpr\u00fcft; rechtswidrige Inhalte waren zum Zeitpunkt der Verlinkung nicht erkennbar. Bei Bekanntwerden von Rechtsverletzungen werden wir derartige Links umgehend entfernen.',
    'impressum.urheberrecht.h2': 'Urheberrecht',
    'impressum.urheberrecht.text': 'Die Inhalte dieser Seite unterliegen dem deutschen Urheberrecht. Der Quellcode der Software Snotra AI steht abweichend davon unter der Apache-Lizenz 2.0 und darf im Rahmen dieser Lizenz genutzt, ver\u00e4ndert und weitergegeben werden.',
    'impressum.streit.h2': 'Verbraucherstreitbeilegung',
    'impressum.streit.text': 'Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.',

    'datenschutz.meta.title': 'Datenschutzerkl\u00e4rung \u2014 Snotra AI',
    'datenschutz.h1': 'Datenschutzerkl\u00e4rung',
    'datenschutz.1.h2': '1. Verantwortlicher',
    'datenschutz.1.einleitung': 'Verantwortlich f\u00fcr die Datenverarbeitung auf dieser Website ist:',
    'datenschutz.1.dsb': 'Ein Datenschutzbeauftragter ist nicht bestellt; die gesetzlichen Voraussetzungen daf\u00fcr liegen bei diesem privaten Angebot nicht vor.',
    'datenschutz.2.h2': '2. Kurzfassung',
    'datenschutz.2.teil1': 'Diese Seite ist eine reine Informationsseite. Es gibt',
    'datenschutz.2.betont': 'keine Cookies',
    'datenschutz.2.teil2': ', keine Analyse- oder Tracking-Dienste, keine Werbenetzwerke, kein Kontaktformular, keine Anmeldung und keine Schriftarten von fremden Servern. Es werden nur die Daten verarbeitet, die beim Abruf einer Website technisch zwangsl\u00e4ufig anfallen \u2014 sowie eine Anfrage an die GitHub-API, um die aktuelle Programmversion anzuzeigen (Abschnitt 4). Deine Sprachwahl legt der Browser lokal ab (localStorage); sie verlässt dein Gerät nicht.',
    'datenschutz.3.h2': '3. Hosting und Server-Logfiles',
    'datenschutz.3.teil1': 'Die Website wird bei',
    'datenschutz.3.betont': 'Firebase Hosting',
    'datenschutz.3.teil2': ' betrieben, einem Dienst der Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland. Beim Abruf der Seite verarbeitet der Hoster in Server-Logfiles automatisch Daten, die dein Browser \u00fcbermittelt:',
    'datenschutz.3.liste.1': 'IP-Adresse des anfragenden Ger\u00e4ts',
    'datenschutz.3.liste.2': 'Datum und Uhrzeit des Zugriffs',
    'datenschutz.3.liste.3': 'Name und URL der abgerufenen Datei',
    'datenschutz.3.liste.4': '\u00fcbertragene Datenmenge und Meldung \u00fcber den Erfolg des Abrufs',
    'datenschutz.3.liste.5': 'Browsertyp und -version, Betriebssystem',
    'datenschutz.3.liste.6': 'gegebenenfalls die zuvor besuchte Seite (Referrer)',
    'datenschutz.3.rechtsgrundlage': 'Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in der technisch fehlerfreien Auslieferung und der Sicherheit der Website. Eine Zusammenf\u00fchrung dieser Daten mit anderen Datenquellen findet nicht statt; eine Auswertung zu Marketingzwecken erfolgt nicht.',
    'datenschutz.3.avv': 'Mit Google besteht ein Vertrag \u00fcber die Auftragsverarbeitung nach Art. 28 DSGVO. Eine Verarbeitung in den USA durch die Google LLC l\u00e4sst sich nicht ausschlie\u00dfen; Google st\u00fctzt solche \u00dcbermittlungen auf die Standardvertragsklauseln der EU-Kommission und ist unter dem EU-US Data Privacy Framework zertifiziert. Weitere Informationen:',
    'datenschutz.4.h2': '4. Abruf der aktuellen Version von GitHub',
    'datenschutz.4.teil1': 'Damit die Download-Kn\u00f6pfe immer auf die neueste Programmversion zeigen, ruft dein Browser beim \u00d6ffnen der Startseite einmalig die Schnittstelle',
    'datenschutz.4.teil2': ' auf. Anbieter ist die GitHub B.V., Vijzelstraat 68-72, 1017 HL Amsterdam, Niederlande (Tochterunternehmen der Microsoft Corporation, USA).',
    'datenschutz.4.ip': 'Dabei wird deine IP-Adresse an GitHub \u00fcbermittelt; ohne diese \u00dcbermittlung ist eine Verbindung technisch nicht m\u00f6glich. Es werden keine Cookies gesetzt und keine Kennungen von uns mitgegeben. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse besteht darin, aktuelle und funktionierende Download-Verweise anzubieten, ohne die Seite bei jeder neuen Version neu zu ver\u00f6ffentlichen. Datenschutzerkl\u00e4rung von GitHub:',
    'datenschutz.4.releases': 'Dasselbe gilt, wenn du einen Download startest oder einem Link ins Repository folgst: Die Installationspakete liegen bei GitHub Releases und werden von dort ausgeliefert, nicht von dieser Website.',
    'datenschutz.5.h2': '5. Speicherdauer',
    'datenschutz.5.text': 'Die Server-Logfiles des Hosters werden nach dessen Vorgaben automatisch gel\u00f6scht. Eigene Datenbest\u00e4nde \u00fcber Besucher legen wir nicht an.',
    'datenschutz.6.h2': '6. Die Software selbst',
    'datenschutz.6.teil1': 'Die Desktop-Anwendung Snotra AI sendet',
    'datenschutz.6.betont': 'keine',
    'datenschutz.6.teil2': ' Daten an den Betreiber dieser Website: Es gibt keine Telemetrie, keine Nutzungsstatistik und keine Registrierung. Beim Start fragt sie einmal bei GitHub nach, ob eine neuere Version vorliegt; dabei gehen keine Nutzungsdaten mit. Deine Eingaben gehen an den Modellanbieter, den du in der App selbst ausw\u00e4hlst und konfigurierst (etwa OpenAI, Anthropic oder Google) \u2014 oder bei lokalen Modellen \u00fcber Ollama bzw. MLX-LM gar nicht erst aus deinem Rechner heraus. Nutzt das Modell mit deiner Freigabe die Websuche, geht die Suchanfrage zus\u00e4tzlich an Tavily (nur mit hinterlegtem Schl\u00fcssel); beim Seitenabruf ruft die App die genannte Adresse unmittelbar auf. F\u00fcr die Verarbeitung durch den von dir gew\u00e4hlten Anbieter gilt dessen Datenschutzerkl\u00e4rung. API-Schl\u00fcssel werden verschl\u00fcsselt im Benutzerprofil deines Betriebssystems abgelegt.',
    'datenschutz.7.h2': '7. Deine Rechte',
    'datenschutz.7.text1': 'Du hast im Rahmen der gesetzlichen Voraussetzungen das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), L\u00f6schung (Art. 17), Einschr\u00e4nkung der Verarbeitung (Art. 18), Daten\u00fcbertragbarkeit (Art. 20) sowie das Recht, einer Verarbeitung auf Grundlage berechtigter Interessen zu widersprechen (Art. 21 DSGVO). Wende dich daf\u00fcr an die oben genannte Adresse.',
    'datenschutz.7.text2': 'Au\u00dferdem steht dir ein Beschwerderecht bei einer Datenschutz-Aufsichtsbeh\u00f6rde zu (Art. 77 DSGVO), etwa bei der f\u00fcr deinen Wohnsitz zust\u00e4ndigen Landesbeh\u00f6rde.',
    'datenschutz.8.h2': '8. Verschl\u00fcsselung',
    'datenschutz.8.teil1': 'Diese Seite ist ausschlie\u00dflich \u00fcber HTTPS erreichbar; die Domain-Endung',
    'datenschutz.8.teil2': ' erzwingt eine verschl\u00fcsselte Verbindung. Das Zertifikat stellt der Hoster automatisch aus.',
    'datenschutz.9.h2': '9. \u00c4nderungen',
    'datenschutz.9.text': 'Wird das Angebot erweitert, passen wir diese Erkl\u00e4rung an. Es gilt jeweils die hier ver\u00f6ffentlichte Fassung.'
  };

  var EN = {
    'meta.title': "Snotra AI — Expertise isn't programmed. It's described.",
    'meta.description': "Snotra AI is a desktop app that points at exactly one folder: your know-how stays a file, the model is swappable, and what gets connected is whatever is already there. No server, no account, no telemetry. Open source for macOS, Windows and Linux.",
    'skiplink.text': 'Skip to content',
    'nav.aria': 'Main navigation',
    'nav.lang.aria': 'Sprache / Language',
    'nav.entscheidungen': 'Decisions',
    'nav.einsatzfelder': 'Use cases',
    'nav.download': 'Download',
    'nav.github': 'GitHub',
    'nav.cta': 'Download',

    'hero.eyebrow': 'Desktop app · macOS · Windows · Linux · Apache 2.0 · v1.5.1',
    'hero.h1.zeile1': "Expertise isn't programmed.",
    'hero.h1.zeile2': "It's described.",
    'hero.mission.teil1': "Snotra AI is the bench you do it on: a desktop app that points at exactly one folder. The know-how sits next to it as a text file, the capabilities sit in tools, and the model is a commodity you can swap out — including for one that runs locally on your own machine. What gets connected is whatever is already there: every CLI on your machine.",
    'hero.mission.betont': 'No server of ours, no account, no telemetry.',
    'hero.cta.primaer': 'Download for macOS — 127 MB',
    'hero.cta.sekundaer': 'Windows & Linux',
    'hero.cta.platform.mac': 'Download for macOS',
    'hero.cta.platform.win': 'Download for Windows',
    'hero.cta.platform.deb': 'Download for Linux',
    'hero.note': 'Version 1.5.1 · open source under Apache 2.0 · no sign-up',
    'hero.appwin.aria': 'Reconstruction of the Snotra AI window: on the left the file tree of the folder “angebote”, in the middle the preview of angebot-q3.md, on the right the chat with tool log, approval card and input field.',
    'hero.stage.caption': 'The interface, rebuilt in HTML — the app ships with a German interface',

    /* ACHTUNG, keine vergessene Arbeit: Der gesamte app.*-Block steht hier
       absichtlich auf Deutsch. Die Anwendung hat genau eine Oberflaeche, und
       die ist deutsch — ein uebersetztes Fenster waere eine Behauptung ueber
       ein Produkt, das es so nicht gibt. Das Fenster traegt dafuer lang="de",
       und die Bildunterschrift (hero.stage.caption) sagt es im englischen
       Modus im Klartext. Wenn die App eine englische Oberflaeche bekommt,
       werden diese Werte uebersetzt — vorher nicht. */
    'app.fenster.brand': 'Snotra AI',
    'app.baum.wurzel': 'angebote',
    'app.baum.docs': 'docs',
    'app.baum.protokoll': 'protokoll.md',
    'app.baum.angebot': 'angebot-q3.md',
    'app.baum.preise': 'preise.csv',
    'app.baum.skills': '.agents/skills',
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

    'klammer.gross': "Every department its own tool. Built from what's already there.",
    'klammer.klein': 'The assistant comes to your files, not your files to the assistant.',

    'saeulen.label': '// four decisions',
    'saeulen.h2': 'Four decisions that determine everything else',
    'saeulen.sub': 'No feature list. What makes Snotra Snotra is in how the software is put together.',

    'saeule.01.wort': 'Model',
    'saeule.01.titel': 'Swappable, not beholden',
    'saeule.01.absatz1': "At the core there's a port, not a vendor. OpenAI, Anthropic, Google — or locally via Ollama and MLX-LM, and then not a word leaves your computer.",
    'saeule.01.absatz2': "You're not betting on some corporation's roadmap.",
    'saeule.01.demo.caption': '// model pill from the composer — clickable',
    'saeule.01.demo.menu.aria': 'Available models',
    'saeule.01.demo.tag.lokal': 'local',
    'saeule.01.demo.hinweis': 'Five providers, one port. Two of them run on your own machine.',
    'saeule.01.demo.hinweis.lokal': 'Runs locally: not a word leaves your computer.',
    'saeule.01.demo.hinweis.api': "Runs through the provider's API — swap it out, nothing to rebuild.",

    'saeule.02.wort': 'Knowledge',
    'saeule.02.titel': 'Your know-how stays a file',
    'saeule.02.absatz': 'A Skill is a folder with a SKILL.md in the open Agent Skills format. Versionable in Git, readable by humans, portable to other tools — not a database row at some vendor.',
    'saeule.02.demo.caption': '// a skill, the way it sits on disk',
    'saeule.02.demo.tree.ordner': '.agents/skills/offer/',
    'saeule.02.demo.tree.skillmd': 'SKILL.md',
    'saeule.02.demo.tree.vorlage': 'offer-template.md',
    'saeule.02.demo.tree.preisliste': 'price-list.csv',
    'saeule.02.demo.filecard.pfad': '.agents/skills/offer/SKILL.md',
    'saeule.02.demo.filecard.badge': 'git-versioned',
    'saeule.02.demo.filecard.aria': 'Contents of SKILL.md',
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
    'saeule.03.demo.caption1': '// tool log, the way it runs in the chat',
    'saeule.03.demo.summary': '3 executions · 1 file written',
    'saeule.03.demo.zeile1': 'Ran command “git log --since=1.week --oneline”',
    'saeule.03.demo.zeile2': 'Ran command “az webapp list -o table”',
    'saeule.03.demo.zeile3': 'Running command “docker compose ps” …',
    'saeule.03.demo.caption2': '// what a single Skill reaches, with no integration project',
    'saeule.03.demo.chip.haus': 'your-company-cli',

    'saeule.04.wort': 'Control',
    'saeule.04.titel': 'Nothing happens without you',
    'saeule.04.absatz1': 'Every call that writes, executes or reaches outside shows up as a card in the chat first: target path, full command, preview.',
    'saeule.04.absatz2': 'For execution there is deliberately no “remember for this session”.',
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
    'download.sub': 'Apache 2.0. No account, no telemetry, no server of ours in between — the download comes straight from GitHub.',
    'download.mac.titel': 'macOS',
    'download.mac.meta': 'Apple Silicon (arm64) · DMG · 127 MB',
    'download.mac.btn': 'Download DMG',
    'download.windows.titel': 'Windows',
    'download.windows.meta': 'x64 · ZIP · 161 MB',
    'download.windows.btn': 'Download ZIP',
    'download.linux.titel': 'Linux',
    'download.linux.meta': 'x64 · DEB · 96 MB',
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
    'fuss.github': 'GitHub',

    /* ---- Legal pages (impressum.html, datenschutz.html) ----
       Fully translated. The placeholders (address, contact e-mail) stay as
       <span class="todo"> in the HTML and are deliberately not translated:
       they are missing data, not language. German law applies to the original
       German wording — the English version is a reading aid. */
    'legal.nav.aria': 'Pages and language',
    'legal.fuss.aria': 'Legal',
    'legal.nav.start': 'Home',
    'legal.zurueck': '\u2190 Back to the home page',
    'legal.land': 'Germany',
    'legal.mail.label': 'E-mail:',
    'legal.apache.link': 'Apache License 2.0',

    'impressum.meta.title': 'Legal notice \u2014 Snotra AI',
    'impressum.h1': 'Legal notice',
    'impressum.angaben.h2': 'Information pursuant to \u00a7 5 DDG (German Digital Services Act)',
    'impressum.kontakt.h2': 'Contact',
    'impressum.verantwortlich.h2': 'Responsible for the content pursuant to \u00a7 18 (2) MStV',
    'impressum.verantwortlich.text': 'Konrad Krafft, address as above',
    'impressum.angebot.h2': 'Nature of this offering',
    'impressum.angebot.teil1': 'Snotra AI is a private, non-commercial hobby and experimentation project. No paid service is offered; the software is open source under the',
    'impressum.angebot.teil2': '. There is no connection to the operator\u2019s employer.',
    'impressum.haftung.inhalte.h2': 'Liability for content',
    'impressum.haftung.inhalte.text': 'As a service provider we are responsible for our own content on these pages under the general laws. As a service provider we are not obliged, however, to monitor transmitted or stored third-party information or to investigate circumstances that indicate unlawful activity. Obligations to remove or block the use of information under the general laws remain unaffected. Liability in this respect is only possible from the point in time at which a concrete infringement becomes known. If we become aware of such infringements, we will remove the content in question without delay.',
    'impressum.haftung.links.h2': 'Liability for links',
    'impressum.haftung.links.text': 'Our offering contains links to external third-party websites over whose content we have no influence. We can therefore accept no liability for that third-party content. The respective provider or operator of the linked pages is always responsible for their content. The linked pages were checked for possible legal violations at the time of linking; unlawful content was not discernible at that time. If we become aware of infringements, we will remove such links without delay.',
    'impressum.urheberrecht.h2': 'Copyright',
    'impressum.urheberrecht.text': 'The content of this site is subject to German copyright law. The source code of the Snotra AI software is, by way of exception, licensed under the Apache License 2.0 and may be used, modified and redistributed within the terms of that licence.',
    'impressum.streit.h2': 'Consumer dispute resolution',
    'impressum.streit.text': 'We are neither willing nor obliged to take part in dispute resolution proceedings before a consumer arbitration board.',

    'datenschutz.meta.title': 'Privacy policy \u2014 Snotra AI',
    'datenschutz.h1': 'Privacy policy',
    'datenschutz.1.h2': '1. Controller',
    'datenschutz.1.einleitung': 'The controller for data processing on this website is:',
    'datenschutz.1.dsb': 'No data protection officer has been appointed; the statutory conditions for that do not apply to this private offering.',
    'datenschutz.2.h2': '2. In short',
    'datenschutz.2.teil1': 'This site is purely informational. There are',
    'datenschutz.2.betont': 'no cookies',
    'datenschutz.2.teil2': ', no analytics or tracking services, no ad networks, no contact form, no sign-up and no fonts from third-party servers. The only data processed is what inevitably arises for technical reasons when a website is requested \u2014 plus one request to the GitHub API in order to show the current program version (section 4). Your language choice is kept locally by the browser (localStorage); it never leaves your device.',
    'datenschutz.3.h2': '3. Hosting and server log files',
    'datenschutz.3.teil1': 'The website is hosted on',
    'datenschutz.3.betont': 'Firebase Hosting',
    'datenschutz.3.teil2': ', a service of Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Ireland. When the page is requested, the host automatically processes data in server log files that your browser transmits:',
    'datenschutz.3.liste.1': 'IP address of the requesting device',
    'datenschutz.3.liste.2': 'date and time of access',
    'datenschutz.3.liste.3': 'name and URL of the file requested',
    'datenschutz.3.liste.4': 'volume of data transferred and notification of whether the request succeeded',
    'datenschutz.3.liste.5': 'browser type and version, operating system',
    'datenschutz.3.liste.6': 'where applicable, the page visited before (referrer)',
    'datenschutz.3.rechtsgrundlage': 'The legal basis is Art. 6(1)(f) GDPR. The legitimate interest lies in delivering the website free of technical faults and keeping it secure. This data is not merged with other data sources, and it is not evaluated for marketing purposes.',
    'datenschutz.3.avv': 'A data processing agreement pursuant to Art. 28 GDPR is in place with Google. Processing in the USA by Google LLC cannot be ruled out; Google bases such transfers on the European Commission\u2019s standard contractual clauses and is certified under the EU-US Data Privacy Framework. Further information:',
    'datenschutz.4.h2': '4. Fetching the current version from GitHub',
    'datenschutz.4.teil1': 'So that the download buttons always point at the latest program version, your browser calls the interface',
    'datenschutz.4.teil2': ' once when the home page opens. The provider is GitHub B.V., Vijzelstraat 68-72, 1017 HL Amsterdam, Netherlands (a subsidiary of Microsoft Corporation, USA).',
    'datenschutz.4.ip': 'Your IP address is transmitted to GitHub in the process; without that transmission no connection is technically possible. No cookies are set and no identifiers are passed on by us. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is to offer current, working download links without republishing the page for every new version. GitHub\u2019s privacy statement:',
    'datenschutz.4.releases': 'The same applies when you start a download or follow a link into the repository: the installation packages are held at GitHub Releases and are delivered from there, not by this website.',
    'datenschutz.5.h2': '5. Retention period',
    'datenschutz.5.text': 'The host\u2019s server log files are deleted automatically according to its own rules. We do not keep any records of our own about visitors.',
    'datenschutz.6.h2': '6. The software itself',
    'datenschutz.6.teil1': 'The Snotra AI desktop application sends',
    'datenschutz.6.betont': 'no',
    'datenschutz.6.teil2': ' data to the operator of this website: there is no telemetry, no usage statistics and no registration. At launch it asks GitHub once whether a newer version exists; no usage data travels with that request. What you type goes to the model provider you select and configure in the app yourself (OpenAI, Anthropic or Google, for example) \u2014 or, with local models via Ollama or MLX-LM, never leaves your machine at all. If the model uses web search with your approval, the query also goes to Tavily (only with a key of your own on file); for page retrieval the app calls the given address directly. The privacy policy of the provider you choose governs their processing. API keys are stored encrypted in your operating system\u2019s user profile.',
    'datenschutz.7.h2': '7. Your rights',
    'datenschutz.7.text1': 'Within the statutory conditions you have the right of access (Art. 15 GDPR), rectification (Art. 16), erasure (Art. 17), restriction of processing (Art. 18), data portability (Art. 20) and the right to object to processing based on legitimate interests (Art. 21 GDPR). Please contact the address given above.',
    'datenschutz.7.text2': 'You also have the right to lodge a complaint with a data protection supervisory authority (Art. 77 GDPR), for instance the authority responsible for your place of residence.',
    'datenschutz.8.h2': '8. Encryption',
    'datenschutz.8.teil1': 'This site is available exclusively over HTTPS; the domain ending',
    'datenschutz.8.teil2': ' enforces an encrypted connection. The certificate is issued automatically by the host.',
    'datenschutz.9.h2': '9. Changes',
    'datenschutz.9.text': 'If the offering is extended, we will adapt this policy. The version published here applies in each case.'
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
    var decoEl = el.querySelector(':scope > .deco');
    var text = decoEl ? el.textContent.slice(decoEl.textContent.length) : el.textContent;
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
      var span = doc.createElement('code');
      span.className = 'inline-code';
      span.textContent = m[0];
      frag.appendChild(span);
      last = m.index + m[0].length;
      hit = true;
    }
    if (!hit) return;
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    /* Nicht das ganze Element leeren: traegt es ein Zierzeichen (:scope >
       .deco), wuerde das hier stillschweigend mit verschwinden. Heute faellt
       kein Element in beide Faelle — die Absicherung steht fuer den naechsten,
       der einem .demo-cap ein data-i18n-code gibt. */
    var deco = el.querySelector(':scope > .deco');
    if (deco) {
      while (deco.nextSibling) el.removeChild(deco.nextSibling);
    } else {
      el.textContent = '';
    }
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

  /* Das canonical-Element muss die Adresse nennen, die im Adressfeld steht.
     Frueher richtete es sich nach der gewaehlten Sprache statt nach der URL,
     und applyLang schrieb beim Laden ausserdem immer ein ?lang= in die
     Adresse. Wer den Zustand zwischen beiden Schritten sah — Crawler,
     Lighthouse — fand Adresse und canonical im Widerspruch (Issue #113). */
  function syncCanonical() {
    var can = doc.querySelector('link[rel="canonical"]');
    if (!can) return;
    try {
      var url = new URL(window.location.href);
      /* Der Host bleibt fest verdrahtet: Die Seite ist auch ueber
         snotra-ai.web.app erreichbar, und von dort soll das canonical weiter
         auf die eigene Domain zeigen. Nur Pfad und Abfrage kommen aus dem
         Adressfeld. */
      can.setAttribute('href', 'https://snotra-ai.dev' + url.pathname + url.search);
    } catch (e) { /* aeltere Browser: das ausgelieferte canonical bleibt stehen */ }
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
        /* Deutsch ist die Vorgabe und steht auch in hreflang ohne Parameter;
           ein ?lang=de waere nur eine zweite Adresse fuer dieselbe Seite. */
        if (state.lang === 'de') url.searchParams.delete('lang');
        else url.searchParams.set('lang', state.lang);
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch (e) { /* aeltere Browser: die Wahl steht dann nur im Speicher */ }
    }

    syncCanonical();
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
  var DEFAULT_SIZES = { mac: '127 MB', win: '161 MB', deb: '96 MB' };
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

  /* Nur dort fragen, wo es etwas zu aktualisieren gibt: die Rechtsseiten
     binden dasselbe Skript ein, haben aber keine Download-Knoepfe — und die
     Datenschutzerklaerung sagt zu, dass der Aufruf auf der Startseite
     passiert. Ohne diese Bedingung waere sie unwahr. */
  if (window.fetch && doc.querySelector('[data-dl]')) {
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
        /* Erst den Fokus auf den Ausloeser zuruecknehmen, dann verstecken —
           sonst rechnet der Browser den naechsten Tabstopp von einem
           versteckten Element aus und landet auf document.body. Kein
           preventDefault: die Standard-Tab-Aktion laeuft von der Pille aus
           weiter (und mit Shift genauso rueckwaerts). */
        pill.focus();
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
  /* silent: Die automatisch erkannte Sprache ist keine Wahl des Besuchers —
     sie gehoert weder in die Adresse noch in den Speicher. Erst ein Klick auf
     DE/EN schreibt beides. */
  applyLang(pickLang(), { silent: true });
})();
