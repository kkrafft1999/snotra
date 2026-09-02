/**
 * Liest einzelne String-Werte aus einem noch unvollständigen JSON-Objekt,
 * z. B. aus Tool-Argumenten, die das Modell gerade erst streamt. So kann die
 * Tool-Zeile den Dateipfad zeigen, lange bevor der komplette Aufruf da ist.
 */
'use strict';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} partialJson  Bisher empfangener JSON-Text (darf abgeschnitten sein).
 * @param {string} key          Schlüssel auf oberster Ebene, dessen String-Wert gesucht wird.
 * @returns {string|null}       Wert, sobald er inkl. schließendem Anführungszeichen da ist, sonst null.
 */
function extractStringFromPartialJson(partialJson, key) {
  if (typeof partialJson !== 'string' || typeof key !== 'string' || !key) return null;
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = re.exec(partialJson);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

module.exports = { extractStringFromPartialJson };
