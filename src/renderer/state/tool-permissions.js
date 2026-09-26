import { t } from '../i18n.js';
/**
 * Geteilter Stand der Tool-Berechtigungen im Renderer (Issue #67).
 *
 * Der Main-Prozess ist die einzige Autorität (Konzept §5): Dieses Modul liest
 * seinen Stand, stößt Änderungen an und verteilt den neuen Stand an Chat-Pille
 * und Einstellungen, damit beide synchron bleiben. Auto, dauerhafte
 * Erlaubnisse und das Löschen von Sperren bestätigt der Main selbst in einem
 * nativen Dialog – hier kommt nur das Ergebnis an.
 */
export function initToolPermissionState({ api }) {
  let state = null;
  let loading = null;
  const listeners = new Set();

  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        /* ein kaputter Zuhörer darf die anderen nicht blockieren */
      }
    }
  }

  async function refresh() {
    if (typeof api?.getToolPermissionState !== 'function') {
      state = null;
      notify();
      return null;
    }
    if (loading) return loading;
    loading = (async () => {
      try {
        state = await api.getToolPermissionState();
      } catch {
        state = null;
      } finally {
        loading = null;
      }
      notify();
      return state;
    })();
    return loading;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Antwortform des Main: { ok, error?, code? }. `cancelled` = Systemdialog abgebrochen. */
  async function call(name, ...args) {
    if (typeof api?.[name] !== 'function') return { ok: false, error: t('chat.toolMode.unavailable') };
    let result;
    try {
      result = await api[name](...args);
    } catch (error) {
      return { ok: false, error: error?.message || t('approval.error.unknown') };
    }
    if (result?.ok) await refresh();
    return result || { ok: false, error: t('chat.toolMode.noAnswer') };
  }

  if (typeof api?.onToolPermissionsChanged === 'function') {
    api.onToolPermissionsChanged(() => {
      void refresh();
    });
  }

  return {
    refresh,
    subscribe,
    get: () => state,
    mode: () => state?.mode || 'smart',
    setMode: (mode) => call('setToolPermissionMode', mode),
    addRule: (rule) => call('addToolPermissionRule', rule),
    removeRule: (ruleId) => call('removeToolPermissionRule', ruleId),
    setSensitivePathPatterns: (patterns) => call('setSensitivePathPatterns', patterns),
    clearSessionGrants: () => call('clearToolSessionGrants'),
    resetWorkspaceRules: () => call('resetWorkspaceToolRules'),
    resetAll: () => call('resetAllToolPermissions'),
    setWorkspaceSandbox: (enabled) => call('setWorkspaceSandbox', enabled),
    // Program allowances (#408); widening is confirmed natively by main.
    setProgramAllowance: (payload) => call('setProgramAllowance', payload),
    removeProgramAllowance: (programPath) => call('removeProgramAllowance', programPath),
  };
}

export function isCancelledResult(result) {
  return !!result && result.ok !== true && (result.code === 'cancelled' || result.reason === 'cancelled');
}
