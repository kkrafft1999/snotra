'use strict';

/**
 * Environment-Block fuer den Systemprompt (Issue #138).
 *
 * Ohne diese Angaben raet das Modell bei Shell-Befehlen die Plattform
 * (`ls` gegen `dir`, `sed -i ''` gegen `sed -i`), kennt seinen eigenen
 * Arbeitspfad nicht und datiert „letzte Woche" auf den Wissensstand seines
 * Trainings. Der Block kostet rund hundert Tokens und spart dafuer die
 * Tool-Runden, mit denen sich das Modell dieselben Angaben sonst zusammensucht.
 *
 * Bewusst *keine* Uhrzeit: alles hier ist einen Tag lang stabil, damit das
 * Prompt-Caching der Anbieter nicht bei jeder Nachricht bricht.
 *
 * Reine Funktion ueber den Angaben aus dem Environment-Port — die Anwendungs-
 * schicht bleibt laufzeitneutral und der Block damit testbar.
 */

/** Maschinenname -> gelaeufiger Name. Unbekanntes bleibt unkommentiert. */
const PLATFORM_LABELS = Object.freeze({
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
});

/** Index wie `Date#getDay()`: 0 ist Sonntag. */
const WEEKDAYS_DE = Object.freeze([
  'Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag',
]);

/**
 * Tagesdatum in Ortszeit. Bewusst von Hand statt ueber `toISOString()` — das
 * rechnet nach UTC um und liefert am Abend in Mitteleuropa den Folgetag.
 */
function formatLocalDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  const iso = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${WEEKDAYS_DE[date.getDay()]}, ${iso}`;
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * @param {import('../ports/environment-port').EnvironmentFacts} facts
 * @returns {string} Der Block, oder '' wenn nichts Nennenswertes bekannt ist.
 */
function buildEnvironmentSystemPrompt(facts) {
  const data = facts && typeof facts === 'object' ? facts : {};
  const lines = [];

  const workspaceRoot = cleanString(data.workspaceRoot);
  // Ohne offenen Ordner faellt die Zeile ganz weg — ein leeres
  // „Arbeitsverzeichnis:" waere schlechter als keine Angabe.
  if (workspaceRoot) lines.push(`- Arbeitsverzeichnis: ${workspaceRoot}`);
  if (workspaceRoot && typeof data.isGitRepository === 'boolean') {
    lines.push(`- Git-Repository: ${data.isGitRepository ? 'ja' : 'nein'}`);
  }

  const platform = cleanString(data.platform);
  if (platform) {
    const label = PLATFORM_LABELS[platform];
    lines.push(`- Plattform: ${platform}${label ? ` (${label})` : ''}`);
  }

  const osVersion = cleanString(data.osVersion);
  if (osVersion) lines.push(`- Betriebssystem: ${osVersion}`);

  // Nur nennen, wenn `shell_execute` wirklich laeuft (Nachtrag zu #138): sonst
  // verspricht der Prompt eine Faehigkeit, die gerade abgeschaltet ist.
  const shell = cleanString(data.shell);
  if (shell) lines.push(`- Shell für shell_execute: ${shell}`);

  const today = formatLocalDate(data.now);
  if (today) lines.push(`- Heutiges Datum: ${today}`);

  if (lines.length === 0) return '';

  const appName = cleanString(data.appName) || 'Snotra AI';
  const appVersion = cleanString(data.appVersion);
  const intro = `Umgebung, in der du gerade läufst (${appName}${appVersion ? ` ${appVersion}` : ''}):`;

  return [
    intro,
    lines.join('\n'),
    'Richte Pfadangaben, Shell-Befehle und Datumsangaben nach diesen Werten; '
      + 'du musst sie nicht erst mit einem Tool ermitteln.',
  ].join('\n\n');
}

module.exports = {
  buildEnvironmentSystemPrompt,
  formatLocalDate,
  PLATFORM_LABELS,
};
