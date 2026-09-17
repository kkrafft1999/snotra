---
# Nur bei Arbeit an Renderer-/Style-Dateien laden. `paths` ist der
# dokumentierte Key; `globs` zusätzlich, weil laut anthropics/claude-code#17204
# in manchen Versionen nur `globs` greift. Unbekannte Keys werden ignoriert.
paths:
  - "src/renderer/**/*.html"
  - "src/renderer/**/*.js"
  - "**/*.css"
  - "**/*.scss"
globs: "src/renderer/**/*.html, src/renderer/**/*.js, **/*.css, **/*.scss"
---

# UI-Design-Tokens (doubleSlash Mono-Blue)

Du arbeitest im doubleSlash Mono-Blue System für Snotra AI. Halte dich strikt an die hier definierten Tokens, Komponenten-Specs und Workflow-Regeln. Funktionalität, State, Routing und Datenfluss bleiben bei Refactors unverändert — du veränderst ausschließlich UI-Tokens, Styles und Layout-Patterns.

## Token-Architektur

Es gibt **zwei Token-Ebenen**:

1. **Single Source of Truth — `renderer/styles/tokens.css`**
   Enthält alle Marken- und Design-System-Werte (Farben, Typografie, Radien, Motion, Button-Farben) als CSS-Variablen. Wird in `renderer/index.html` **vor** `styles.css` geladen.
2. **Komponenten-Aliase — `renderer/styles.css`**
   Mappt komponentennahe Namen (`--btn-primary-bg`, `--btn-radius`, …) auf die Design-Tokens oder definiert komponentenspezifische Geometrie (Padding, Radius, Transition).

**Neue Design-Tokens** (Farben, Status, neue Button-Variante, Spacing-Stufe …) gehören in `renderer/styles/tokens.css`, mit Light-Wert in `:root` und ggf. Dark-Wert in `[data-theme='dark']`. In `styles.css` darf zusätzlich ein semantischer Alias (`--btn-…`, `--accent-…`) angelegt werden, der auf das Token mappt — **niemals** Hex-Werte direkt in Komponenten.

## Tokens

### Farben

In `tokens.css` sind dies die Kanalnamen (Light-Werte in `:root`, Dark in `[data-theme='dark']`):

| Token | Light (Auszug) | Zweck |
|---|---|---|
| `--ds-blue` | `#00759E` | einzige Akzentfarbe |
| `--ds-blue-soft` | `rgba(0,117,158,0.05)` | Hover-Wash, aktive Radio-States |
| `--ds-blue-border` | `rgba(0,117,158,0.25)` | Active-State Borders |
| `--ds-black` | `#000000` | Primär-Schrift, Destructive-Aktion |
| `--ds-white` | `#FFFFFF` | **nur Tinte**: Schrift auf Blau, Häkchen, Toggle-Knob |
| `--ds-surface` | `#FFFCF5` | primäre Fläche (Karten, Dialoge, Composer) |
| `--ds-grey-bg` | `#F9F4ED` | Page-BG, Footer-BG |
| `--ds-grey-card` | `#F2EDE6` | Code-BG, Inline-Code |
| `--ds-grey-divider` | `#EFEAE3` | Borders, Trennlinien |
| `--ds-grey-muted` | `#6F6D69` | Sekundär-Schrift, Metadaten (nur ≥ 14 px) |
| `--ds-grey-strong` | `#5E5C59` | kleinere Sekundärschrift (< 14 px) |
| `--ds-btn-primary-*` | siehe `tokens.css` | Primary/Save/Send: BG, FG, Hover, Active-Schatten |

Die drei Grautoene sind **warm getoent** (b\* +4, R-B-Spanne 12). Bis zum
2026-09-17 war der Satz leicht kuehl, damit die Grauflaechen den Blau-Hue von
`--ds-blue` aufnehmen; diese Regel ist bewusst **umgedreht**. Der Grund ist
jetzt Papier, `--ds-blue` ist der einzige kuehle Ton im System — dadurch wird
es als Akzent gelesen und nicht als Grundstimmung. Wer die Waerme zurueckdreht,
dreht diese Entscheidung mit zurueck; keine Einzelwerte anfassen.

Die Skala selbst ist unveraendert: Der Helligkeitsabstand Grund → Card betraegt
ΔL\* 2,44, Grund → Divider ΔL\* 3,49. Verschoben wurden ausschliesslich a\* und
b\*, **nie L\***. **Wer einen der drei Werte aendert, muss die anderen beiden
mitziehen** — sonst brechen die Ebenenabstaende.

Reines Weiss ist keine Flaeche mehr. `--ds-surface` sitzt bei L\* 99,0 statt
100, weil warm *und* L\* 100 nicht gleichzeitig geht — auf warmem Grund liest
`#FFFFFF` als kuehler, fast blaeulicher Fleck. Der Preis sind kleinere
Ebenenabstaende: Flaeche → Panel-Grund ΔL\* 2,62 (vorher 2,79), Flaeche →
Chat-Grund ΔL\* 1,23 (vorher 1,43). Untergrenze fuer den Panel-Grund ist
`#F6F1EA`; darunter fallen `--ds-grey-muted` und `--ds-blue` unter 4,6:1 und
verlieren jeden Kontrastpuffer.

### Typografie

- Inter: **400** (Body), **500** (CTA, Chips, Sekundär-Button), **600** (Headlines, Pills, App-Brand), **700** (Welcome-Hero). Keine Italic, keine extrem leichten/schweren Display-Weights.
- Mono: `ui-monospace, 'SF Mono', Menlo, Consolas, monospace`
- `font-variant-numeric: tabular-nums` für Zahlen in Tabellen und Timing.

### Radius

- Container (Card, Dialog, Input, Select, Code-Block): **6px**
- Text-Buttons, Pills, Toggles, Avatar, Live-Dot, Radio: **999px**
- Icon-Buttons **32×32** (Send, Mic): in der App **`border-radius: 50%`** (Kreis).
- Mantra: *Klickbar oder Status → rund (bzw. Kreis bei quadratischen Icons). Container → 6px.*

## Komponenten-Specs

### Buttons

Text-Buttons (`.btn-primary`, `.btn-secondary`) mit `border-radius: 999px`, Padding 8/18px. Vier Varianten:

- **Primary**: BG `--ds-btn-primary-bg` (`--ds-blue`), Text `--ds-btn-primary-fg`. Hover: BG `--ds-btn-primary-bg-hover` (dunkleres Blau, nicht Schwarz). `:active`: dezentes `box-shadow` über `--ds-btn-primary-active-shadow`. CSS-Klasse `.btn-primary` für die wichtigste Aktion eines Dialogs (z. B. „Speichern & aktivieren"). Send-Icon-Button teilt dieselben Primary-Tokens.
- **Secondary**: BG transparent/`--bg-primary`, Border `--ds-grey-divider`, Text Primärfarbe. Hover: Border `--ds-grey-muted` (neutral, nicht einladend). CSS-Klasse `.btn-secondary` _oder_ einfach ein `<button>` ohne `.btn-primary` innerhalb von `.modal-actions`. Für Begleitaktionen (z. B. „Schließen", „Anbieter zurücksetzen", „Modelle laden").
- **Destructive**: BG `--ds-black`, Text `--ds-white`. Hover: BG `--ds-grey-muted`. **Im Regelfall keine rote Farbe** — destruktive Wirkung über Schwarz. Rot nur bei wirklich kritischer, unwiederbringlicher Aktion (siehe Ausnahmeregel unten).
- **Icon-Button**: 32×32, `border-radius: 50%`, kein BG, Hover-BG `--ds-grey-bg`. `:active`: `--ds-icon-btn-active-shadow`. Pflicht: `aria-label`.

**Niemals** Inline-Farben für Buttons setzen — immer Tokens nutzen, sonst bricht der Dark-Mode.

### Chips & Card-artige Hover-Items (einladender Hover)

Container-artige interaktive Elemente, die zur Auswahl _einladen_ (Quick-Action-Chips, Recent-Folder-Chips, Radio-Rows mit Card-Form, Welcome-CTA), nutzen ein **anderes Hover-Pattern** als `.btn-secondary`:

- Default: Border `--ds-grey-divider`, transparenter oder weißer BG.
- **Hover**: Border `--ds-blue` + BG `--ds-blue-soft` (5%-Wash). Signal: „klickbar, hier passiert etwas Sinnvolles".
- Aktiv (z. B. Radio gewählt): wie Hover-State.

Das ist die einzige erlaubte Hover-Variante mit `--ds-blue` als Border-Farbe — sie wirkt einladend, weil `--ds-blue-soft` einen sehr sanften Wash legt. `.btn-secondary` bleibt bewusst neutral (`--ds-grey-muted`), um nicht mit der Primary-Aktion zu konkurrieren.

### Form-Controls

- **Text-Input / Textarea**: Border `--ds-grey-divider`, Radius 6px, Padding 9/12px. Focus: Border `--ds-blue`, kein Outline (der globale `:focus-visible`-Ring aus `styles.css` gilt zusätzlich).
- **Select**: wie Input + Custom-Chevron via Background-SVG in `--ds-grey-muted`.
- **Toggle-Switch**: 40×22, BG `--ds-grey-divider`, weißer Knob 16×16. Aktiv: BG `--ds-blue`. ARIA: `role="switch"` + `aria-checked`.
- **Radio**: 16×16, custom via `appearance: none`. Border `--ds-grey-muted`, im `:checked` Border + Inner-Dot in `--ds-blue`. Wrapper-Row mit `:has(input:checked)` zusätzlich Border + `--ds-blue-soft` BG.
- **Checkbox**: quadratisch mit 4px Radius (klassische Konvention). Aktiv: `--ds-blue` mit weißem Häkchen.

### Dialoge & Modals

- Backdrop: `rgba(0,0,0,0.5)`, Padding 56/32px.
- Dialog: max-width 480px, BG `--ds-surface`, Border `--ds-grey-divider`, Radius 6px.
- Header: Padding 16/24px, Title 16px/600, Close-Icon-Button rechts. Border-bottom `--ds-grey-divider`.
- Body: Padding 4/24/16px. Form-Rows mit Border-bottom zwischen Sections.
- Footer: Padding 14/20px, BG `--ds-grey-bg`, rechtsbündig, 8px Gap zwischen Buttons.
- ARIA: `role="dialog"` + `aria-modal="true"` + `aria-labelledby`. Bestätigungen: `role="alertdialog"` + `aria-describedby`.

### Cards & Container

- BG `--ds-surface`, Border `--ds-grey-divider`, Radius 6px, **kein dekorativen Card-Schatten** (Chat-/Panel-Flächen bleiben flach). Einzige Ausnahme ist die Composer-Karte, siehe „Composer-Lift".
- Inneres Padding nach Inhaltstyp (Content 24px, Tool-Card 14px).

### Pills / Status-Badges

- Padding 3/9px, Radius 999px, 11px, Letter-Spacing 0.6px, 600 Weight.
- Aktiv: BG `--ds-blue`, Text `--ds-white`. Englische Status-Texte (`RUNNING`, `DONE`) mit `lang="en"`.

### Avatar

- Rund (50%), BG `--ds-blue`, Text `--ds-white`, 600 Weight, Initialen.

## Verbotene Muster

Du verwendest **niemals**:

- Farbverläufe, dekorative Schatten auf Cards/Panels, Glows, 3D-Effekte (Overlays und Composer siehe Ausnahmen unten)
- Mehr als eine Akzentfarbe (kein `#00A5E1`-Cyan mehr)
- Cyan `#00A5E1` — vollständig durch `--ds-blue` ersetzt
- Italic oder extrem leichte/schwere Display-Font-Weights (außerhalb der erlaubten Inter-Stufen)
- Zentrierte Text-Layouts (außer Empty-States, Bestätigungs-Dialoge)
- Emojis als UI-Element
- Grüne Statusfarben — Status über Form, Position, Text

**Erlaubt:** die in `tokens.css` definierten `box-shadow`-Tokens — keine freien Schatten-Werte in Komponenten:

- `--ds-btn-primary-active-shadow` und `--ds-icon-btn-active-shadow` ausschließlich für den **Active-Lift** bei Primary- und Icon-Buttons.
- `--ds-overlay-shadow` (dazu `--ds-overlay-border`) ausschließlich für **aufklappende Overlays** — Dropdown-Menüs wie Modell-Auswahl, `@`-Vervollständigung und Ordner-Verlauf. Ein Overlay schwebt über dem Inhalt, den es verdeckt; ohne Tiefenhinweis verschwimmen seine Kanten mit dem Darunterliegenden.
- `--ds-chat-composer-shadow` / `--ds-chat-composer-shadow-focus` ausschließlich für die **Composer-Karte** (`#chat-input-row`) — siehe Abschnitt „Composer-Lift".

Alle übrigen Cards, Panels und Chat-Flächen bleiben flach. Ein neuer Schatten-Token ist keine Gestaltungsfreiheit, sondern braucht denselben Begründungsweg wie die drei bestehenden: Er darf nur dort entstehen, wo eine Fläche tatsächlich über einer anderen liegt.

## Composer-Lift (Ausnahmeregel, seit 2026-09-17)

Die Eingabe-Karte im Chat (`#chat-input-row`) ist die **einzige Chat-Fläche mit
einem Schatten**. Sie liegt als eigenes Bedienelement über dem Gesprächsverlauf,
den sie beim Scrollen verdeckt — dieselbe Begründung wie beim Overlay, nur
dauerhaft sichtbar.

- Ruhezustand: `box-shadow: var(--ds-chat-composer-shadow)`
- `:focus-within`: `box-shadow: var(--ds-chat-composer-shadow-focus)` **zusätzlich**
  zur blauen Kante — der Zustand ist nie allein über den Schatten kodiert
  (WCAG 1.4.1), die Kante bleibt das tragende Signal.
- Der Schatten trägt den Hue von `--ds-blue`, nicht Neutralgrau. Ein grauer
  Schatten wäre im Mono-Blue-System ein zweiter, stummer Farbkanal; der blaue
  bleibt innerhalb der einen Akzentfarbe. Trotzdem gilt: **kein sichtbarer
  Farbsaum** — die Deckkraft bleibt so niedrig, dass der Glow als Tiefe gelesen
  wird, nicht als Leuchten.
- Freie `box-shadow`-Werte in Komponenten bleiben verboten; wer die Stärke
  ändert, ändert den Token in `tokens.css`.

### Chat-Grund

Der Chat hat seit derselben Änderung einen **eigenen Grund-Token**
`--ds-chat-bg` (Light `#FAFBFC`, Dark `#313133`) statt `--ds-grey-bg`. Weil der
Schatten die Tiefe der Composer-Karte trägt, darf der Grund heller liegen, als
es die ΔL\*-Regel der Grau-Skala erlauben würde.

`--ds-grey-bg` / `--ds-grey-card` / `--ds-grey-divider` bleiben davon
**unberührt** — sie gelten weiter für Einstellungen, Modals, Footer und Panels,
inklusive ihrer abgestimmten Abstände. Wer den Chat-Grund ändert, prüft nur die
Composer-Karte gegen ihn; wer die Grau-Skala ändert, prüft weiterhin alle drei
Stufen gemeinsam.

## Rote Status-Farben (Ausnahmeregel)

Rot ist **nicht generell verboten**, aber nur einsetzen, wenn die Bedeutung visuell **wirklich rot verlangt** und keine andere Lösung funktioniert. Erlaubte Fälle:

- **Mic-Recording-State** (Audio-Aufnahme aktiv): Recording rot ist eine etablierte UI-Konvention, Form/Text reicht hier nicht aus.
- **Error-Bubble / Error-Toast**: Wenn ein Fehler den Nutzer aktiv warnen muss und die Form-Variante allein zu leise wäre.
- **Destruktive Bestätigung** (z. B. „Daten unwiederbringlich löschen"): nur wenn die schwarze Destructive-Variante zu leise ist; im Zweifel **erst Schwarz versuchen**.

Nicht erlaubt: Rot für nicht-kritische Hinweise, Validierungs-Hilfen ohne tatsächlichen Fehler, allgemeine Akzente.

Token-Konvention: Rote Tokens heißen `--ds-error`, `--ds-error-bg`, `--ds-error-border`, `--ds-mic-recording`, `--ds-mic-recording-bg`. Sie leben in `tokens.css` neben den Mono-Blue-Tokens, sind aber **klar als Status-Tokens dokumentiert**, damit niemand sie versehentlich als allgemeinen Akzent zweckentfremdet.

## Pflichtmuster (WCAG 2.1 AA)

Du stellst **immer** sicher:

- `:focus-visible` auf jedem interaktiven Element: `outline: var(--ds-focus-ring)` mit `outline-offset: var(--ds-focus-offset)` (Light: effektiv `#00759E`)
- Touch-Targets ≥ 32×32, idealerweise 44×44.
- Status nie nur über Farbe — Farbe + Form + Text.
- `prefers-reduced-motion` deaktiviert Pulse, Cursor-Blink, Spinner, Wave-Dots.
- Icon-Buttons mit `aria-label`. Dekorative SVGs: `aria-hidden="true"`. Status-SVGs: `role="img"` + `aria-label`.
- Englische Begriffe (`RUNNING`, `DONE`, `BAT AGENT`) mit `lang="en"`.
- Live-Bereiche: `role="log"` + `aria-live="polite"`. Kein `assertive` außer bei Fehlern.
- Native HTML: `<button>`, `<input>`, `<ol>`/`<ul>`. **Keine** `<div>` mit `onclick`.

## Workflow-Regeln

1. Bei jedem Refactor-Auftrag: **erst Audit, dann Code**. Liefere ein Audit-Memo (Styling-Ansatz, Inventar Buttons/Form-Controls/Dialoge, Risiken). Stoppe und warte auf Freigabe.
2. Refactor-Reihenfolge: Tokens → Buttons → Form-Controls → Dialoge → Cards → Pills → Pages.
3. **Nach jeder Komponente: stoppe.** Du läufst nicht durch. Liefere Diff + Begründung + Risiken + Test-Vorschlag, dann warte auf Freigabe.
4. Verwende `@codebase` für Inventar-Aufbau, `@file` für gezielte Referenzen.
5. Wenn unklar: **stelle eine konkrete Frage**, kein vages „darf ich weitermachen?".

## Output-Format pro Schritt

- **Geänderte Dateien**: Diff oder vollständige neue Datei
- **Begründung**: 2–3 Sätze, warum genau so
- **Funktionsrisiken**: Bullet-Liste, was könnte brechen
- **Test-Vorschlag**: visueller Smoke-Test, Storybook-Update, E2E-Pfad
- **Status**: was fertig, was als Nächstes

Direkt, knapp, präzise. Keine Floskeln, keine Entschuldigungen, kein Salesgespräch.

## Beispiel: korrekt

```css
.btn-primary {
  padding: 8px 18px;
  background: var(--ds-btn-primary-bg);
  color: var(--ds-btn-primary-fg);
  border: 1px solid transparent;
  border-radius: 999px;
  font-weight: 600;
  transition: background 0.15s, border-color 0.15s;
}
.btn-primary:hover:not(:disabled) {
  background: var(--ds-btn-primary-bg-hover);
}

.btn-secondary {
  padding: 8px 18px;
  background: transparent;
  color: var(--text-primary); /* aus styles.css */
  border: 1px solid var(--ds-grey-divider);
  border-radius: 999px;
  font-weight: 600;
  transition: border-color 0.15s;
}
.btn-secondary:hover:not(:disabled) {
  border-color: var(--ds-grey-muted);
}
```

## Beispiel: falsch

```css
/* hardcoded Farben außerhalb tokens.css, rechteckig, kein Token-Bezug */
.my-btn { background: #0078d4; color: white; border-radius: 6px; }

/* neuer Token nur in styles.css statt in tokens.css */
:root { --btn-danger-bg: #b03030; }    /* gehört nach tokens.css */

/* alte Cyan-Akzentfarbe verboten */
:root { --accent: #00A5E1; }

/* destruktive Aktion in Rot — Destructive ist Schwarz */
.btn-delete { background: #c0392b; }
```
