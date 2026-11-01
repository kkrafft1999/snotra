/**
 * Where the `?` next to a settings section leads (#848): a page of the
 * bundled manual and the heading of the section there.
 *
 * The headings are quoted as the manual writes them, in each language — this
 * is a reference into `manual/`, not interface text, which is why it lives
 * with the help window's modules and not with the components.
 * `test/settings-help.test.js` checks every entry against the bundled manual,
 * so renaming a heading there fails the test instead of a link quietly
 * landing at the top of a page.
 */

import { headingSlug } from '../file-views/markdown-document.js';

/**
 * Settings section → manual page. `section` is the heading the link lands on,
 * as the manual writes it in each language; without one the link opens the
 * page itself and `title` is the page's title.
 */
export const SETTINGS_HELP = Object.freeze({
  'panel.models': {
    slug: 'customising/models',
    title: { en: 'Manage your models', de: 'Deine Modelle verwalten' },
  },
  'panel.security': {
    slug: 'safety/tools-and-security',
    title: { en: 'See and change what Snotra may do', de: 'Sehen und ändern, was Snotra darf' },
  },
  'panel.sandbox': {
    slug: 'safety/sandbox',
    title: { en: 'Run commands in the sandbox', de: 'Befehle in der Sandbox ausführen' },
  },
  'panel.tools': {
    slug: 'customising/built-in-tools',
    title: { en: 'Set up the built-in tools', de: 'Die eingebauten Tools einrichten' },
  },
  'panel.skills': {
    slug: 'customising/skills',
    title: { en: 'Use skills', de: 'Skills nutzen' },
  },
  'panel.memory': {
    slug: 'customising/memory',
    title: { en: 'Let Snotra remember', de: 'Snotra etwas merken lassen' },
  },
  'panel.general': {
    slug: 'customising/settings',
    section: { en: 'The section General', de: 'Der Bereich Allgemein' },
  },
  modelPrices: {
    slug: 'chatting/chat-cost',
    section: { en: 'Prices of your own', de: 'Eigene Preise' },
  },
  preferredModels: {
    slug: 'customising/models',
    section: { en: 'The list', de: 'Die Liste' },
  },
  defaultMode: {
    slug: 'safety/choose-a-mode',
    section: { en: 'The folder\'s default mode', de: 'Der Standardmodus des Ordners' },
  },
  sessionGrants: {
    slug: 'safety/tools-and-security',
    section: { en: 'Revoke an allowance or reset', de: 'Eine Freigabe widerrufen oder zurücksetzen' },
  },
  permissionReset: {
    slug: 'safety/tools-and-security',
    section: { en: 'Revoke an allowance or reset', de: 'Eine Freigabe widerrufen oder zurücksetzen' },
  },
  sensitivePaths: {
    slug: 'safety/tools-and-security',
    section: { en: 'Mark more files as sensitive', de: 'Weitere Dateien als sensibel markieren' },
  },
  python: {
    slug: 'customising/built-in-tools',
    section: { en: 'Python', de: 'Python' },
  },
  webSearch: {
    slug: 'customising/built-in-tools',
    section: { en: 'Web search', de: 'Websuche' },
  },
  imageGeneration: {
    slug: 'customising/built-in-tools',
    section: { en: 'Image generation', de: 'Bilderzeugung' },
  },
  mcpServers: {
    slug: 'customising/mcp-servers',
    title: { en: 'Connect an MCP server', de: 'Einen MCP-Server anbinden' },
  },
  skillCatalog: {
    slug: 'customising/skills',
    section: { en: 'Switch a skill on', de: 'Einen Skill einschalten' },
  },
  // Not a settings section: the link in the chat's banner when its chats are
  // not being saved (#977) — a help link all the same, held by the same test.
  // The link in a notice about a store's file (#1001).
  'notice.store': {
    slug: 'troubleshooting/files-set-aside',
    title: { en: 'When settings or the history start afresh', de: 'Wenn Einstellungen oder der Verlauf neu anfangen' },
  },
  // The link in the notice about errors nobody caught (#978).
  'notice.backgroundError': {
    slug: 'troubleshooting/logs-and-reports',
    section: { en: 'The log file', de: 'Die Logdatei' },
  },
  // The link in the box of a tool result that looked like an injection (#1011).
  'chat.injectionFlag': {
    slug: 'safety/why-snotra-asks',
    section: { en: 'When a tool result looks like instructions', de: 'Wenn ein Tool-Ergebnis nach Anweisungen aussieht' },
  },
  'chat.saveNotice': {
    slug: 'troubleshooting/keychain-and-storage',
    section: { en: 'When a chat is not being saved', de: 'Wenn ein Chat nicht gespeichert wird' },
  },
});

function inLocale(texts, locale) {
  return texts[locale] ?? texts.en;
}

/** Where an entry leads, in a language: `{ slug, fragment, label }`. */
export function settingsHelpTarget(key, locale) {
  const entry = SETTINGS_HELP[key];
  if (!entry) return null;
  if (entry.section) {
    const heading = inLocale(entry.section, locale);
    return { slug: entry.slug, fragment: headingSlug(heading), label: heading };
  }
  return { slug: entry.slug, fragment: '', label: inLocale(entry.title, locale) };
}
