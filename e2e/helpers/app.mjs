// Treiber fuer die echte Electron-App im Smoke-Test (Issue #78).
//
// Was hier steht, ist die Summe der Fallstricke aus frueheren Handlaeufen — sie
// kosten ohne diese Notizen jedes Mal dieselbe halbe Stunde:
//
//   * `--user-data-dir` isoliert die Einstellungen. Ohne das laeuft der Test
//     gegen die echte Installation des Nutzers.
//   * `ELECTRON_RUN_AS_NODE` muss aus dem Env raus, sonst startet Electron als
//     Node und es gibt nie ein Fenster.
//   * Playwrights eigenes Warten (`waitForSelector`, Locator-Assertions) haengt:
//     sein Polling haengt an Renderer-Timern, und die werden im Hintergrund
//     gedrosselt. Deshalb die Startflags gegen das Throttling **und** selbst
//     pollen (siehe `poll`).
//   * Die Preload-Bruecke heisst `window.electronAPI`, nicht `window.api`.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright-core';
import electronBinary from 'electron';

const APP_DIR = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Pollt, bis `check` etwas Wahres liefert. Ersatz fuer waitForSelector, das in
 * dieser Umgebung in den Timeout laeuft, obwohl das Element laengst da ist.
 */
export async function poll(check, { timeoutMs = 15000, intervalMs = 150, what = 'Bedingung' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error(`Zeitlimit beim Warten auf: ${what} (zuletzt: ${JSON.stringify(last)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Legt ein frisches userData-Verzeichnis an: geoeffneter Ordner, ein Preset auf
 * den Fake-Modellserver, Standardeinstellungen. Damit startet die App fertig
 * eingerichtet — der native Ordnerdialog und der Einstellungsdialog muessen im
 * Test nicht bedient werden.
 */
export async function prepareUserData(userDataDir, { workspace, modelBaseUrl }) {
  await mkdir(userDataDir, { recursive: true });
  const write = (name, data) =>
    writeFile(path.join(userDataDir, name), JSON.stringify(data), 'utf8');

  const presetId = randomUUID();
  await write('last-folder.json', { path: workspace });
  await write('folder-history.json', { paths: [workspace] });
  await write('llm-config.json', {
    version: 3,
    activeProvider: 'mlx-lm',
    activePresetId: presetId,
    presets: [{ id: presetId, providerId: 'mlx-lm', model: 'fake-model', reasoningEffort: null, menuVisible: true }],
    providers: { 'mlx-lm': { baseUrl: modelBaseUrl, model: 'fake-model' } },
  });
  await write('ui-preferences.json', { appLocale: 'de' });
}

/** Startet die App und wartet, bis der Renderer steht. */
export async function launchApp({ userDataDir }) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({
    executablePath: electronBinary,
    args: [
      APP_DIR,
      `--user-data-dir=${userDataDir}`,
      // Ohne diese drei drosselt Chromium die Timer des Fensters, sobald es
      // nicht im Vordergrund ist — und dann steht der Renderer still.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
    env,
  });

  const page = await app.firstWindow();
  await poll(() => page.evaluate(() => !!document.getElementById('tree-container')), {
    what: 'geladener Renderer',
  });

  return {
    app,
    page,
    /**
     * Ersetzt shell.openExternal im Main-Prozess: Ein Klick auf einen Link soll
     * im Test keinen echten Browser oeffnen. `app.evaluate` geht erst nach
     * firstWindow(), sonst laeuft firstWindow() selbst in den Timeout.
     */
    async captureExternalLinks() {
      await app.evaluate(({ shell }) => {
        globalThis.__openedLinks = [];
        shell.openExternal = async (url) => { globalThis.__openedLinks.push(url); };
      });
      return () => app.evaluate(() => globalThis.__openedLinks ?? []);
    },
    async stop() {
      await app.close();
    },
  };
}
