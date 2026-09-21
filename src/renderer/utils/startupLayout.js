/**
 * Zustand der mittleren Spalte beim Start (Issue #208, #255).
 *
 * Voreingestellt bleibt die Spalte zu: Wer nichts gespeichert hat, faengt mit
 * Baum und Chat an (Issue #255). Aufgeklappt startet sie nur, wenn der Nutzer
 * sie ausdruecklich eingeblendet hat — `preference` ist dann `true`, weil in
 * den gespeicherten Prefs `contentPaneVisible: true` steht.
 *
 * Auch dieser Wunsch tritt einmal zurueck: Wer die App mitten in einer
 * Konversation verlaesst, soll genau dort wieder landen und nicht neben dem
 * Startschirm, der fuer den kalten Start gedacht ist. Wird beim Start ein Chat
 * wiederhergestellt, bleibt die Spalte deshalb zu und der Chat bekommt die
 * volle Breite.
 *
 * DOM-frei und exportiert, damit die Entscheidung ohne Fenster pruefbar ist
 * (wie pickSessionToRestore, #78).
 */
export function contentPaneVisibleOnStart({ preference, chatRestored }) {
  if (preference !== true) return false;
  return chatRestored !== true;
}
