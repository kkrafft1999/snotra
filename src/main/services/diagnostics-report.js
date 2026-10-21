'use strict';

/**
 * *Help › Copy diagnostics* (#978): what a bug report needs, as plain text to
 * paste — the version, the system, how many errors this start caught, and the
 * end of the log.
 *
 * The report goes wherever the user pastes it, often a public issue. The log
 * holds error messages and stacks, never chat contents, prompts or tool
 * arguments; what it does hold is paths, and a path names the user's account.
 * The home folder is therefore written as `~` throughout.
 */
const DEFAULT_TAIL_LINES = 200;

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the home folder with `~`, in both slash directions on Windows.
 *
 * @param {string} text
 * @param {string} [homeDir]
 */
function hideHome(text, homeDir) {
  if (!homeDir || homeDir.length < 2) return text;
  const variants = new Set([homeDir, homeDir.replace(/\\/g, '/')]);
  let out = text;
  for (const variant of variants) {
    out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
  }
  return out;
}

/**
 * @param {{ appName: string, appVersion: string, platform: string, arch: string,
 *   osRelease: string, versions: Readonly<Record<string, string|undefined>>, locale?: string,
 *   errorCount: number, logFile: { filePath: string, tail: (n: number) => string[] } | null,
 *   homeDir?: string, tailLines?: number, now?: () => Date }} input
 */
function buildDiagnosticsReport({
  appName,
  appVersion,
  platform,
  arch,
  osRelease,
  versions = {},
  locale = '',
  errorCount = 0,
  logFile = null,
  homeDir = '',
  tailLines = DEFAULT_TAIL_LINES,
  now = () => new Date(),
}) {
  const runtime = [
    versions.electron && `Electron ${versions.electron}`,
    versions.chrome && `Chromium ${versions.chrome}`,
    versions.node && `Node ${versions.node}`,
  ].filter(Boolean).join(' · ');
  const head = [
    `${appName} ${appVersion}`,
    `System: ${platform} ${osRelease} (${arch})`,
    runtime && `Runtime: ${runtime}`,
    locale && `Language: ${locale}`,
    `Errors caught since start: ${errorCount}`,
    `Log file: ${logFile ? logFile.filePath : '(none)'}`,
    `Copied: ${now().toISOString()}`,
  ].filter(Boolean);

  const lines = logFile ? logFile.tail(tailLines) : [];
  const body = lines.length > 0
    ? [`--- The last ${lines.length} lines of the log ---`, ...lines]
    : ['--- The log is empty ---'];
  return hideHome([...head, '', ...body].join('\n'), homeDir) + '\n';
}

module.exports = { buildDiagnosticsReport, hideHome, DEFAULT_TAIL_LINES };
