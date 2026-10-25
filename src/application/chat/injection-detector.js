/**
 * The built-in source of injection flags (#1011, AR-36): a handful of
 * patterns that prompt injections use and ordinary pages, files and command
 * output do not.
 *
 * It is a warning, not a protection (docs/architecture/quality-requirements.md §3): it
 * misses what it does not know, and isolation and approvals hold either way.
 * What it must not do is cry wolf — a warning on every other web page teaches
 * the user to skip it. So a *strong* signal flags on its own, a *weak* one
 * only together with a weak one of another kind. The patterns were tuned
 * against real tool output (web pages, READMEs, docs, shell output) in the
 * test fixtures; a new pattern adds a fixture that it does not light up.
 *
 * Results of the tools whose output is Snotra's own — skills it loads, the
 * manual, what a write reports — are not looked at, and neither are the
 * files of a skill: a skill is instructions by design.
 */
'use strict';

const {
  INJECTION_SIGNAL_KINDS: KINDS,
  INJECTION_FLAG_SOURCES,
  INJECTION_FLAG_LIMITS,
  cleanInjectionExcerpt,
} = require('../../shared/contracts/injection-flag');
const { TOOL_CATEGORIES } = require('../../shared/contracts/tool-categories');

/**
 * Categories whose results Snotra wrote itself or that are instructions by design.
 * @type {Set<string>}
 */
const SKIPPED_CATEGORIES = new Set([
  TOOL_CATEGORIES.SKILL,
  TOOL_CATEGORIES.SKILL_WRITE,
  TOOL_CATEGORIES.MANUAL,
  TOOL_CATEGORIES.WRITE,
  TOOL_CATEGORIES.IMAGE,
]);

/** Characters looked at; past that the start and the end are scanned. */
const SCAN_HEAD_CHARS = 400_000;
const SCAN_TAIL_CHARS = 100_000;
/** Context kept around a match for the excerpt. */
const EXCERPT_BEFORE = 24;

const STRONG = 'strong';
const WEAK = 'weak';

/**
 * @typedef {Object} InjectionRule
 * @property {string} id
 * @property {import('../../shared/contracts/injection-flag').InjectionSignalKind} kind
 * @property {'strong'|'weak'} weight
 * @property {RegExp} pattern
 */

/** @type {InjectionRule[]} */
const RULES = [
  // ── Overriding what the agent was told ──────────────────────────────────
  {
    id: 'override-previous',
    kind: KINDS.OVERRIDE,
    weight: STRONG,
    pattern: /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your|my|these|those|of)\s+){0,3}(?:previous|prior|preceding|above|earlier|former|original|initial|system|developer)\s+(?:instructions?|prompts?|directions|directives|guidelines|rules)\b/i,
  },
  {
    id: 'override-everything',
    kind: KINDS.OVERRIDE,
    weight: STRONG,
    pattern: /\b(?:ignore|disregard|forget)\s+(?:everything|all)\s+(?:(?:that\s+)?you\s+(?:were|have\s+been)\s+told|(?:said|written|stated)\s+(?:above|before|earlier))\b/i,
  },
  {
    id: 'override-de',
    kind: KINDS.OVERRIDE,
    weight: STRONG,
    pattern: /(?:^|[^\p{L}])(?:ignorier(?:e|en|t)?|vergiss|vergessen\s+sie|missachte)\s+(?:(?:alle|die|deine|ihre|sämtliche|bitte)\s+){0,3}(?:vorherigen|bisherigen|obigen|vorigen|früheren|ursprünglichen|vorangegangenen)\s+(?:anweisungen|instruktionen|befehle|regeln|vorgaben|prompts?)(?![\p{L}])/iu,
  },
  {
    id: 'new-instructions',
    kind: KINDS.OVERRIDE,
    weight: STRONG,
    pattern: /\byour\s+(?:new|real|actual|true|updated)\s+(?:instructions|task|role|objective|goal|orders)\s+(?:is|are)\b/i,
  },
  {
    id: 'mode-switch',
    kind: KINDS.OVERRIDE,
    weight: STRONG,
    pattern: /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak|jailbroken|god|unrestricted|admin)\s*mode\b/i,
  },
  {
    id: 'from-now-on',
    kind: KINDS.OVERRIDE,
    weight: WEAK,
    pattern: /\bfrom\s+now\s+on,?\s+you\s+(?:will|must|shall|are\s+to)\b/i,
  },

  // ── Posing as the app or as another turn ────────────────────────────────
  {
    // Weak: model cards, Modelfiles and tokenizer configs show these
    // templates as a matter of course.
    id: 'template-system-turn',
    kind: KINDS.ROLE,
    weight: WEAK,
    pattern: /<\|im_start\|>\s*system\b|<\|start_header_id\|>\s*system\s*<\|end_header_id\|>/i,
  },
  {
    // Closing the wrapper a tool result sits in, to start a turn of its own.
    id: 'closing-wrapper',
    kind: KINDS.ROLE,
    weight: STRONG,
    pattern: /<\/(?:tool_result|function_results)>/i,
  },
  {
    // The same tags as open models' chat templates use them (Qwen, Hermes).
    id: 'closing-template-tag',
    kind: KINDS.ROLE,
    weight: WEAK,
    pattern: /<\/(?:tool_response|tool_output|function_output)>/i,
  },
  {
    id: 'system-line',
    kind: KINDS.ROLE,
    weight: STRONG,
    pattern: /(?:^|\n)[ \t>*#-]*(?:system|SYSTEM)\s*(?:message|prompt|override)?\s*:\s*(?:you\s+(?:must|will|are\s+now)|ignore|disregard|new\s+instructions)/,
  },
  {
    id: 'template-token',
    kind: KINDS.ROLE,
    weight: WEAK,
    pattern: /<\|(?:im_start|im_end|endoftext|eot_id|start_header_id)\|>|\[\/?INST\]|<<\/?SYS>>/,
  },
  {
    id: 'system-tag',
    kind: KINDS.ROLE,
    weight: WEAK,
    pattern: /<(?:system-reminder|system_prompt|system_instructions|important_instructions?)>/i,
  },

  // ── Orders aimed at the agent ───────────────────────────────────────────
  {
    id: 'conceal-from-user',
    kind: KINDS.ADDRESSED,
    weight: STRONG,
    pattern: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|alert|warn)\s+(?:the|your)\s+user\s+(?:about|that|what)\b/i,
  },
  {
    // "…retries without informing the user" is how code reviews talk about
    // silent failures, so this one only counts together with another kind.
    id: 'without-user',
    kind: KINDS.ADDRESSED,
    weight: WEAK,
    pattern: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|alert|notify|warn)\s+(?:the|your)\s+user\b|\bwithout\s+(?:telling|informing|alerting|notifying|asking)\s+(?:the|your)\s+user\b/i,
  },
  {
    id: 'addressed-to-agent',
    kind: KINDS.ADDRESSED,
    weight: WEAK,
    pattern: /\bif\s+you\s+are\s+(?:an?\s+)?(?:ai|llm|large\s+language\s+model|language\s+model|ai\s+assistant|ai\s+agent|chatbot)\b|\b(?:note|message|instructions?|attention)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llm|language\s+model|ai\s+assistant|ai\s+agent|coding\s+agent)s?\b|\b(?:dear|hey|attention)\s+(?:ai|llm|claude|chatgpt|gpt|gemini|copilot)\b/i,
  },
  {
    id: 'addressed-imperative',
    kind: KINDS.ADDRESSED,
    weight: WEAK,
    pattern: /\b(?:ai|llm|assistant|agent)s?\s+(?:reading|processing|summari[sz]ing|viewing)\s+(?:this|the\s+page|this\s+page)\s+(?:must|should|need\s+to|are\s+(?:required|instructed))\b/i,
  },

  // ── Getting secrets or the conversation out ─────────────────────────────
  {
    id: 'reveal-prompt',
    kind: KINDS.EXFILTRATE,
    weight: WEAK,
    pattern: /\b(?:reveal|print|output|repeat|disclose|leak)\s+(?:me\s+)?(?:your|the)\s+(?:(?:full|entire|complete|hidden|original|initial)\s+){0,2}(?:system\s+prompt|initial\s+instructions|hidden\s+instructions)\b/i,
  },
  {
    id: 'send-secrets',
    kind: KINDS.EXFILTRATE,
    weight: WEAK,
    pattern: /\b(?:send|post|upload|email|transmit|forward|exfiltrate|leak|include)\s+(?:(?:the|your|all|any|this|these|its|user's|user)\s+){0,3}(?:api[\s_-]?keys?|private\s+keys?|ssh\s+keys?|\.env(?:\s+file)?|environment\s+variables|secrets|passwords|conversation(?:\s+history)?|chat\s+history|system\s+prompt)\b[^\n]{0,80}?(?:https?:\/\/|\b[\w.+-]+@[\w-]+\.[\w.]+\b)/i,
  },
  {
    id: 'image-beacon',
    kind: KINDS.EXFILTRATE,
    weight: WEAK,
    pattern: /!\[[^\]\n]{0,80}\]\(https?:\/\/[^)\s]{1,200}[?&][\w-]{1,40}=(?:\{|\$\{|%7B|<|\[)[^)\n]{0,120}\)/i,
  },
];

/**
 * Unicode tag characters (U+E0000–E007F) carry ASCII that no font shows —
 * the "ASCII smuggling" trick. A run of them is never ordinary text; single
 * ones occur in flag emoji (England, Scotland, Wales) and are left alone.
 */
const TAG_RUN = /(?:\udb40[\udc00-\udc7f]){8,}/g;
/** A subdivision flag: black flag, tag letters, cancel tag. */
const TAG_FLAG_EMOJI = /\ud83c\udff4(?:\udb40[\udc20-\udc7e])+\udb40\udc7f/g;

/**
 * Quote marks right before a match: a text that *talks about* injections —
 * a security guide, a skill that warns of them — quotes the phrase, an
 * injection says it. A quoted hit does not count.
 */
const QUOTE_BEFORE = /["'`\u2018\u2019\u201a\u201c\u201d\u201e\u00ab\u00bb\u2039\u203a]\s?$/;

/**
 * The text a result says, for matching: a JSON result is unpacked into its
 * strings, so that escaped newlines and quotes do not hide a line start.
 *
 * @param {string} content
 * @returns {string}
 */
function textOf(content) {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      /** @type {string[]} */
      const parts = [];
      collectStrings(JSON.parse(trimmed), parts, 0);
      return parts.join('\n');
    } catch {
      // Not JSON after all: read it as it is.
    }
  }
  return content;
}

/**
 * @param {unknown} value
 * @param {string[]} out
 * @param {number} depth
 */
function collectStrings(value, out, depth) {
  if (depth > 12) return;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
}

/** @param {string} text */
function scannedPart(text) {
  if (text.length <= SCAN_HEAD_CHARS + SCAN_TAIL_CHARS) return text;
  return `${text.slice(0, SCAN_HEAD_CHARS)}\n${text.slice(-SCAN_TAIL_CHARS)}`;
}

/**
 * The words around a match, as the row shows them.
 *
 * @param {string} text
 * @param {number} index
 * @param {number} length
 */
function excerptAt(text, index, length) {
  const start = Math.max(0, index - EXCERPT_BEFORE);
  const end = Math.min(text.length, index + Math.max(length, 1) + INJECTION_FLAG_LIMITS.EXCERPT_CHARS);
  let piece = text.slice(start, end);
  // Start and end on a word, not in the middle of one.
  if (start > 0) piece = piece.replace(/^\S*\s+/, '');
  const cleaned = cleanInjectionExcerpt(piece);
  return start > 0 && cleaned ? `…${cleaned}` : cleaned;
}

/**
 * Where the words of a match begin: some patterns start on the character
 * before them (a line break, a non-letter), which may be the quote itself.
 * A token such as `<|im_start|>` or `[INST]` begins at its first character.
 *
 * @param {string} matched
 */
function leadingSeparator(matched) {
  const lead = /^[^\p{L}<[!]*/u.exec(matched);
  return lead ? lead[0].length : 0;
}

/** Matches looked at per rule before it gives up on finding one outside quotes. */
const MATCHES_PER_RULE = 25;

/**
 * The first match of `rule` that is not quoted, or null.
 *
 * @param {InjectionRule} rule
 * @param {string} text
 * @returns {RegExpExecArray|null}
 */
function firstUnquotedMatch(rule, text) {
  const pattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
  for (let i = 0; i < MATCHES_PER_RULE; i += 1) {
    const match = pattern.exec(text);
    if (!match) return null;
    const start = match.index + leadingSeparator(match[0]);
    if (!QUOTE_BEFORE.test(text.slice(Math.max(0, start - 2), start))) return match;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return null;
}

/** @param {string} run  tag characters */
function decodeTags(run) {
  let out = '';
  for (const char of run) {
    const code = /** @type {number} */ (char.codePointAt(0)) - 0xe0000;
    if (code >= 0x20 && code < 0x7f) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * What the built-in rules find in `content`, strong and weak, at most one
 * hit per rule.
 *
 * @param {string} content
 * @returns {Array<{ rule: string, kind: import('../../shared/contracts/injection-flag').InjectionSignalKind, weight: 'strong'|'weak', excerpt: string }>}
 */
function findInjectionSignals(content) {
  if (typeof content !== 'string' || !content) return [];
  const text = scannedPart(textOf(content));
  /** @type {ReturnType<typeof findInjectionSignals>} */
  const hits = [];
  for (const rule of RULES) {
    const match = firstUnquotedMatch(rule, text);
    if (!match) continue;
    hits.push({ rule: rule.id, kind: rule.kind, weight: rule.weight, excerpt: excerptAt(text, match.index, match[0].length) });
  }
  TAG_RUN.lastIndex = 0;
  const tags = TAG_RUN.exec(text.replace(TAG_FLAG_EMOJI, ''));
  if (tags) {
    const decoded = decodeTags(tags[0]);
    if (decoded.trim()) {
      hits.push({ rule: 'hidden-tags', kind: KINDS.HIDDEN, weight: STRONG, excerpt: cleanInjectionExcerpt(decoded) });
    }
  }
  return hits;
}

/**
 * Whether the hits add up to a flag: one strong one, or weak ones of at
 * least two kinds.
 *
 * @param {ReturnType<typeof findInjectionSignals>} hits
 */
function hitsWarrantFlag(hits) {
  if (hits.some((hit) => hit.weight === STRONG)) return true;
  return new Set(hits.map((hit) => hit.kind)).size >= 2;
}

/**
 * The built-in detector as an injection-flag source.
 *
 * @returns {import('../ports/injection-flag-port').InjectionFlagPort}
 */
function createBuiltinInjectionDetector() {
  return {
    inspect({ category, skill, content }) {
      if (SKIPPED_CATEGORIES.has(category) || skill) return null;
      const hits = findInjectionSignals(content);
      if (!hitsWarrantFlag(hits)) return null;
      // Strong hits first, one signal per kind: the row says what was found,
      // not how often.
      const ordered = [...hits].sort((a, b) => (a.weight === b.weight ? 0 : a.weight === STRONG ? -1 : 1));
      /** @type {Set<string>} */
      const kinds = new Set();
      const signals = [];
      for (const hit of ordered) {
        if (kinds.has(hit.kind)) continue;
        kinds.add(hit.kind);
        signals.push({ kind: hit.kind, excerpt: hit.excerpt });
      }
      return { signals, sources: [INJECTION_FLAG_SOURCES.BUILTIN] };
    },
  };
}

module.exports = {
  createBuiltinInjectionDetector,
  findInjectionSignals,
  hitsWarrantFlag,
};
