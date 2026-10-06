// Syntax highlighting for source text in the preview (#745).
//
// Prism tokenises; this module turns the tokens into DOM. The file is
// untrusted, so nothing of it is ever parsed as HTML: every piece of text
// becomes a text node, and the only elements are `<span class="syntax-…">`.
// Prism's own HTML output (`Prism.highlight`) is not used at all.
//
// The tokens are mapped onto nine roles, each with a colour token of its own
// in tokens.css (`--ds-syntax-*`). A token type that has no role adds no
// span; its text keeps the colour of whatever it sits in.

import Prism from '../vendor/prism/prism.js';

// Prism token type (or alias) → role. The first of a token's type and aliases
// that has one decides.
const ROLE_BY_TYPE = new Map(Object.entries({
  keyword: 'keyword', important: 'keyword', atrule: 'keyword', rule: 'keyword', title: 'keyword',
  boolean: 'number', number: 'number', constant: 'number', entity: 'number',
  string: 'string', char: 'string', 'attr-value': 'string', regex: 'string',
  'template-string': 'string', code: 'string', 'code-snippet': 'string',
  comment: 'comment', prolog: 'comment', doctype: 'comment', cdata: 'comment', shebang: 'comment',
  function: 'function', decorator: 'function', annotation: 'function',
  'class-name': 'type', builtin: 'type',
  property: 'property', 'attr-name': 'property', key: 'property', variable: 'property',
  parameter: 'property', url: 'property', interpolation: 'property',
  tag: 'tag', selector: 'tag',
  punctuation: 'punctuation', operator: 'punctuation', 'interpolation-punctuation': 'punctuation',
  list: 'punctuation',
  bold: 'bold',
}));

function roleOf(token) {
  if (ROLE_BY_TYPE.has(token.type)) return ROLE_BY_TYPE.get(token.type);
  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  for (const alias of aliases) if (ROLE_BY_TYPE.has(alias)) return ROLE_BY_TYPE.get(alias);
  return null;
}

/** The text of a token tree, as it stood in the file. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('');
  return textOf(content?.content ?? '');
}

/**
 * Prism's own steps around `tokenize`: some grammars hook into them — PHP
 * inside HTML is cut out before and put back after (`markup-templating`).
 * Returns null for a language the bundle does not have.
 */
export function tokenizeSource(text, language) {
  const grammar = language ? Prism.languages[language] : null;
  if (!grammar) return null;
  const env = { code: text, grammar, language };
  Prism.hooks.run('before-tokenize', env);
  env.tokens = Prism.tokenize(env.code, env.grammar);
  Prism.hooks.run('after-tokenize', env);
  return env.tokens;
}

/**
 * A fenced code block in Markdown carries its language as alias
 * `language-js`. Prism colours it only when it writes HTML; here it is
 * tokenised with that grammar instead, if the bundle has it.
 */
function embeddedTokens(token) {
  if (token.type !== 'code-block') return null;
  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  const language = aliases.find((a) => a.startsWith('language-'))?.slice('language-'.length);
  if (!language || !Prism.languages[language]) return null;
  return tokenizeSource(textOf(token.content), language);
}

function appendTokens(parent, tokens) {
  for (const token of tokens) {
    if (typeof token === 'string') {
      parent.appendChild(document.createTextNode(token));
      continue;
    }
    const role = roleOf(token);
    let target = parent;
    if (role) {
      target = document.createElement('span');
      target.className = `syntax-${role}`;
      parent.appendChild(target);
    }
    const inner = embeddedTokens(token);
    if (inner) appendTokens(target, inner);
    else if (typeof token.content === 'string') target.appendChild(document.createTextNode(token.content));
    else appendTokens(target, Array.isArray(token.content) ? token.content : [token.content]);
  }
}

/**
 * The text as a fragment of text nodes and role spans, or null when there is
 * nothing to colour (no grammar) or the grammar failed. Its text content is
 * the input, character for character.
 */
export function highlightToFragment(text, language) {
  let tokens;
  try {
    tokens = tokenizeSource(text, language);
  } catch {
    return null;
  }
  if (!tokens) return null;
  const fragment = document.createDocumentFragment();
  appendTokens(fragment, tokens);
  return fragment;
}
