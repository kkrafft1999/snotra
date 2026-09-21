/**
 * Zustand der mittleren Spalte beim Start (Issues #208, #255, #258).
 *
 * Drei Wuensche treffen aufeinander, und die Reihenfolge ist der Punkt:
 *
 * 1. **Ein wiederhergestellter Chat schlaegt alles** (#208). Wer die App mitten
 *    in einer Konversation verlaesst, soll dort wieder landen — nicht neben dem
 *    Startschirm, der fuer den kalten Start gedacht ist.
 * 2. **Die ausdrueckliche Praeferenz** aus dem Umschalter in der Titelzeile.
 *    `true` blendet die Spalte ein, `false` laesst sie weg; beides steht nur in
 *    den Prefs, wenn der Nutzer den Schalter benutzt hat.
 * 3. **Ohne gespeicherten Wunsch** entscheidet der Ordner (#255, #258): Mit
 *    Ordner bleibt die Spalte zu, denn zu sehen gaebe es nur den Startschirm,
 *    den keiner mehr braucht. Ohne Ordner ist genau er das Richtige — er ist
 *    der Einstieg, und ohne ihn stuende die App leer da.
 *
 * `preference` ist deshalb dreiwertig: `undefined` heisst "nie eingestellt" und
 * ist etwas anderes als ein weggeschaltetes `false`. Der Contract laesst den
 * Schluessel dafuer weg, statt ihn auf `false` zu normalisieren.
 *
 * DOM-frei und exportiert, damit die Entscheidung ohne Fenster pruefbar ist
 * (wie pickSessionToRestore, #78).
 */
export function contentPaneVisibleOnStart({ preference, chatRestored, hasFolder }) {
  if (chatRestored === true) return false;
  if (typeof preference === 'boolean') return preference;
  return hasFolder !== true;
}
