'use strict';

const path = require('path');
const { createFileInfo, formatFields } = require('./file-info');
const { createTranslator } = require('../../shared/i18n');

/**
 * Kontextmenü für Dateien und Ordner im Dateibaum (Issues #58, #59, #120, #123).
 *
 * Baut ein natives Electron-Menü mit Dateioperationen. Die Pfadprüfung gegen
 * den Workspace passiert vorher im IPC-Handler; hier kommt nur noch ein
 * bereits validierter absoluter Pfad an.
 *
 * Ordner bekommen dasselbe Menü ohne „Öffnen“: Auf- und Zuklappen erledigt
 * schon der Linksklick im Baum, und „mit Standardprogramm öffnen“ hätte für
 * einen Ordner keine sinnvolle Bedeutung.
 */

const REVEAL_KEYS = Object.freeze({
  darwin: 'contextMenu.reveal.darwin',
  win32: 'contextMenu.reveal.win32',
});

function revealLabelForPlatform(platform, locale) {
  return createTranslator(locale)(REVEAL_KEYS[platform] || 'contextMenu.reveal.other');
}

/**
 * Types that "Open" runs instead of showing (#649): shell.openPath hands them
 * to the operating system, which executes them with the user's full rights —
 * outside the shell switch (#102) and the sandbox (#329). Files Snotra writes
 * carry no Mark-of-the-Web and no quarantine attribute, so SmartScreen and
 * Gatekeeper do not ask either. On Windows PATHEXT is added on top.
 */
const LAUNCHABLE_EXTENSIONS = Object.freeze({
  win32: Object.freeze([
    '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.vb', '.js', '.jse', '.wsf',
    '.wsh', '.ws', '.wsc', '.sct', '.hta', '.msi', '.msp', '.msc', '.lnk', '.url', '.scr', '.pif',
    '.cpl', '.reg', '.jar', '.application', '.appref-ms', '.chm', '.settingcontent-ms',
    // The python.org, Strawberry Perl and RubyInstaller setups associate
    // these with their interpreter, which runs them; run_python writes .py.
    '.py', '.pyw', '.pyz', '.pl', '.rb',
  ]),
  darwin: Object.freeze([
    '.app', '.command', '.tool', '.sh', '.zsh', '.bash', '.csh', '.ksh', '.tcsh', '.terminal',
    '.workflow', '.action', '.pkg', '.mpkg', '.scpt', '.scptd', '.applescript', '.jar',
    '.fileloc', '.inetloc',
    // Python Launcher, which the python.org installer sets up, runs them.
    '.py', '.pyw', '.pyz',
  ]),
  linux: Object.freeze([
    '.desktop', '.sh', '.bash', '.zsh', '.csh', '.ksh', '.run', '.appimage', '.jar', '.py',
  ]),
});

function launchableExtensions(platform, env) {
  const listed = LAUNCHABLE_EXTENSIONS[platform] || LAUNCHABLE_EXTENSIONS.linux;
  const pathExt = platform === 'win32' && typeof env?.PATHEXT === 'string' ? env.PATHEXT.split(';') : [];
  return new Set([...listed, ...pathExt]
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.')));
}

/** Lower-case extension of a path's last segment as the platform reads it. */
function launchExtension(filePath, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let name = pathApi.basename(filePath);
  // Windows drops trailing dots and spaces: "setup.bat. " runs as setup.bat.
  if (platform === 'win32') name = name.replace(/[. ]+$/, '');
  return pathApi.extname(name).toLowerCase();
}

function createFileContextMenu({
  Menu,
  shell,
  dialog = null,
  clipboard = null,
  platform = process.platform,
  logger = console,
  fileInfo = null,
  // The language is read afresh every time the menu opens (epic #277): a
  // context menu lives only until the click, so a rebuild is unnecessary.
  getLocale = () => undefined,
  // For the look at what "Open" would launch (#649).
  fs = require('fs').promises,
  env = process.env,
}) {
  const info = fileInfo || createFileInfo({ platform, logger });
  const launchable = launchableExtensions(platform, env);

  /**
   * Whether "Open" would run the path rather than show it (#649): a program
   * or script by its extension, an `.app` bundle, or — on macOS and Linux — a
   * regular file without an extension that has an execute bit. A file with
   * an extension is opened by its type, so `report.pdf` from an exFAT stick,
   * where everything is 0777, still opens in a viewer and does not ask. A
   * link counts as what it points to, so `notes` → `tool.app` asks as well.
   * Unreadable or gone: decided by the name alone, and shell.openPath reports
   * the rest.
   */
  async function opensAsProgram(filePath) {
    const names = [filePath];
    let stats = null;
    try {
      const realPath = await fs.realpath(filePath);
      if (realPath !== filePath) names.push(realPath);
      stats = await fs.stat(realPath);
    } catch {
      // Decided by the name below.
    }
    if (names.some((name) => launchable.has(launchExtension(name, platform)))) return true;
    const withoutExtension = names.every((name) => launchExtension(name, platform) === '');
    return platform !== 'win32' && withoutExtension && Boolean(stats?.isFile()) && (stats.mode & 0o111) !== 0;
  }

  /**
   * "Open": a document opens directly, a program or script only after a
   * native warning with "Cancel" as default and Escape answer (#649). A
   * failure from shell.openPath — no app for the type, say — is shown, not
   * only logged. Ergebnis: { opened } | { cancelled } | { error }.
   */
  async function openWithDefaultApp(filePath, window = null) {
    const t = createTranslator(getLocale());
    if (await opensAsProgram(filePath)) {
      // Without a dialog nothing can ask, and a program is not run unasked.
      if (!dialog) return { error: t('contextMenu.noDialog') };
      const { response } = await showMessageBox(window, {
        type: 'warning',
        buttons: [t('contextMenu.openProgram.confirm'), t('contextMenu.openProgram.cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: t('contextMenu.openProgram.title', { name: path.basename(filePath) }),
        detail: `${filePath}\n\n${t('contextMenu.openProgram.detail')}`,
      });
      if (response !== 0) return { cancelled: true };
    }
    // shell.openPath löst mit '' auf, wenn es geklappt hat, sonst mit Fehlertext.
    const failure = await shell.openPath(filePath);
    if (!failure) return { opened: true };
    logger.warn('[file-context-menu] The file could not be opened:', failure);
    if (dialog) {
      await showMessageBox(window, {
        type: 'error',
        buttons: [t('contextMenu.ok')],
        noLink: true,
        message: t('contextMenu.open.failedTitle', { name: path.basename(filePath) }),
        detail: `${filePath}\n\n${failure}`,
      });
    }
    return { error: failure };
  }

  function revealInFileManager(filePath) {
    shell.showItemInFolder(filePath);
  }

  function showMessageBox(window, options) {
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }

  /**
   * Sicherheitsabfrage, dann Papierkorb (shell.trashItem) statt hartem Löschen.
   * „Abbrechen“ ist Standard- und Escape-Antwort, damit Enter nichts löscht.
   * Ergebnis: { cancelled } | { deleted } | { error }.
   */
  async function deleteWithConfirmation(filePath, window, { isDirectory = false } = {}) {
    const t = createTranslator(getLocale());
    if (!dialog) return { error: t('contextMenu.noDialog') };
    const hint = t(isDirectory ? 'contextMenu.delete.directory' : 'contextMenu.delete.file');
    const { response } = await showMessageBox(window, {
      type: 'warning',
      buttons: [t('contextMenu.delete.confirm'), t('contextMenu.delete.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: t('contextMenu.delete.confirmTitle', { name: path.basename(filePath) }),
      detail: `${filePath}\n\n${hint}`,
    });
    if (response !== 0) return { cancelled: true };

    try {
      await shell.trashItem(filePath);
      return { deleted: true };
    } catch (err) {
      const message = err?.message ?? String(err);
      logger.warn('[file-context-menu] The file could not be deleted:', message);
      await showMessageBox(window, {
        type: 'error',
        buttons: [t('contextMenu.ok')],
        message: t('contextMenu.delete.failedTitle'),
        detail: `${filePath}\n\n${message}`,
      });
      return { error: message };
    }
  }

  /**
   * Issue #123: „Informationen“ als nativer Dialog — dieselbe Machart wie die
   * Lösch-Rückfrage, kein neuer Renderer-Code, auf allen drei Plattformen
   * sofort richtig gesetzt.
   *
   * Der zweite Knopf legt den vollständigen Pfad in die Zwischenablage; ohne
   * `clipboard` gibt es ihn nicht, statt einen toten Knopf zu zeigen.
   * Ergebnis: { shown } | { copied } | { error }.
   */
  async function showInfo(filePath, window, { isDirectory = false } = {}) {
    const t = createTranslator(getLocale());
    if (!dialog) return { error: t('contextMenu.noDialog') };

    // Die Sprache geht mit: Die Feldnamen, die Typangaben und die Zahlen- und
    // Datumsformate der Tabelle entstehen erst in `describe()` (#292).
    const described = await info.describe(filePath, { isDirectory, locale: t.locale });
    if (described.error) {
      logger.warn('[file-context-menu] The information could not be read:', described.error);
      await showMessageBox(window, {
        type: 'error',
        buttons: [t('contextMenu.ok')],
        noLink: true,
        message: t('contextMenu.info.unavailable'),
        detail: `${filePath}\n\n${described.error}`,
      });
      return { error: described.error };
    }

    const canCopy = Boolean(clipboard && typeof clipboard.writeText === 'function');
    const { response } = await showMessageBox(window, {
      type: 'info',
      buttons: canCopy ? [t('contextMenu.ok'), t('contextMenu.info.copyPath')] : [t('contextMenu.ok')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: t('contextMenu.info.title', { name: described.name }),
      detail: formatFields(described.fields),
    });

    if (canCopy && response === 1) {
      clipboard.writeText(described.path);
      return { copied: true };
    }
    return { shown: true };
  }

  /**
   * `isDirectory` is main's own lstat of the path (#649), never a renderer
   * flag: it decides whether "Open" is offered and how the delete
   * confirmation words it.
   */
  function buildTemplate(filePath, {
    window = null, onDeleted = null, isDirectory = false, onClearAgentMark = null, onShowChanges = null,
  } = {}) {
    const t = createTranslator(getLocale());
    // Der Klick-Handler wird nicht abgewartet: Eine Ablehnung — etwa weil
    // das Fenster während des Dialogs zugeht — wäre sonst eine
    // unbehandelte Rejection und damit ein Absturz des Main-Prozesses.
    // Every click that opens a dialog is guarded so (#649 for Open and Delete).
    const guarded = (promise, what) => promise.catch((err) => {
      logger.warn(`[file-context-menu] ${what}:`, err?.message ?? err);
    });
    return [
      ...(isDirectory ? [] : [{
        label: t('contextMenu.open'),
        click: () => guarded(openWithDefaultApp(filePath, window), 'The file could not be opened'),
      }]),
      // Only for a file the agent changed in the conversation on screen (#348).
      ...(!isDirectory && typeof onShowChanges === 'function' ? [{
        label: t('contextMenu.showChanges'),
        click: () => onShowChanges(filePath),
      }] : []),
      { label: revealLabelForPlatform(platform, getLocale()), click: () => revealInFileManager(filePath) },
      {
        label: t('contextMenu.info'),
        click: () => guarded(showInfo(filePath, window, { isDirectory }), 'The information could not be shown'),
      },
      // Only when the row carries what the agent read or changed (#347).
      ...(typeof onClearAgentMark === 'function' ? [{
        label: t(isDirectory ? 'contextMenu.clearAgentMark.folder' : 'contextMenu.clearAgentMark'),
        click: () => onClearAgentMark(filePath),
      }] : []),
      { type: 'separator' },
      {
        label: t('contextMenu.delete'),
        click: () => guarded((async () => {
          const result = await deleteWithConfirmation(filePath, window, { isDirectory });
          if (result.deleted && typeof onDeleted === 'function') onDeleted(filePath);
          return result;
        })(), 'The file could not be deleted'),
      },
    ];
  }

  /**
   * `position`: where the keyboard opened it (#74), in window coordinates;
   * without one the menu opens at the mouse pointer.
   */
  function popup(filePath, window, {
    onDeleted = null, isDirectory = false, onClearAgentMark = null, onShowChanges = null, position = null,
  } = {}) {
    const menu = Menu.buildFromTemplate(buildTemplate(filePath, {
      window, onDeleted, isDirectory, onClearAgentMark, onShowChanges,
    }));
    menu.popup({ ...(window ? { window } : {}), ...(position ?? {}) });
    return menu;
  }

  return {
    buildTemplate,
    popup,
    get revealLabel() { return revealLabelForPlatform(platform, getLocale()); },
    deleteWithConfirmation,
    showInfo,
  };
}

module.exports = { createFileContextMenu, revealLabelForPlatform, LAUNCHABLE_EXTENSIONS };
