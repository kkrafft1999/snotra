---
# Load only when working on renderer or style files. `paths` is the documented
# key; `globs` is added because, according to anthropics/claude-code#17204, some
# versions only honour `globs`. Unknown keys are ignored.
paths:
  - "src/renderer/**/*.html"
  - "src/renderer/**/*.js"
  - "**/*.css"
  - "**/*.scss"
globs: "src/renderer/**/*.html, src/renderer/**/*.js, **/*.css, **/*.scss"
---

# UI design tokens (doubleSlash Mono-Blue)

You are working in the doubleSlash Mono-Blue system for Snotra AI. Stick
strictly to the tokens, component specs and workflow rules defined here.
Functionality, state, routing and data flow stay untouched during refactors —
you change UI tokens, styles and layout patterns and nothing else.

## Token architecture

There are **two token layers**:

1. **Single source of truth — `renderer/styles/tokens.css`**
   Holds every brand and design-system value (colours, typography, radii,
   motion, button colours) as CSS variables. Loaded in `renderer/index.html`
   **before** `styles.css`.
2. **Component aliases — `renderer/styles.css`**
   Maps component-level names (`--btn-primary-bg`, `--btn-radius`, …) onto the
   design tokens, or defines component-specific geometry (padding, radius,
   transition).

**New design tokens** (a colour, a status, a new button variant, a spacing
step …) belong in `renderer/styles/tokens.css`, with the light value in `:root`
and, where needed, the dark value in `[data-theme='dark']`. `styles.css` may add
a semantic alias (`--btn-…`, `--accent-…`) that maps onto the token — **never**
hex values directly in a component.

## Tokens

### Colours

In `tokens.css` these are the channel names (light values in `:root`, dark in
`[data-theme='dark']`):

| Token | Light (excerpt) | Purpose |
|---|---|---|
| `--ds-blue` | `#00759E` | the one accent colour |
| `--ds-blue-soft` | `rgba(0,117,158,0.05)` | hover wash, active radio states |
| `--ds-blue-border` | `rgba(0,117,158,0.25)` | active-state borders |
| `--ds-black` | `#000000` | primary type, destructive action |
| `--ds-white` | `#FFFFFF` | **ink only**: type on blue, check marks |
| `--ds-surface` | `#FFFCF5` | primary surface (cards, dialogs, composer) |
| `--ds-grey-bg` | `#F9F4ED` | page background, footer background |
| `--ds-grey-card` | `#F2EDE6` | code background, inline code |
| `--ds-grey-divider` | `#EFEAE3` | borders, dividing lines |
| `--ds-grey-muted` | `#6F6D69` | secondary type, metadata (only ≥ 14 px) |
| `--ds-grey-strong` | `#5E5C59` | smaller secondary type (< 14 px) |
| `--ds-btn-primary-*` | see `tokens.css` | primary/save/send: background, foreground, hover, active shadow |

The three greys are **warm-toned** (b\* +4, R–B span 12). Until 2026-09-17 the
set was slightly cool, so that the grey surfaces would pick up the blue hue of
`--ds-blue`; that rule is deliberately **reversed**. The ground is paper now,
and `--ds-blue` is the only cool tone in the system — which is what makes it
read as an accent instead of as the basic mood. Turning the warmth back down
turns this decision back with it; don't touch the values individually.

The scale itself is unchanged: the lightness distance ground → card is
ΔL\* 2.44, ground → divider ΔL\* 3.49. Only a\* and b\* were shifted, **never
L\***. **Whoever changes one of the three values has to move the other two
along** — otherwise the layer distances break.

Pure white is no longer a surface. `--ds-surface` sits at L\* 99.0 instead of
100, because warm *and* L\* 100 cannot both be had — on a warm ground `#FFFFFF`
reads as a cooler, almost bluish patch. The price is smaller layer distances:
surface → panel ground ΔL\* 2.62 (was 2.79), surface → chat ground ΔL\* 1.23
(was 1.43). The lower bound for the panel ground is `#F6F1EA`; below that,
`--ds-grey-muted` and `--ds-blue` drop under 4.6:1 and lose every bit of
contrast headroom.

### Typography

- Inter: **400** (body), **500** (CTA, chips, secondary button), **600**
  (headlines, pills, app brand), **700** (welcome hero). No italics, no
  extremely light or heavy display weights.
- Mono: `ui-monospace, 'SF Mono', Menlo, Consolas, monospace`
- `font-variant-numeric: tabular-nums` for numbers in tables and timings.

### Radius

- Containers (card, dialog, input, select, code block): **6px**
- Text buttons, pills, toggles, avatar, live dot, radio: **999px**
- Icon buttons **32×32** (send, mic): in the app **`border-radius: 50%`** (a
  circle).
- The mantra: *clickable or status → round (a circle for square icons).
  Container → 6px.*

## Component specs

### Buttons

Text buttons (`.btn-primary`, `.btn-secondary`) with `border-radius: 999px`,
padding 8/18px. Four variants:

- **Primary**: background `--ds-btn-primary-bg` (`--ds-blue`), text
  `--ds-btn-primary-fg`. Hover: background `--ds-btn-primary-bg-hover` (a darker
  blue, not black). `:active`: a restrained `box-shadow` via
  `--ds-btn-primary-active-shadow`. The CSS class `.btn-primary` is for the most
  important action of a dialog (e.g. "Speichern & aktivieren"). The send icon
  button shares the same primary tokens.
- **Secondary**: background transparent or `--bg-primary`, border
  `--ds-grey-divider`, text in the primary colour. Hover: border
  `--ds-grey-muted` (neutral, not inviting). The CSS class `.btn-secondary` _or_
  simply a `<button>` without `.btn-primary` inside `.modal-actions`. For
  accompanying actions (e.g. "Schließen", "Anbieter zurücksetzen", "Modelle
  laden").
- **Destructive**: background `--ds-black`, text `--ds-white`. Hover: background
  `--ds-grey-muted`. **As a rule no red** — the destructive effect is carried by
  black. Red only for a genuinely critical, irreversible action (see the
  exception below).
- **Icon button**: 32×32, `border-radius: 50%`, no background, hover background
  `--ds-grey-bg`. `:active`: `--ds-icon-btn-active-shadow`. Mandatory:
  `aria-label`.

**Never** set inline colours for buttons — always use tokens, otherwise dark
mode breaks.

### Chips and card-like hover items (the inviting hover)

Container-like interactive elements that _invite_ a choice (quick-action chips,
recent-folder chips, radio rows in card form, the welcome CTA) use a **different
hover pattern** from `.btn-secondary`:

- Default: border `--ds-grey-divider`, transparent or white background.
- **Hover**: border `--ds-blue` plus background `--ds-blue-soft` (a 5% wash).
  The signal: "clickable, something useful happens here".
- Active (a selected radio, say): the same as the hover state.

This is the only permitted hover variant with `--ds-blue` as the border colour —
it feels inviting because `--ds-blue-soft` lays down a very gentle wash.
`.btn-secondary` stays deliberately neutral (`--ds-grey-muted`) so that it does
not compete with the primary action.

### Form controls

- **Text input / textarea**: border `--ds-grey-divider`, radius 6px, padding
  9/12px. Focus: border `--ds-blue`, no outline (the global `:focus-visible`
  ring from `styles.css` applies on top).
- **Select**: like an input plus a custom chevron via a background SVG in
  `--ds-grey-muted`.
- **Toggle switch**: 40×22, background `--ds-grey-divider` with a 1px
  `--ds-grey-control-border` border, knob 16×16 in `--ds-surface` with a 1px
  `--ds-grey-muted` edge, no shadow. Active: track background and border
  `--ds-blue`, knob edge `--ds-blue`. The knob follows the surface rather than
  `--ds-white`: in light that is near-white anyway, in dark the lightened blue
  would swallow a white knob (2.3:1), and the knob's position is what tells on
  from off (WCAG 1.4.11). There is one implementation, `.ds-switch`: a native
  `<input type="checkbox" role="switch">`, listened to with `change` — no
  `<button>` with `aria-checked` and no second rule set (#336).
- **Radio**: 16×16, custom via `appearance: none`. Border `--ds-grey-muted`; when
  `:checked`, border and inner dot in `--ds-blue`. The wrapper row adds a border
  and a `--ds-blue-soft` background via `:has(input:checked)`.
- **Checkbox**: square with a 4px radius (the classic convention). Active:
  `--ds-blue` with a white check mark.

### Dialogs and modals

- Backdrop: `rgba(0,0,0,0.5)`, padding 56/32px.
- Dialog: max-width 480px, background `--ds-surface`, border
  `--ds-grey-divider`, radius 6px.
- Header: padding 16/24px, title 16px/600, close icon button on the right.
  Border-bottom `--ds-grey-divider`.
- Body: padding 4/24/16px. Form rows with a border-bottom between sections.
- Footer: padding 14/20px, background `--ds-grey-bg`, right-aligned, 8px gap
  between buttons.
- ARIA: `role="dialog"` plus `aria-modal="true"` plus `aria-labelledby`.
  Confirmations: `role="alertdialog"` plus `aria-describedby`.

### Cards and containers

- Background `--ds-surface`, border `--ds-grey-divider`, radius 6px, **no
  decorative card shadow** (chat and panel surfaces stay flat). The one
  exception is the composer card, see "The composer lift".
- Inner padding by type of content (content 24px, tool card 14px).

### Pills and status badges

- Padding 3/9px, radius 999px, 11px, letter-spacing 0.6px, weight 600.
- Active: background `--ds-blue`, text `--ds-white`. English status texts
  (`RUNNING`, `DONE`) carry `lang="en"`.

### Avatar

- Round (50%), background `--ds-blue`, text `--ds-white`, weight 600, initials.

## Forbidden patterns

You **never** use:

- Gradients, decorative shadows on cards or panels, glows, 3D effects (overlays
  and the composer are the exceptions below)
- More than one accent colour (no more `#00A5E1` cyan)
- Cyan `#00A5E1` — replaced entirely by `--ds-blue`
- Italics or extremely light or heavy display font weights (outside the
  permitted Inter steps)
- Centred text layouts (except empty states and confirmation dialogs)
- Emojis as a UI element
- Green status colours — status is carried by shape, position and text

**Permitted:** the `box-shadow` tokens defined in `tokens.css` — no free-form
shadow values in components:

- `--ds-btn-primary-active-shadow` and `--ds-icon-btn-active-shadow`
  exclusively for the **active lift** on primary and icon buttons.
- `--ds-overlay-shadow` (together with `--ds-overlay-border`) exclusively for
  **overlays that open up** — dropdown menus such as the model picker, the `@`
  completion and the folder history. An overlay floats above the content it
  covers; without a depth cue its edges blur into what lies beneath.
- `--ds-chat-composer-shadow` / `--ds-chat-composer-shadow-focus` exclusively
  for the **composer card** (`#chat-input-row`) — see "The composer lift".

Every other card, panel and chat surface stays flat. A new shadow token is not
creative licence; it needs the same line of reasoning as the three existing
ones, and may only appear where one surface genuinely sits above another.

## The composer lift (exception, since 2026-09-17)

The input card in the chat (`#chat-input-row`) is the **only chat surface with a
shadow**. It sits above the conversation as a control of its own, and covers it
while scrolling — the same reasoning as for the overlay, only permanently
visible.

- At rest: `box-shadow: var(--ds-chat-composer-shadow)`
- `:focus-within`: `box-shadow: var(--ds-chat-composer-shadow-focus)` **in
  addition** to the blue edge — the state is never encoded by the shadow alone
  (WCAG 1.4.1), the edge stays the load-bearing signal.
- The shadow carries the hue of `--ds-blue`, not neutral grey. A grey shadow
  would be a second, mute colour channel in the Mono-Blue system; the blue one
  stays inside the single accent colour. Even so: **no visible colour fringe** —
  the opacity stays low enough that the glow reads as depth, not as light.
- Free-form `box-shadow` values in components remain forbidden; whoever changes
  the strength changes the token in `tokens.css`.

### The chat ground

Since the same change, the chat has a **ground token of its own**,
`--ds-chat-bg` (light `#FAFBFC`, dark `#313133`), instead of `--ds-grey-bg`.
Because the shadow carries the depth of the composer card, the ground may sit
lighter than the ΔL\* rule of the grey scale would allow.

`--ds-grey-bg` / `--ds-grey-card` / `--ds-grey-divider` are **untouched** by
this — they still apply to settings, modals, the footer and the panels,
including their tuned distances. Whoever changes the chat ground only checks the
composer card against it; whoever changes the grey scale still checks all three
steps together.

## Red status colours (exception)

Red is **not forbidden outright**, but only use it when the meaning visually
**really demands red** and nothing else works. The permitted cases:

- **The mic recording state** (audio recording active): red for recording is an
  established UI convention, shape and text are not enough here.
- **Error bubble / error toast**: when an error has to warn the user actively
  and the shape-only variant would be too quiet.
- **A destructive confirmation** (e.g. "delete data irreversibly"): only when
  the black destructive variant is too quiet; when in doubt, **try black
  first**.

Not permitted: red for non-critical notes, for validation hints without an
actual error, or as a general accent. A run without isolation is not red
either — from #329 until #396 the "Not isolated" pill on the approval card was,
since then it has the warning colour below.

Token convention: red tokens are named `--ds-error`, `--ds-error-bg`,
`--ds-error-border`, `--ds-mic-recording`, `--ds-mic-recording-bg`. They live in
`tokens.css` next to the Mono-Blue tokens, but are **documented clearly as
status tokens**, so that nobody repurposes them as a general accent by accident.

## Warning status colour (exception, since 2026-09-26)

A second status colour next to red, for exactly one meaning: **a run happens
without isolation** — the sandbox is switched off for the workspace, or the
system has none (#396). That is a risk the user accepted or cannot avoid, not a
malfunction. Red would read as "error", and on a permission control as
"blocked" — the opposite of a state in which everything runs. Decided by the
user on 2026-09-26 from a mockup with four variants (red with words, black with
words, amber, today's red).

The same state carries the same colour everywhere:

- the mode pill in "Auto" ("Auto · not isolated") and the notice on top of its
  menu,
- the "Not isolated" badge on the approval card,
- the shield next to the folder name (#398),
- the "Not isolated" lines in Settings › Tools.

Rules:

- **Never the colour alone:** the words "not isolated" and the struck-through
  shield go with it. A composer bar too narrow for the words puts the pills on
  a row of their own (#400) instead of dropping them.
- **Nothing else is amber** — no general caution, no validation hint, no
  accent. An action that failed stays red, even when it concerns the sandbox
  (the switch could not be flipped, say).
- Tokens: `--ds-warning` (text, icon, pill border), `--ds-warning-bg` (tint),
  `--ds-warning-border` (badge border). Light `#915B00`: 5.5:1 on
  `--ds-surface`, 4.8:1 on its own tint. Dark `#F2B45A`: 4.8:1 on its tint over
  the composer, 7.1:1 on `--ds-surface`. Whoever changes a value checks it on
  those grounds again.

## Mandatory patterns (WCAG 2.1 AA)

You **always** make sure that:

- `:focus-visible` is on every interactive element:
  `outline: var(--ds-focus-ring)` with `outline-offset: var(--ds-focus-offset)`
  (light: effectively `#00759E`)
- Touch targets are ≥ 32×32, ideally 44×44.
- Status is never carried by colour alone — colour plus shape plus text.
- `prefers-reduced-motion` disables the pulse, the cursor blink, the spinner and
  the wave dots.
- Icon buttons have an `aria-label`. Decorative SVGs: `aria-hidden="true"`.
  Status SVGs: `role="img"` plus `aria-label`.
- English terms (`RUNNING`, `DONE`, `BAT AGENT`) carry `lang="en"`.
- Live regions: `role="log"` plus `aria-live="polite"`. No `assertive` except
  for errors.
- Native HTML is used: `<button>`, `<input>`, `<ol>`/`<ul>`. **No** `<div>` with
  an `onclick`.

## Workflow rules

1. For every refactor task: **audit first, code second**. Deliver an audit memo
   (styling approach, inventory of buttons, form controls and dialogs, risks).
   Stop and wait for approval.
2. Refactor order: tokens → buttons → form controls → dialogs → cards → pills →
   pages.
3. **Stop after every component.** You do not run through. Deliver diff,
   reasoning, risks and a test suggestion, then wait for approval.
4. Use `@codebase` to build the inventory, `@file` for specific references.
5. When something is unclear: **ask a concrete question**, not a vague "may I
   continue?".

## Output format per step

- **Changed files**: diff or the complete new file
- **Reasoning**: 2–3 sentences on why exactly this way
- **Functional risks**: a bullet list of what could break
- **Test suggestion**: visual smoke test, storybook update, e2e path
- **Status**: what is done, what comes next

Direct, brief, precise. No filler, no apologies, no sales pitch.

## Example: correct

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
  color: var(--text-primary); /* from styles.css */
  border: 1px solid var(--ds-grey-divider);
  border-radius: 999px;
  font-weight: 600;
  transition: border-color 0.15s;
}
.btn-secondary:hover:not(:disabled) {
  border-color: var(--ds-grey-muted);
}
```

## Example: wrong

```css
/* hard-coded colours outside tokens.css, rectangular, no token reference */
.my-btn { background: #0078d4; color: white; border-radius: 6px; }

/* a new token only in styles.css instead of tokens.css */
:root { --btn-danger-bg: #b03030; }    /* belongs in tokens.css */

/* the old cyan accent colour is forbidden */
:root { --accent: #00A5E1; }

/* a destructive action in red — destructive is black */
.btn-delete { background: #c0392b; }
```
