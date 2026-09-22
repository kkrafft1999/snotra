# The standard for UX and UI

This project holds a **high standard for UX, and for UI in particular**.
"It works" is not finished — appearance, behaviour and the small details are
part of the job, not a bonus. Whoever builds a visible change delivers it in a
state that can be shown without an apology.

## What that means in practice

- **UI is part of the definition of done.** A change you can see is finished
  when it also looks good, not when the test turns green.
- **Play through every state**, not just the happy one: empty, loading, error,
  very long content, hover/focus/active/disabled, light **and** dark.
- **No approximations in the visual layer.** Spacing, alignment, line lengths
  and contrast are set deliberately, not guessed. Design tokens instead of
  one-off values — the rules are in
  [`ui-design-tokens.md`](./ui-design-tokens.md).
- **Look at it yourself.** Before calling something finished, actually look at
  the app or a mockup (screenshot, smoke test, preview pane) instead of trusting
  the code. Put mockups in `out/mockup/` inside the project, otherwise the
  preview pane renders them without JavaScript.
- **Operability counts as much as looks:** keyboard operation, focus order,
  visible focus, WCAG 2.1 AA. No state without feedback to the user.
- **No placeholders in the result** — no lorem ipsum, no half-finished icons, no
  "coming later" gaps in what is delivered.

## When it is a design decision

Visual decisions belong to the user. When there are several plausible variants
(layout, arrangement, interaction pattern), **show the variants instead of
picking one** — preferably as a visible mockup, not as prose. The general
procedure is in [`decision-making.md`](./decision-making.md).
