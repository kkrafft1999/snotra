/**
 * Erkennung sensibler Inhalte (Issue #66, Konzept §4, Mustergruppe
 * „Auffälliger Inhalt“). Versionierte Mindestregeln:
 *
 *  - Private-Key-Header
 *  - bekannte Token-Präfixe (GitHub, OpenAI/Anthropic, Slack, AWS, Google,
 *    GitLab, Hugging Face, npm, Stripe)
 *  - nichtleere Zuweisungen zu api_key, access_token, password, secret & Co.
 *  - Bearer-Token
 *
 * Bewusst keine allgemeine Entropie- oder Personendaten-Erkennung. Die
 * Funktionen liefern nur Regelnamen und Zeilennummern, nie die Werte selbst,
 * damit Befunde gefahrlos in Karte, Log und Verlauf landen können.
 */
'use strict';

const SENSITIVE_CONTENT_RULES_VERSION = 1;

/** Standardbegrenzung: größere Texte gelten als „nicht prüfbar“ (Konzept §4). */
const DEFAULT_SCAN_LIMIT_CHARS = 4 * 1024 * 1024;

const MASK_TEXT = '[maskiert]';

// Schluesselnamen duerfen ein Praefix tragen (OPENAI_API_KEY, DB_PASSWORD,
// github_token); nach dem Namen muss das Wort enden (password_hint zaehlt nicht).
const CREDENTIAL_KEYS =
  '[A-Za-z0-9_-]*?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|' +
  'secret[_-]?key|private[_-]?key|passw(?:or)?d|secret|token)';

// Platzhalter, die typisch für Beispiel-Konfigurationen sind. Sie zählen
// nicht als „nichtleere Zuweisung“: <…>, ${…}, {{…}}, %…%, reine x/*-Ketten,
// ausgeschriebene Aufforderungen („your-api-key“, „changeme“, „example“).
const PLACEHOLDER_VALUE = /^(?:<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[^%]*%|[x*•]{4,}|(?:your|my|the)[-_ ]?\S*|change[-_ ]?me\S*|example\S*|placeholder\S*|todo\S*|xxx+\S*|dummy\S*|sample\S*|null|none|undefined|true|false)$/i;

const CONTENT_RULES = Object.freeze([
  {
    id: 'private-key-header',
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  },
  {
    id: 'github-token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    id: 'openai-style-key',
    regex: /\bsk-(?:proj-|ant-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'slack-token',
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'aws-access-key-id',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'google-api-key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'gitlab-token',
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'huggingface-token',
    regex: /\bhf_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: 'npm-token',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'stripe-key',
    regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'bearer-token',
    regex: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g,
  },
  {
    id: 'credential-assignment',
    // key = value  |  key: value  |  "key": "value"  |  export KEY=value
    regex: new RegExp(
      `(["']?)\\b${CREDENTIAL_KEYS}\\b\\1\\s*[:=]\\s*(?:["']([^"'\\r\\n]{8,})["']|([^\\s"',;#()]{8,}))`,
      'gi'
    ),
    // Gruppe 2 = in Anführungszeichen, Gruppe 3 = nackt (.env-Stil).
    valueGroups: [2, 3],
    quotedGroup: 2,
  },
]);

function extractAssignmentValue(rule, groups) {
  if (!rule.valueGroups) return null;
  for (const group of rule.valueGroups) {
    if (typeof groups[group] === 'string') {
      return { value: groups[group], quoted: group === rule.quotedGroup };
    }
  }
  return null;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function isPlaceholderValue(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return true;
  return PLACEHOLDER_VALUE.test(trimmed);
}

// Punktierte Bezeichner wie `process.env.SECRET` oder `config.auth.token`
// sind Code, kein Geheimnis.
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/**
 * Nichtleere Zuweisung heißt: ein Wert, der wie ein Geheimnis aussieht.
 * Anführungszeichen machen eine Zeichenkette glaubhaft; ohne sie (.env-Stil)
 * muss der Wert eine Ziffer enthalten oder lang sein, damit gewöhnlicher
 * Code (`token = getToken`) nicht bei jedem Lesen anschlägt.
 */
function looksLikeSecretValue(value, { quoted }) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length < 8 || isPlaceholderValue(trimmed)) return false;
  if (quoted) return true;
  if (DOTTED_IDENTIFIER.test(trimmed)) return false;
  return /\d/.test(trimmed) || trimmed.length >= 20;
}

/**
 * Prüft einen Text. Liefert `{ sensitive, findings: [{ rule, line }], scannable }`.
 * `scannable = false` heißt: zu groß oder kein Text — der Aufrufer darf dann
 * keine ungeprüften Inhalte ausgeben.
 */
function scanSensitiveContent(rawText, { maxChars = DEFAULT_SCAN_LIMIT_CHARS } = {}) {
  if (typeof rawText !== 'string') return { sensitive: false, findings: [], scannable: false };
  if (rawText.length > maxChars) return { sensitive: false, findings: [], scannable: false };
  const findings = [];
  for (const rule of CONTENT_RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    let match;
    while ((match = regex.exec(rawText)) !== null) {
      if (rule.valueGroups) {
        const found = extractAssignmentValue(rule, match);
        if (!found || !looksLikeSecretValue(found.value, found)) continue;
      }
      findings.push({ rule: rule.id, line: lineNumberAt(rawText, match.index) });
      if (findings.length >= 50) break;
      if (match[0].length === 0) regex.lastIndex += 1;
    }
    if (findings.length >= 50) break;
  }
  return { sensitive: findings.length > 0, findings, scannable: true };
}

/**
 * Maskiert erkannte Werte für UI-Vorschauen und Audit (Konzept §4/§9). Der
 * Text bleibt lesbar, die Geheimnisse verschwinden.
 */
function maskSensitiveContent(rawText) {
  if (typeof rawText !== 'string' || !rawText) return '';
  let text = rawText;
  for (const rule of CONTENT_RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    if (rule.valueGroups) {
      text = text.replace(regex, (whole, ...groups) => {
        // replace() liefert die Gruppen ohne den Gesamttreffer; match[] ab 1.
        const found = extractAssignmentValue(rule, [whole, ...groups]);
        if (!found || !looksLikeSecretValue(found.value, found)) return whole;
        return whole.replace(found.value, MASK_TEXT);
      });
      continue;
    }
    if (rule.id === 'bearer-token') {
      text = text.replace(regex, `Bearer ${MASK_TEXT}`);
      continue;
    }
    if (rule.id === 'private-key-header') {
      // Header stehen lassen, den Schlüsselkörper bis zur END-Zeile entfernen.
      text = text.replace(
        /(-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)[\s\S]*?(-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/g,
        (_whole, begin, end) => `${begin}\n${MASK_TEXT}\n${end}`
      );
      continue;
    }
    text = text.replace(regex, MASK_TEXT);
  }
  return text;
}

/**
 * Prüft, ob der Text eines der eigenen Geheimnisse (z. B. konfigurierte
 * Provider-Schlüssel) wörtlich enthält (Konzept §5). Vergleicht nur, gibt
 * nichts aus.
 */
function containsOwnSecret(rawText, secrets) {
  if (typeof rawText !== 'string' || !rawText) return false;
  if (!Array.isArray(secrets)) return false;
  for (const secret of secrets) {
    if (typeof secret !== 'string') continue;
    const needle = secret.trim();
    if (needle.length < 8) continue;
    if (rawText.includes(needle)) return true;
  }
  return false;
}

module.exports = {
  SENSITIVE_CONTENT_RULES_VERSION,
  DEFAULT_SCAN_LIMIT_CHARS,
  MASK_TEXT,
  scanSensitiveContent,
  maskSensitiveContent,
  containsOwnSecret,
  isPlaceholderValue,
  looksLikeSecretValue,
};
