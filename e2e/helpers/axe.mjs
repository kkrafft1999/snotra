// axe-core in the running app (#999).
//
// The library comes from `node_modules/axe-core`, a devDependency: it is read
// here and handed to the renderer through Playwright, never copied into
// `src/renderer/vendor/` — the app does not ship it. `page.evaluate` runs in
// the page over the DevTools protocol, so the window's CSP, which forbids
// inline scripts, does not stand in the way.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

/** WCAG 2.1 A and AA, the level the project holds itself to (ui-design-tokens.md). */
export const WCAG_21_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

let axeSource = null;

/**
 * Runs axe over `context` (a selector, or the whole document) and returns the
 * violations, one entry per rule and element, flat enough for a failure
 * message to be read without a debugger.
 */
export async function axeViolations(page, { context = 'html' } = {}) {
  axeSource ??= await readFile(AXE_PATH, 'utf8');
  if (!(await page.evaluate(() => typeof window.axe === 'object'))) {
    await page.evaluate(axeSource);
  }
  return page.evaluate(async ({ context, tags }) => {
    const result = await window.axe.run(context, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    // A context that matched nothing passes every rule by checking none.
    if (result.passes.length === 0) throw new Error(`axe checked nothing in ${context}`);
    return result.violations.flatMap((violation) => violation.nodes.map((node) => ({
      rule: violation.id,
      impact: node.impact ?? violation.impact,
      target: node.target.join(' '),
      summary: node.failureSummary?.split('\n').slice(1).join(' ').trim() ?? '',
      html: node.html.slice(0, 160),
    })));
  }, { context, tags: WCAG_21_AA });
}

/** One line per violation, for an assertion message. */
export function describeViolations(violations) {
  return violations.map((v) => `  ${v.rule} (${v.impact}) at ${v.target}\n    ${v.summary}\n    ${v.html}`).join('\n');
}
