// Look instead of trust: starts the real app, opens the settings dialog and
// photographs all three switch styles — model visibility, the instant
// switches and the MCP servers — off and on, light and dark (issue #300).
// Prints the WCAG 1.4.11 contrast of every switch from its computed colours.
// Not a test — a look.
//
//   node e2e/manual-switches.mjs
//
// Result: out/mockup/switches-<panel>-<theme>.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const PANELS = ['models', 'tools', 'mcp'];

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-switches-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-switches-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
// Two servers, one on and one off, so the MCP panel shows both states. The
// command does not exist; the switch is drawn all the same.
await writeFile(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify({
  servers: [
    { id: 'files', label: 'Files', command: 'snotra-no-such-command', args: [], enabled: true },
    { id: 'notes', label: 'Notes', command: 'snotra-no-such-command', args: [], enabled: false },
  ],
}), 'utf8');

const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

// Contrast of each visible switch, measured on the colours the browser
// actually paints. Off and on are read from the same element by flipping its
// state attribute for a moment, so both states come from identical markup.
const measure = () => page.evaluate(() => {
  // Transitions would hand back a colour halfway between the two states.
  const still = document.createElement('style');
  still.textContent = '*, *::before, *::after { transition: none !important; }';
  document.head.appendChild(still);
  const rgb = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/) || value.match(/color\(srgb ([^)/]+)/);
    if (!m) return null;
    const parts = m[1].split(/[ ,]+/).filter(Boolean).map(Number);
    const scale = value.startsWith('color(') ? 255 : 1;
    return parts.slice(0, 3).map((v) => v * scale);
  };
  const lum = ([r, g, b]) => {
    const c = [r, g, b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
    return Math.round(((x + 0.05) / (y + 0.05)) * 10) / 10;
  };
  const surfaceOf = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !/rgba\([^)]*,\s*0\)|transparent/.test(bg)) return bg;
    }
    return 'rgb(255, 255, 255)';
  };

  const kinds = [
    { name: 'settings-pref-switch', selector: '.settings-pref-switch',
      track: (el) => el.querySelector('.settings-pref-switch-track'),
      knob: (el) => [el.querySelector('.settings-pref-switch-knob'), null],
      set: (el, on) => el.setAttribute('aria-checked', String(on)) },
    { name: 'ds-switch', selector: '.ds-switch',
      track: (el) => el, knob: (el) => [el, '::before'],
      set: (el, on) => { el.checked = on; } },
    { name: 'mcp-switch', selector: '.mcp-switch',
      track: (el) => el, knob: (el) => [el, '::after'],
      set: (el, on) => el.setAttribute('aria-checked', String(on)) },
  ];

  const rows = [];
  for (const kind of kinds) {
    const el = [...document.querySelectorAll(kind.selector)]
      .find((node) => node.getBoundingClientRect().width > 0);
    if (!el) continue;
    const wasOn = kind.name === 'ds-switch' ? el.checked : el.getAttribute('aria-checked') === 'true';
    const read = (on) => {
      kind.set(el, on);
      const track = getComputedStyle(kind.track(el));
      const [knobEl, pseudo] = kind.knob(el);
      const knob = getComputedStyle(knobEl, pseudo);
      return {
        track: track.backgroundColor, trackBorder: track.borderTopColor,
        knob: knob.backgroundColor, knobBorder: knob.borderTopColor,
        shadow: knob.boxShadow,
      };
    };
    const off = read(false);
    const on = read(true);
    kind.set(el, wasOn);
    const surface = surfaceOf(el);
    rows.push({
      switch: kind.name,
      'knob on on-track': ratio(on.knob, on.track),
      'knob edge on off-track': ratio(off.knobBorder, off.track),
      'off-track border on surface': ratio(off.trackBorder, surface),
      'knob shadow': off.shadow,
    });
  }
  still.remove();
  return rows;
});

const SWITCH_OF = { models: '.settings-pref-switch', tools: '.ds-switch', mcp: '.mcp-switch' };

const openPanel = async (panel) => {
  await page.evaluate((name) =>
    document.querySelector(`.settings-nav-item[data-settings-panel="${name}"]`).click(), panel);
  // The model list and the MCP panel fill in after the tab opens.
  await poll(() => page.evaluate((selector) => [...document.querySelectorAll(selector)]
    .some((node) => node.getBoundingClientRect().width > 0), SWITCH_OF[panel]),
  { what: `switch in the ${panel} panel` });
  await page.waitForTimeout(300);
};

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
  { what: 'open settings dialog' });

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    for (const panel of PANELS) {
      await openPanel(panel);
      const box = await page.evaluate(() => {
        const r = document.querySelector('#modal-settings .modal-content, #modal-settings > *')
          .getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      await page.screenshot({ path: path.join(SHOTS, `switches-${panel}-${theme}.png`), clip: box });
      console.log(`\n${theme} · ${panel}`);
      console.table(await measure());
    }
  }
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
