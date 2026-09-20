// Pfad- und Baumlogik des Dateibaums (Issue #81, herausgeloest aus FileTree.js).
//
// Alles hier ist DOM-frei und ohne Zustand: rein aus Pfaden, Datensaetzen und
// Listen abgeleitet. FileTree.js bleibt damit die Verdrahtung — welcher
// Handler an welcher Zeile haengt, was gezeichnet wird —, waehrend die
// Entscheidungen darueber hier liegen und einzeln pruefbar sind.
//
// Pfade kommen nativ aus dem Main-Prozess (Windows: Backslash), deshalb
// laufen alle Zerlegungen ueber nativePath.js statt ueber split('/') (#73).
import { depthOf, parentDirOf, isInsideDir } from '../utils/nativePath.js';
import { TREE_DRAG_MIME } from '../chat/workspaceReference.js';

export function folderDepthSortKey(dirPath) {
  return depthOf(dirPath);
}

export function parentDirFromItemPath(itemPath) {
  return parentDirOf(itemPath);
}

/**
 * Ordner von oben nach unten: erst der Elternordner, dann seine Kinder.
 * Sowohl das Wiederaufklappen als auch das Neuzeichnen verlassen sich darauf
 * — ein Kind, das vor seinem Elternordner drankaeme, findet dessen Container
 * noch gar nicht. Doppelte Pfade fallen weg, zweimal dasselbe zu zeichnen
 * bringt nichts.
 */
export function sortFoldersTopDown(paths) {
  const unique = [...new Set((paths || []).filter((p) => typeof p === 'string' && p))];
  return unique.sort((a, b) => folderDepthSortKey(a) - folderDepthSortKey(b));
}

/**
 * Einrueckungsbreite einer Zeile zurueck in ihre Baumtiefe rechnen. Der
 * Abstandhalter traegt 16 px je Ebene; ohne Breite steht die Zeile auf der
 * obersten Ebene, ihre Kinder also auf Tiefe 1.
 */
export function treeDepthFromIndentWidth(width) {
  const px = parseInt(width || '4', 10);
  return Math.round((Number.isFinite(px) ? px : 4) / 16) + 1;
}

/**
 * Kommt der Drag von ausserhalb der App (Finder/Explorer)? Issue #101.
 *
 * Zwei Bedingungen: das DataTransfer meldet Dateien **und** es laeuft kein
 * interner Drag aus dem Baum. Ohne die zweite Bedingung wuerde ein internes
 * Verschieben faelschlich als Import gelten. Seit #56 verraet den internen Drag
 * zusaetzlich der eigene MIME-Typ: Den bringt jedes DataTransfer selbst mit,
 * waehrend der Quellpfad nur im Modulzustand dieses Fensters steht.
 */
export function isExternalFileDrop(types, hasInternalSource) {
  if (hasInternalSource) return false;
  const list = Array.from(types || []);
  if (list.includes(TREE_DRAG_MIME)) return false;
  return list.includes('Files');
}

/**
 * Zielordner eines externen Drops: die Ordnerzeile unter dem Zeiger, sonst
 * der Projektordner. Ohne geoeffneten Projektordner gibt es kein Ziel.
 */
export function importDestDirFor(rowDataset, rootPath) {
  if (!rootPath) return null;
  if (rowDataset && rowDataset.isDirectory === 'true' && rowDataset.path) return rowDataset.path;
  return rootPath;
}

/**
 * Ein Eintrag als Vergleichsmarke: Art und Pfad. Reicht, um zu erkennen, ob
 * sich der *Inhalt* eines Ordners geaendert hat — eine ueberschriebene Datei
 * aendert weder Name noch Art und soll den Baum nicht neu zeichnen (#158).
 */
export function listingSignature(path, isDirectory) {
  return `${isDirectory ? 'd' : 'f'}:${path}`;
}

/** Zwei Signaturlisten in Reihenfolge vergleichen. */
export function listingsDiffer(links, rechts) {
  if (links.length !== rechts.length) return true;
  return links.some((eintrag, i) => eintrag !== rechts[i]);
}

/**
 * Welche der sichtbaren Ordner nach einer Watcher-Meldung zu pruefen sind.
 * Bei einer vollstaendigen Meldung nur die gemeldeten; ist sie unvollstaendig
 * (`complete: false`, z. B. nach einem Zweigwechsel), alles Sichtbare — einmal
 * breit pruefen ist billiger als hundert Einzelmeldungen (#158).
 */
export function foldersToCheck({ visible = [], reported = [], complete = true } = {}) {
  if (!complete) return [...visible];
  return visible.filter((dir) => reported.includes(dir));
}

/**
 * Ein neu gezeichneter Ordner verliert seine aufgeklappten Kinder. Die hier
 * zurueckgegebenen Pfade muessen danach wieder aufgeklappt werden: alles, was
 * vorher offen war und unterhalb eines neu gezeichneten Ordners liegt. Der
 * Projektordner ist immer offen und faellt deshalb heraus, ebenso die neu
 * gezeichneten Ordner selbst — die bringt `refreshFolder` schon mit.
 */
export function foldersToReexpand({ expandedBefore = [], redrawn = [], rootPath = null } = {}) {
  return expandedBefore.filter(
    (p) => p !== rootPath && redrawn.some((dir) => p !== dir && isInsideDir(p, dir))
  );
}
