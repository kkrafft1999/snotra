/**
 * Adressierung von Dateien innerhalb eines eingeschalteten Skills (Issue #61).
 *
 * Ein Skill besteht meist aus mehr als der `SKILL.md` — daneben liegen
 * `references/`, `assets/` oder `scripts/`, auf die die `SKILL.md` verweist.
 * Damit die Lese-Tools solche Dateien erreichen, ohne mit Workspace-Pfaden zu
 * kollidieren, bekommen sie ein eigenes Präfix:
 *
 *   skill:<name>/references/anleitung.md
 *
 * Rein lexikalisch, ohne Dateisystem-Zugriff. Die Wurzel-Auflösung und die
 * Ausbruchs-Pruefung passieren in `fs-service.js`.
 */
'use strict';

const SKILL_PATH_PREFIX = 'skill:';

/**
 * Zerlegt "skill:<name>/<rest>" in Name und Restpfad.
 * @returns {{ name: string, rest: string } | null} null, wenn kein Skill-Pfad.
 */
function parseSkillPath(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(SKILL_PATH_PREFIX)) return null;
  const body = trimmed.slice(SKILL_PATH_PREFIX.length).replace(/^[/\\]+/, '');
  const slash = body.search(/[/\\]/);
  const name = (slash === -1 ? body : body.slice(0, slash)).trim();
  const rest = slash === -1 ? '' : body.slice(slash + 1).trim();
  if (!name) return null;
  return { name, rest };
}

/** Baut "skill:<name>/<rest>"; ohne rest bleibt es "skill:<name>". */
function formatSkillPath(name, rest = '') {
  const cleanName = String(name ?? '').trim();
  const cleanRest = String(rest ?? '').trim().replace(/^[/\\]+/, '');
  if (!cleanName) return '';
  return cleanRest ? `${SKILL_PATH_PREFIX}${cleanName}/${cleanRest}` : `${SKILL_PATH_PREFIX}${cleanName}`;
}

module.exports = {
  SKILL_PATH_PREFIX,
  parseSkillPath,
  formatSkillPath,
};
