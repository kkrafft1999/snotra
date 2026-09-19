/**
 * Zustand der mittleren Spalte beim Start (Issue #208).
 *
 * Wer die App mitten in einer Konversation verlaesst, soll genau dort wieder
 * landen — und nicht neben dem Startschirm, der fuer den kalten Start gedacht
 * ist. Wird also beim Start ein Chat wiederhergestellt, bleibt die mittlere
 * Spalte zu und der Chat bekommt die volle Breite. Ohne Chat erscheint der
 * Startschirm wie gehabt.
 *
 * Die ausdrueckliche Praeferenz aus den Einstellungen (Umschalter im
 * Titelbalken) bleibt daneben bestehen: wer die Spalte ausgeblendet hat,
 * behaelt sie ausgeblendet, egal ob ein Chat zurueckkommt.
 *
 * DOM-frei und exportiert, damit die Entscheidung ohne Fenster pruefbar ist
 * (wie pickSessionToRestore, #78).
 */
export function contentPaneVisibleOnStart({ preference, chatRestored }) {
  if (preference === false) return false;
  return chatRestored !== true;
}
