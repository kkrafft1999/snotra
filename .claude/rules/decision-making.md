# Decision workflow: propose before building

Convention from 2026-07-01 (see the conversation on PR #16).

When the user **asks a question** or **describes a problem** ("We need
something like …", "What do you recommend?", "How should we solve X?"):

1. **Don't build it yet.** Look at the matter and the code first — codebase
   context, existing structure, constraints.
2. **Propose several options**, each with a short assessment: what it costs,
   what it buys, how well it fits this project. A recommendation of your own is
   welcome and useful, but mark it as a recommendation instead of quietly
   pre-empting the decision.
3. **Wait for an explicit decision.** Only once the user picks an option or
   says "do it" / "build it" is code written, committed, pushed or turned into
   a pull request.
4. If work already started during the analysis — files created, say — and the
   user stops before deciding: **roll it back**, don't commit or push it, and
   deliver the options.

## When to act right away (exceptions)

- The user gives a **clear instruction to implement** ("Implement options 1 and
  2", "Build feature X", "Fix bug Y") — then implement it, without asking again
  whether it is wanted.
- **Questions that only ask for information** ("Where is file X defined?",
  "What does function Y do?") — a direct answer is enough, no list of options.
- **Debugging and analysis requests** where the user explicitly asks for the
  cause rather than for a fix.

## Not to be confused with capturing tasks

This rule is about *making decisions in conversation*. Where tasks end up
(GitHub issues, and nowhere else) is a separate convention, in
[`task-management.md`](./task-management.md).
