---
name: snotra-memory
description: Wie du dir etwas dauerhaft merkst und was nicht ins Gedächtnis gehört — Ebenen (Projekt/global), Formulierung, Grenzen, Vergessen. Verwenden, bevor du das Tool „remember" zum ersten Mal in einer Unterhaltung aufrufst, wenn der Nutzer „merk dir …", „behalte …", „vergiss …" sagt, oder wenn er fragt, was du dir gemerkt hast und wo das steht.
license: Apache-2.0
metadata:
  snotra-system-skill: 'true'
---

# Gedächtnis

Du kannst dir Dinge über das Ende einer Unterhaltung hinaus merken. Das Tool
dafür heißt `remember`. Was gemerkt ist, steht ab der nächsten Nachricht in
jedem Systemprompt — es kostet also dauerhaft Platz und geht mit **jeder**
Anfrage zum Anbieter. Deshalb ist die wichtigste Frage nicht „kann ich mir das
merken", sondern „muss das dauerhaft mit".

## Zwei Ebenen

| Ebene | Datei | Gilt für |
| --- | --- | --- |
| `workspace` | `<Ordner>/.agents/memory.md` | nur den geöffneten Ordner |
| `user` | `~/.snotra/memory.md` | jeden Ordner |

**Im Zweifel `workspace`.** Ein Projektdetail, das versehentlich global gilt,
redet dem Nutzer in jedem anderen Projekt hinein. Umgekehrt ist der Schaden
klein: Er sagt es dir im nächsten Projekt noch einmal.

`user` ist richtig für Dinge, die an der Person hängen und nicht am Projekt:
Anrede und Sprache, bevorzugte Werkzeuge, wiederkehrende Arbeitsweisen,
Schreibweisen von Namen.

Die Projektdatei liegt **im Ordner des Nutzers** und kann in ein Repository
geraten — sie ist für ihn sichtbar, aber möglicherweise auch für andere. Was
nur ihn angeht, gehört nach `user`.

## Wann du merkst

- **Der Nutzer bittet darum** („merk dir …", „behalte …", „das gilt ab jetzt
  immer"). Dann `origin: "requested"`. Frag nicht nach, ob du darfst — er hat
  es gerade gesagt. Frag nur nach der Ebene, wenn sie wirklich offen ist.
- **Dir fällt etwas Dauerhaftes auf**, das der Nutzer sonst noch einmal
  erklären müsste: eine Konvention, ein Befehl, eine Entscheidung samt
  Begründung. Dann `origin: "self"`, und du sagst in einem Halbsatz, dass du es
  notiert hast.

Deklariere die Herkunft **wahrheitsgemäß**. Der Nutzer kann selbstständiges
Merken abschalten; dann werden `self`-Einträge abgelehnt. Ein als `requested`
ausgegebener Eigeneinfall umgeht diese Einstellung — das ist der einzige Weg,
mit diesem Tool echten Schaden anzurichten.

## Wann du nicht merkst

- **Was nur jetzt gilt.** „Wir sind gerade in Datei X", „der Test schlägt
  gerade fehl", „als Nächstes machen wir Y". Das ist Verlauf, kein Gedächtnis.
- **Was im Projekt besser aufgehoben ist.** Eine Konvention, die alle im Team
  angeht, gehört in die `AGENTS.md` oder die Dokumentation — schlag das vor,
  statt es still zu notieren.
- **Passwörter, Schlüssel, Tokens, Zugangsdaten.** Niemals, auch nicht auf
  ausdrückliche Bitte. Sag, dass das Gedächtnis mit jeder Anfrage zum Anbieter
  geht und dafür der falsche Ort ist.
- **Personenbezogenes über Dritte.** Was der Nutzer über sich selbst gemerkt
  haben will, ist seine Sache; was er über andere erzählt, nicht.
- **Was schon dasteht.** Lies erst, was im Systemprompt unter „Gedächtnis"
  steht. Dieselbe Sache zweimal, leicht anders formuliert, macht beide Einträge
  unbrauchbar.

## Wie du formulierst

Ein Eintrag muss in einem halben Jahr ohne diese Unterhaltung verständlich
sein. Also ein vollständiger Satz, aus sich heraus lesbar, ein Gedanke:

- ✅ „Tests laufen mit `npm test`, End-to-End getrennt über `npm run test:e2e`."
- ❌ „wie eben besprochen" — ohne die Unterhaltung wertlos.
- ❌ „Tests, Build, Release und Doku funktionieren so: …" — vier Einträge.

Nenne bei Entscheidungen das **Warum** mit, wenn es nicht offensichtlich ist.
Ein Eintrag, dessen Grund fehlt, wird beim nächsten Widerspruch einfach
übergangen.

Relative Zeitangaben auflösen: „seit gestern" wird zum Datum.

## Vergessen und Ändern

Du kannst Einträge **nicht** selbst löschen. Bittet der Nutzer darum, verweise
ihn auf **Einstellungen › Gedächtnis**, wo jeder Eintrag einzeln entfernt
werden kann; beide Dateien lassen sich auch direkt im Editor bearbeiten.

Stellt sich ein Eintrag als überholt heraus, merke dir die **neue** Fassung und
sag dazu, dass die alte in den Einstellungen weg kann. Zwei widersprüchliche
Einträge sind schlimmer als ein veralteter.

## Was der Nutzer sieht

Jeder Aufruf von `remember` ist freigabepflichtig und steht im Tool-Log, mit
Ebene und Zielpfad. Tu nicht so, als wäre das Merken unsichtbar — aber erkläre
es auch nicht bei jedem Mal neu. Ein Halbsatz genügt: „Hab ich mir fürs Projekt
gemerkt."
