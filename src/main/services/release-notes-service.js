'use strict';

/**
 * The model's way into the release history (#1191): `list_release_notes`.
 *
 * "What has changed since 1.24.0?" is answered from what the releases tell
 * the user — the sections between the `<!-- snotra:notes en|de|end -->`
 * markers (#1072), cut out by the parser the update dialog uses — and never
 * from the model's memory. The history comes from GitHub's release list at
 * the moment of the question: always current, and it includes versions newer
 * than the one installed. The request is the one the update check makes, to
 * the same host and with no content of the user's in it, so it needs no card.
 *
 * Releases before the notes started have none; they are named, not filled
 * with the pull request titles written for developers. A history that cannot
 * be read is an answer of its own (`error`), so that the model says so
 * instead of guessing.
 */

const {
  GITHUB_API, DEFAULT_REPO, REQUEST_TIMEOUT_MS, readRateLimit, parseSemver, compareSemver,
} = require('./update-service');
const { userReleaseNotes } = require('../../shared/runtime/release-notes');
const { DEFAULT_LOCALE } = require('../../shared/i18n');

/** GitHub's own limit per page. */
const PAGE_SIZE = 100;
/** 300 releases are far more than the project has; more pages would only cost requests. */
const MAX_PAGES = 3;
/** A question and its follow-up read the same list; a release a minute ago is not news. */
const CACHE_MS = 10 * 60 * 1000;
/** What goes back to the model at most; the oldest releases beyond it are named, not quoted. */
const MAX_NOTES_CHARS = 30_000;

/**
 * @typedef {{ version: string, date: string, url: string, body: string }} StoredRelease
 */

/**
 * A version as a user writes it — "1.24", "v1.24.0", "1.24.0" — as one the
 * parser knows; null for anything else.
 *
 * @param {unknown} raw
 */
function normalizeVersion(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim().replace(/^v/i, '');
  if (/^\d+\.\d+$/.test(text)) text += '.0';
  const parsed = parseSemver(text);
  return parsed && !parsed.prerelease ? text : null;
}

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetchImpl
 * @param {() => string} deps.getCurrentVersion  the installed version
 * @param {() => string} deps.getLocale  the language of the app
 * @param {string} [deps.repo]
 * @param {() => number} [deps.now]
 * @param {{ warn: (...args: unknown[]) => void }} [deps.log]
 */
function createReleaseNotesService({
  fetchImpl, getCurrentVersion, getLocale, repo = DEFAULT_REPO, now = Date.now, log = console,
}) {
  /** @type {{ at: number, releases: StoredRelease[] } | null} */
  let cache = null;

  /**
   * @param {number} page
   * @returns {Promise<{ list: unknown[] } | { failure: 'offline' | 'rate-limit' | 'http' }>}
   */
  async function fetchPage(page) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${GITHUB_API}/repos/${repo}/releases?per_page=${PAGE_SIZE}&page=${page}`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Snotra-Agent-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) return { failure: readRateLimit(res, now()) ? 'rate-limit' : 'http' };
      const json = await res.json();
      return { list: Array.isArray(json) ? json : [] };
    } catch (error) {
      log.warn(`[release-notes] the release list could not be read (${error?.name || 'error'})`);
      return { failure: 'offline' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Every published stable release, newest first. A failed read falls back to
   * the list read before, when there is one — real data, said to be old.
   *
   * @returns {Promise<{ releases: StoredRelease[], stale: boolean } | { failure: 'offline' | 'rate-limit' | 'http' }>}
   */
  async function loadReleases() {
    if (cache && now() - cache.at < CACHE_MS) return { releases: cache.releases, stale: false };
    /** @type {unknown[]} */
    const raw = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await fetchPage(page);
      if ('failure' in result) {
        return cache ? { releases: cache.releases, stale: true } : { failure: result.failure };
      }
      raw.push(...result.list);
      if (result.list.length < PAGE_SIZE) break;
    }
    /** @type {StoredRelease[]} */
    const releases = [];
    for (const entry of raw) {
      const release = /** @type {Record<string, unknown>} */ (entry && typeof entry === 'object' ? entry : {});
      if (release.draft === true || release.prerelease === true) continue;
      const version = normalizeVersion(typeof release.tag_name === 'string' ? release.tag_name : '');
      if (!version) continue;
      releases.push({
        version,
        date: typeof release.published_at === 'string' ? release.published_at.slice(0, 10) : '',
        url: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${repo}/releases/tag/v${version}`,
        body: typeof release.body === 'string' ? release.body : '',
      });
    }
    releases.sort((a, b) => compareSemver(b.version, a.version));
    cache = { at: now(), releases };
    return { releases, stale: false };
  }

  /**
   * @param {{ from?: unknown, to?: unknown, locale?: unknown }} [request]
   *   `from` exclusive, `to` inclusive — "latest", or the installed version when left out;
   *   without `from` only the release `to` itself comes back.
   */
  async function read({ from, to, locale } = {}) {
    const installedVersion = getCurrentVersion();
    const language = typeof locale === 'string' && locale ? locale : getLocale();
    const wantsLatest = typeof to === 'string' && to.trim().toLowerCase() === 'latest';
    const fromVersion = from == null || from === '' ? null : normalizeVersion(from);
    const toVersion = wantsLatest || to == null || to === '' ? null : normalizeVersion(to);
    if (from != null && from !== '' && !fromVersion) {
      return { error: `"${String(from)}" is not a version number like 1.24.0.` };
    }
    if (to != null && to !== '' && !wantsLatest && !toVersion) {
      return { error: `"${String(to)}" is not a version number like 1.24.0, or "latest".` };
    }

    const loaded = await loadReleases();
    if ('failure' in loaded) {
      const reason = {
        offline: 'GitHub could not be reached — there may be no internet connection.',
        'rate-limit': 'GitHub is limiting requests from this network right now.',
        http: 'GitHub could not answer the request.',
      }[loaded.failure];
      return {
        error: `The release history could not be read: ${reason} Tell the user so and that it can be tried again `
          + 'later; the notes are on https://github.com/kkrafft1999/snotra/releases. Do not list changes from memory.',
        reason: loaded.failure,
        installedVersion,
      };
    }

    const { releases } = loaded;
    const latestVersion = releases[0]?.version ?? null;
    const target = toVersion ?? (wantsLatest ? latestVersion : normalizeVersion(installedVersion));
    const oldestWithNotes = [...releases].reverse()
      .find((release) => userReleaseNotes(release.body, language, DEFAULT_LOCALE))?.version ?? null;

    const inRange = releases.filter((release) => target !== null
      && compareSemver(release.version, target) <= 0
      && (fromVersion ? compareSemver(release.version, fromVersion) > 0 : release.version === target));

    /** @type {Record<string, unknown>[]} */
    const entries = [];
    /** @type {string[]} */
    const withoutNotes = [];
    /** @type {string[]} */
    const omitted = [];
    let used = 0;
    for (const release of inRange) {
      const own = userReleaseNotes(release.body, language, language);
      const notes = own || userReleaseNotes(release.body, language, DEFAULT_LOCALE);
      if (!notes) {
        withoutNotes.push(release.version);
      } else if (used + notes.length > MAX_NOTES_CHARS) {
        omitted.push(release.version);
      } else {
        used += notes.length;
        entries.push({
          version: release.version,
          date: release.date,
          url: release.url,
          notesLanguage: own ? language : DEFAULT_LOCALE,
          notes,
        });
      }
    }

    /** @type {string[]} */
    const hints = [];
    if (loaded.stale) hints.push('GitHub could not be reached just now; this is the list read earlier in this session — it may be missing newer releases.');
    if (target === null || !releases.some((release) => release.version === target)) {
      hints.push(`Version ${target ?? installedVersion} has no published release — this may be a development build, so no notes exist for it.`);
    }
    if (fromVersion && target !== null && compareSemver(fromVersion, target) >= 0) {
      hints.push(`There is no release after ${fromVersion} up to ${target}.`);
    }
    if (withoutNotes.length > 0) {
      hints.push(`No notes written for users exist for ${withoutNotes.join(', ')}`
        + (oldestWithNotes ? `; they start with ${oldestWithNotes}.` : '.')
        + ' Do not make up changes for them; say what is and is not known and point to the release page.');
    }
    if (omitted.length > 0) hints.push(`Too long to return in full: the notes of ${omitted.join(', ')} are left out.`);

    return {
      installedVersion,
      latestVersion,
      from: fromVersion,
      to: target,
      language,
      releases: entries,
      ...(withoutNotes.length > 0 ? { versionsWithoutUserNotes: withoutNotes } : {}),
      ...(omitted.length > 0 ? { omittedVersions: omitted } : {}),
      ...(hints.length > 0 ? { note: hints.join(' ') } : {}),
    };
  }

  return { read };
}

module.exports = { createReleaseNotesService, normalizeVersion };
