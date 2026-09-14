# Anspruch an UX und UI

In diesem Projekt gilt ein **hoher Anspruch an UX und besonders an UI**.
„Funktioniert" ist nicht fertig — Aussehen, Verhalten und Detailarbeit gehören
zur Aufgabe, nicht zur Kür. Wer eine sichtbare Änderung baut, liefert sie in
einem Zustand, den man ohne Entschuldigung zeigen kann.

## Was das konkret heißt

- **UI ist Teil der Definition of Done.** Eine Änderung, die man sieht, ist erst
  fertig, wenn sie auch gut aussieht — nicht wenn der Test grün ist.
- **Zustände vollständig durchspielen**, nicht nur den Glücksfall: leer, lädt,
  Fehler, sehr lange Inhalte, Hover/Fokus/Active/Disabled, Light **und** Dark.
- **Keine Näherungen bei der Optik.** Abstände, Ausrichtung, Zeilenlängen und
  Kontraste werden bewusst gesetzt, nicht geschätzt. Design-Tokens statt
  Einzelwerten — Regelwerk in [`ui-design-tokens.md`](./ui-design-tokens.md).
- **Selbst hinschauen.** Vor dem „ist fertig" die App bzw. ein Mockup wirklich
  ansehen (Screenshot, Smoke-Test, Preview-Pane), statt auf den Code zu
  vertrauen. Mockups nach `out/mockup/` im Projekt, sonst rendert der
  Preview-Pane ohne JS.
- **Bedienbarkeit zählt wie Optik:** Tastaturbedienung, Fokus-Reihenfolge,
  sichtbarer Fokus, WCAG 2.1 AA. Kein Zustand ohne Rückmeldung an den Nutzer.
- **Keine Platzhalter im Ergebnis** — kein Lorem ipsum, keine halbfertigen
  Icons, keine „kommt später"-Leerstellen in dem, was ausgeliefert wird.

## Bei gestalterischen Entscheidungen

Optik-Entscheidungen trifft der Nutzer. Wenn es mehrere plausible Varianten
gibt (Layout, Anordnung, Interaktionsmuster), **Varianten zeigen statt eine
auswählen** — am liebsten als sichtbares Mockup, nicht als Prosa. Der
allgemeine Ablauf dazu steht in [`decision-making.md`](./decision-making.md).
