import contracts from '../generated/contracts.js';

const { SKILL_STATUS } = contracts;

/**
 * Der Skill-Katalog wird an zwei Stellen im Chat gebraucht — von der
 * `/`-Vervollständigung (#124) und vom Vorschlag unter dem Eingabefeld
 * (#125). Beide zeigen dieselben Skills, also holen sie ihn auch gemeinsam:
 * Zwei eigene Zwischenspeicher könnten auseinanderlaufen und würden jede
 * Änderung doppelt über die IPC-Grenze tragen.
 *
 * Aktuell gehalten wird er vom Datei-Watcher im Main (#126): `invalidate()`
 * hängt in app.js an dessen Meldung. Die Frist ist nur noch das
 * Sicherheitsnetz für Dateisysteme, auf denen das Betriebssystem nichts
 * meldet — etwa Netzlaufwerke.
 */
const CACHE_MAX_AGE_MS = 5 * 60_000;

/** Aufrufbar ist, was nutzbar ist — verdeckte und kaputte Skills nicht. */
function isInvocable(skill) {
  return skill?.status === SKILL_STATUS.ACTIVE || skill?.status === SKILL_STATUS.AVAILABLE;
}

export function createSkillCatalogSource({ api, appStore }) {
  let cache = null; // { root, skills, fetchedAt }
  let pending = null; // { root, promise }
  let generation = 0;
  const listeners = new Set();

  /** Wird bei jeder Verwerfung gerufen, damit offene Listen nachziehen. */
  function onInvalidated(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  function invalidate() {
    generation += 1;
    cache = null;
    pending = null;
    for (const listener of listeners) listener();
  }

  async function load() {
    if (typeof api?.getSkillCatalog !== 'function') return [];
    // Der Katalog hängt am Workspace (Ordner-Skills), also ist der Root Teil
    // des Schlüssels — auch wenn ohne Ordner die System-Skills bleiben.
    const root = appStore.rootPath || '';
    if (cache?.root === root && Date.now() - cache.fetchedAt < CACHE_MAX_AGE_MS) {
      return cache.skills;
    }
    if (pending?.root === root) return pending.promise;

    const startedAt = generation;
    const promise = (async () => {
      let skills = [];
      try {
        const result = await api.getSkillCatalog();
        skills = Array.isArray(result?.skills) ? result.skills.filter(isInvocable) : [];
      } catch {
        skills = [];
      }
      if (startedAt === generation && (appStore.rootPath || '') === root) {
        cache = { root, skills, fetchedAt: Date.now() };
      }
      if (pending?.promise === promise) pending = null;
      return skills;
    })();
    pending = { root, promise };
    return promise;
  }

  return { load, invalidate, onInvalidated };
}
