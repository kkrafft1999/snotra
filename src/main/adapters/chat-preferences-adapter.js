'use strict';

function createChatPreferencesAdapter({ uiPrefsStore }) {
  return {
    async read() {
      const prefs = await uiPrefsStore.readUIPrefs();
      const out = {
        baseSystemPrompt: typeof prefs.baseSystemPrompt === 'string' ? prefs.baseSystemPrompt : '',
        disabledTools: Array.isArray(prefs.disabledTools)
          ? prefs.disabledTools.filter((name) => typeof name === 'string' && name.trim())
          : [],
      };
      // Nur setzen, wenn der Nutzer die Auswahl je angefasst hat: `undefined`
      // heißt „Voreinstellung“ (System-Skills an), `[]` heißt „nichts an“.
      if (Array.isArray(prefs.activeSkills)) {
        out.activeSkills = prefs.activeSkills.filter((name) => typeof name === 'string' && name.trim());
      }
      if (typeof prefs.maxToolRounds === 'number' && Number.isFinite(prefs.maxToolRounds)) {
        out.maxToolRounds = prefs.maxToolRounds;
      }
      if (typeof prefs.historyCharLimit === 'number' && Number.isFinite(prefs.historyCharLimit)) {
        out.historyCharLimit = prefs.historyCharLimit;
      }
      // Nur der ausdrueckliche Abschaltwert reist mit (Issue #138); fehlt das
      // Feld, bleibt es bei der Voreinstellung „an".
      if (prefs.environmentInfoEnabled === false) {
        out.environmentInfoEnabled = false;
      }
      // Dasselbe fuer die Projektanweisungen (Issue #212).
      if (prefs.projectInstructionsEnabled === false) {
        out.projectInstructionsEnabled = false;
      }
      // Und fuer die beiden Gedaechtnis-Ebenen (Issue #166). `memorySelfEnabled`
      // steht bewusst nicht hier: Ob Snotra ungefragt merken darf, betrifft das
      // Schreiben und wird im Memory-Adapter geprueft — der Chat-Core baut nur
      // den Prompt und hat damit nichts zu tun.
      if (prefs.memoryWorkspaceEnabled === false) {
        out.memoryWorkspaceEnabled = false;
      }
      if (prefs.memoryUserEnabled === false) {
        out.memoryUserEnabled = false;
      }
      return out;
    },
  };
}

module.exports = {
  createChatPreferencesAdapter,
};
