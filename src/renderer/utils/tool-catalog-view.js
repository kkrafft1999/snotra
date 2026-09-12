/**
 * Tool-Katalog der Einstellungen (Issue #98): Gruppierung nach Risikoklasse,
 * Kurz-/Volltext und Status-Hinweise. Bewusst ohne DOM, damit sie mit
 * `node:test` prüfbar ist; das Rendern übernimmt die SettingsModal-Komponente.
 *
 * Die Liste zeigt je Tool nur den Kurztext; der Volltext aus der Registry
 * klappt bei Bedarf auf. Die Risikoklasse steht einmal im Gruppenkopf statt
 * als Badge in jeder Zeile — dort trägt sie zusätzlich, was die Klasse für
 * Rückfragen bedeutet (Konzept §2/§3).
 */
import contracts from '../generated/contracts.js';

const { TOOL_RISK_CLASSES, TOOL_RISK_CLASS_LABELS, TOOL_RISK_CLASS_ORDER } = contracts;

/**
 * Überschriften der Gruppen. Die Contract-Labels beschreiben einen einzelnen
 * Aufruf („Externer Dienst“) und werden von der Freigabekarte mitbenutzt; als
 * Überschrift über mehreren Tools steht hier der Plural.
 */
export const TOOL_GROUP_LABELS = Object.freeze({
  [TOOL_RISK_CLASSES.EXTERNAL]: 'Externe Dienste',
});

/** Was die Klasse im Modus „Intelligent“ bedeutet — Halbsatz für den Gruppenkopf. */
export const TOOL_GROUP_NOTES = Object.freeze({
  [TOOL_RISK_CLASSES.READ]: 'läuft ohne Rückfrage',
  [TOOL_RISK_CLASSES.READ_SENSITIVE]: 'fragt vor sensiblen Dateien nach',
  [TOOL_RISK_CLASSES.WRITE]: 'fragt vor Änderungen nach',
  [TOOL_RISK_CLASSES.DELETE]: 'fragt vor jedem Überschreiben nach',
  [TOOL_RISK_CLASSES.EXECUTE]: 'fragt vor jedem Lauf nach',
  [TOOL_RISK_CLASSES.EXTERNAL]: 'verlässt deinen Rechner, fragt vorher nach',
});

/**
 * Gruppiert den Katalog nach Risikoklasse in der Reihenfolge des Contracts.
 * Leere Gruppen entfallen; die Reihenfolge innerhalb einer Gruppe bleibt die
 * der Registry. Einträge ohne gültige Klasse landen unter „Lesen“ — der
 * Katalog kommt aus dem Main-Prozess und trägt dort immer eine Klasse.
 *
 * @param {Array<{name: string, riskClass?: string}>} tools
 */
export function groupToolCatalog(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const groups = [];
  for (const riskClass of TOOL_RISK_CLASS_ORDER) {
    const members = list.filter((tool) => toolRiskClass(tool) === riskClass);
    if (members.length === 0) continue;
    groups.push({
      riskClass,
      label: TOOL_GROUP_LABELS[riskClass] || TOOL_RISK_CLASS_LABELS[riskClass] || riskClass,
      note: TOOL_GROUP_NOTES[riskClass] || '',
      tools: members,
    });
  }
  return groups;
}

function toolRiskClass(tool) {
  const raw = tool?.riskClass;
  return TOOL_RISK_CLASS_ORDER.includes(raw) ? raw : TOOL_RISK_CLASSES.READ;
}

/** Kurztext für die Zeile; fällt auf den Volltext zurück. */
export function toolShortText(tool) {
  const short = typeof tool?.shortDescription === 'string' ? tool.shortDescription.trim() : '';
  if (short) return short;
  return typeof tool?.description === 'string' ? tool.description.trim() : '';
}

/** Volltext für den aufgeklappten Bereich; leer, wenn er nichts ergänzt. */
export function toolDetailText(tool) {
  const long = typeof tool?.description === 'string' ? tool.description.trim() : '';
  if (!long || long === toolShortText(tool)) return '';
  return long;
}

/**
 * Status-Badge einer Zeile: nur echte Hinweise, dass ein Tool trotz Häkchen
 * nicht angeboten wird (Issue #63/#86). Die Risikoklasse steht im
 * Gruppenkopf und wird hier bewusst nicht wiederholt.
 *
 * @returns {{text: string, title: string}|null}
 */
export function toolStatusBadge(tool, { pythonReady = true, webSearchHasKey = true } = {}) {
  if (tool?.name === 'run_python' && !pythonReady) {
    return {
      text: 'Nicht eingerichtet',
      title:
        'Ohne erlaubte und gefundene Python-Installation wird das Tool dem Modell nicht angeboten (siehe „Python ausführen“).',
    };
  }
  if (tool?.name === 'web_search' && !webSearchHasKey) {
    return {
      text: 'Schlüssel fehlt',
      title:
        'Ohne Tavily-Schlüssel wird das Tool dem Modell nicht angeboten (siehe „Websuche“ weiter unten).',
    };
  }
  return null;
}

/** „8 von 9 aktiv“ für den Gruppenkopf. */
export function groupCountLabel(total, active) {
  return `${active} von ${total} aktiv`;
}

/** Beschriftung des Gruppen-Schalters: erst anschalten, was noch aus ist. */
export function groupToggleLabel(total, active) {
  return active < total ? 'alle an' : 'alle aus';
}
