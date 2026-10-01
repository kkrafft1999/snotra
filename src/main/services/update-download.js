'use strict';

// Laedt ein Release-Asset in ein eigenes Arbeitsverzeichnis — mit Fortschritt
// und echtem Abbruch. „Echt" heisst: der laufende HTTP-Strom wird abgebrochen
// UND die halbe Datei verschwindet. Es bleibt nie ein Torso liegen, der beim
// naechsten Versuch als fertiger Download durchginge.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { createMessage } = require('../../shared/contracts/message');
const { assetDigest } = require('./update-targets');

/** Nur von dort holen wir Dateien — GitHub-Releases und deren Ablage. */
const ALLOWED_HOSTS = Object.freeze([
  'github.com',
  'www.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const WORK_DIR_NAME = 'snotra-update';
const PROGRESS_INTERVAL_MS = 150;

/** HTTPS und ein bekannter GitHub-Host — sonst wird nichts geladen. */
function isAllowedAssetUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return ALLOWED_HOSTS.includes(url.hostname.toLowerCase());
}

/** Dateiname ohne Pfadanteile — der Name kommt aus einer fremden Antwort. */
function safeFileName(name, fallback = 'snotra-update.bin') {
  const base = path.basename(String(name || '')).replace(/[^\w.@+-]/g, '_');
  return base && base !== '.' && base !== '..' ? base : fallback;
}

/**
 * @param {object} deps
 * @param {string} deps.tempDir       Basis fuer das Arbeitsverzeichnis (app.getPath('temp')).
 * @param {function} [deps.fetchImpl] Override fuer Tests; default globaler fetch.
 */
function createUpdateDownloader({ tempDir, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const workDir = path.join(tempDir, WORK_DIR_NAME);

  /** Laufender Download: Controller zum Abbrechen, sonst null. */
  let active = null;
  /** Fertig geladene Datei: { filePath, version, assetName } oder null. */
  let ready = null;

  async function removeWorkDir() {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Laedt das Asset. Wirft nie — Fehler und Abbruch kommen als Ergebnis
   * zurueck, damit der Renderer sie anzeigen kann statt sie zu verschlucken.
   *
   * @param {object} args
   * @param {{url: string, name: string, size: number, digest?: string}} args.asset
   *        `digest` is GitHub's `sha256:<hex>`; when present, a file that does
   *        not hash to it is discarded like a short one (#569).
   * @param {string} args.version
   * @param {(p: {receivedBytes: number, totalBytes: number}) => void} [args.onProgress]
   * @param {AbortSignal} [args.signal]  the caller's cancellation (#568)
   */
  async function download({ asset, version, onProgress, signal } = {}) {
    if (active) return { ok: false, error: createMessage('update.error.downloadRunning') };
    if (!asset || !isAllowedAssetUrl(asset.url)) {
      return { ok: false, error: createMessage('update.error.foreignUrl') };
    }

    // The slot is claimed before the first await (#568). Claimed later, two
    // calls arriving together would both pass the check above and write the
    // same file.
    const controller = new AbortController();
    active = controller;
    const abortFromCaller = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });

    const fileName = safeFileName(asset.name);
    const filePath = path.join(workDir, fileName);
    const declaredSize = Number.isFinite(asset.size) && asset.size > 0 ? asset.size : 0;
    const expectedDigest = assetDigest(asset.digest);

    try {
      // Jeder Lauf startet auf der gruenen Wiese: ein alter Rest aus einem
      // abgebrochenen Versuch darf nicht als Teil-Download weiterleben.
      await removeWorkDir();
      ready = null;
      if (controller.signal.aborted) return { ok: false, canceled: true };

      await fsp.mkdir(workDir, { recursive: true });

      const res = await doFetch(asset.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'Snotra-AI-Updater',
        },
      });
      // GitHub answers with a redirect to its storage. Where it ends up has to
      // pass the same test as the address we asked for — HTTPS included (#573).
      if (res.url && !isAllowedAssetUrl(res.url)) {
        await res.body?.cancel?.().catch(() => {});
        return { ok: false, error: createMessage('update.error.foreignUrl') };
      }
      if (!res.ok) {
        return { ok: false, error: createMessage('update.error.downloadHttp', { status: res.status }) };
      }
      if (!res.body) {
        return { ok: false, error: createMessage('update.error.downloadEmpty') };
      }

      const headerLength = Number(res.headers?.get?.('content-length'));
      const totalBytes = Number.isFinite(headerLength) && headerLength > 0
        ? headerLength
        : declaredSize;

      let receivedBytes = 0;
      let lastEmit = 0;
      const emit = (force) => {
        if (typeof onProgress !== 'function') return;
        const now = Date.now();
        if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
        lastEmit = now;
        onProgress({ receivedBytes, totalBytes });
      };
      emit(true);

      const hash = crypto.createHash('sha256');
      const source = Readable.fromWeb(res.body);
      source.on('data', (chunk) => {
        receivedBytes += chunk.length;
        hash.update(chunk);
        emit(false);
      });

      await pipeline(source, fs.createWriteStream(filePath), { signal: controller.signal });
      emit(true);

      // Eine abgeschnittene Antwort (Verbindung weg) liefert keinen Fehler,
      // nur zu wenige Bytes. Ohne diese Pruefung wuerde ein halbes DMG
      // gemountet werden.
      if (declaredSize && receivedBytes !== declaredSize) {
        await removeWorkDir();
        return {
          ok: false,
          error: createMessage('update.error.downloadIncomplete', { received: receivedBytes, expected: declaredSize }),
        };
      }
      // The right length with the wrong bytes: only the checksum tells.
      if (expectedDigest && `sha256:${hash.digest('hex')}` !== expectedDigest) {
        await removeWorkDir();
        return { ok: false, error: createMessage('update.error.downloadDigest') };
      }

      ready = { filePath, version, assetName: fileName, bytes: receivedBytes };
      return { ok: true, filePath, version, assetName: fileName, bytes: receivedBytes };
    } catch (err) {
      await removeWorkDir();
      if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
        return { ok: false, canceled: true };
      }
      return { ok: false, error: err?.message || createMessage('update.download.failed') };
    } finally {
      signal?.removeEventListener('abort', abortFromCaller);
      if (active === controller) active = null;
    }
  }

  /** Bricht einen laufenden Download ab. Ohne laufenden Download ein No-op. */
  function cancel() {
    if (!active) return false;
    active.abort();
    return true;
  }

  /** Verwirft die geladene Datei samt Arbeitsverzeichnis. */
  async function discard() {
    cancel();
    ready = null;
    await removeWorkDir();
  }

  function getReady() {
    return ready ? { ...ready } : null;
  }

  /** Arbeitsverzeichnis fuer Zwischenschritte der Installation. */
  function getWorkDir() {
    return workDir;
  }

  return { download, cancel, discard, getReady, getWorkDir };
}

module.exports = {
  createUpdateDownloader,
  isAllowedAssetUrl,
  safeFileName,
  ALLOWED_HOSTS,
};
