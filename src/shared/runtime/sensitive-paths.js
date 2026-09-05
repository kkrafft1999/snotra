/**
 * Erkennung sensibler Pfade (Issue #66, Konzept §4).
 *
 * Die Prüfung ist rein lexikalisch und läuft lokal in Snotra, vor jeder
 * Weitergabe an Modell, Logs oder Verlauf. Sie gilt für normalisierte
 * logische und reale Pfade, alle Segmente, Windows-Trenner und `skill:`-Ziele.
 * Der Namensvergleich ist unabhängig von Groß-/Kleinschreibung.
 *
 * Bewusst konservativ: `.env.example`, öffentliche Schlüssel und harmlose
 * `id_*`-Dateien treffen ebenfalls. Das ist eine erklärte Fehlalarmquelle —
 * Dateiendung, .gitignore oder „example“ sind kein Beweis für Unbedenklichkeit.
 */
'use strict';

const { parseSkillPath } = require('./skill-path');
const { compilePathPattern, normalizePathForMatch } = require('./path-pattern');

const SENSITIVE_PATH_RULES_VERSION = 1;

/** Dateinamen mit Zugangsdaten — gelten für jedes Segment eines Pfads. */
const DEFAULT_SENSITIVE_NAME_PATTERNS = Object.freeze([
  '.env*',
  '*.pem',
  '*.key',
  'id_*',
  'credentials*',
  'secrets*',
  '*.p12',
  '*.pfx',
  '.netrc',
  '.npmrc',
  '.pypirc',
]);

/** Verzeichnisse mit Zugangsdaten — treffen den Ordner selbst und alles darunter. */
const DEFAULT_SENSITIVE_DIRECTORY_NAMES = Object.freeze(['.ssh', '.aws', '.gnupg', '.kube']);

function compileNamePattern(pattern) {
  return compilePathPattern(pattern, { caseInsensitive: true }).regex;
}

/**
 * Zerlegt einen Tool-Pfad in vergleichbare Segmente. Ein Skill-Präfix
 * (`skill:<name>/rest`) wird abgestreift, der Skill-Name selbst ist kein
 * Dateiname und wird nicht geprüft.
 */
function splitSegments(rawPath) {
  const text = typeof rawPath === 'string' ? rawPath.trim() : '';
  const skill = parseSkillPath(text);
  const body = skill ? skill.rest : text;
  const normalized = normalizePathForMatch(body);
  return normalized ? normalized.split('/') : [];
}

/**
 * Baut einen Matcher aus den eingebauten Mindestmustern und optionalen
 * Nutzer-Mustern (Konzept §4, Zeile „Private Projektdaten“). Nutzer-Muster
 * folgen der `*`/`**`-Semantik aus path-pattern.js und gelten relativ zur
 * jeweiligen Wurzel; ein Muster wie `personal/**` trifft auch den Ordner selbst.
 */
function createSensitivePathMatcher({ userPatterns = [] } = {}) {
  const nameRegexes = DEFAULT_SENSITIVE_NAME_PATTERNS.map((pattern) => ({
    pattern,
    regex: compileNamePattern(pattern),
  }));
  const directoryNames = new Set(DEFAULT_SENSITIVE_DIRECTORY_NAMES.map((name) => name.toLowerCase()));
  const userRegexes = (Array.isArray(userPatterns) ? userPatterns : [])
    .filter((pattern) => typeof pattern === 'string' && pattern.trim())
    .map((pattern) => ({ pattern, compiled: compilePathPattern(pattern, { caseInsensitive: true }) }));

  /**
   * @returns {{ sensitive: boolean, pattern?: string, source?: 'name'|'directory'|'user' }}
   */
  function classifyPath(rawPath) {
    const segments = splitSegments(rawPath);
    if (segments.length === 0) return { sensitive: false };

    for (const segment of segments) {
      if (directoryNames.has(segment.toLowerCase())) {
        return { sensitive: true, pattern: `${segment.toLowerCase()}/**`, source: 'directory' };
      }
      for (const { pattern, regex } of nameRegexes) {
        if (regex.test(segment)) return { sensitive: true, pattern, source: 'name' };
      }
    }

    const joined = segments.join('/');
    for (const { pattern, compiled } of userRegexes) {
      if (compiled.regex.test(joined)) return { sensitive: true, pattern, source: 'user' };
      // `personal/**` soll auch `personal` selbst treffen (Verzeichnis gezielt adressiert).
      if (compiled.matchesSelf) {
        const bare = normalizePathForMatch(pattern).replace(/\/\*\*$/, '');
        if (bare && joined.toLowerCase() === bare.toLowerCase()) {
          return { sensitive: true, pattern, source: 'user' };
        }
      }
    }
    return { sensitive: false };
  }

  function isSensitivePath(rawPath) {
    return classifyPath(rawPath).sensitive;
  }

  return { classifyPath, isSensitivePath };
}

module.exports = {
  SENSITIVE_PATH_RULES_VERSION,
  DEFAULT_SENSITIVE_NAME_PATTERNS,
  DEFAULT_SENSITIVE_DIRECTORY_NAMES,
  createSensitivePathMatcher,
};
