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
import { t } from '../i18n.js';

const { TOOL_RISK_CLASSES, TOOL_RISK_CLASS_ORDER } = contracts;

/**
 * Headings of the groups. The contract label describes a single call ("external
 * service") and is shared with the approval card; as a heading above several
 * tools the plural stands here. Since epic #277 both forms come from the
 * catalogue rather than from the contract.
 */
export const TOOL_GROUP_LABEL_KEYS = Object.freeze({
  [TOOL_RISK_CLASSES.READ]: 'tools.riskClass.read',
  [TOOL_RISK_CLASSES.READ_SENSITIVE]: 'tools.riskClass.readSensitive',
  [TOOL_RISK_CLASSES.WRITE]: 'tools.riskClass.write',
  [TOOL_RISK_CLASSES.DELETE]: 'tools.riskClass.delete',
  [TOOL_RISK_CLASSES.EXECUTE]: 'tools.riskClass.execute',
  [TOOL_RISK_CLASSES.EXTERNAL]: 'tools.riskClass.external',
});

/** Was die Klasse im Modus „Intelligent“ bedeutet — Halbsatz für den Gruppenkopf. */
export const TOOL_GROUP_NOTE_KEYS = Object.freeze({
  [TOOL_RISK_CLASSES.READ]: 'tools.class.safe',
  [TOOL_RISK_CLASSES.READ_SENSITIVE]: 'tools.class.sensitiveRead',
  [TOOL_RISK_CLASSES.WRITE]: 'tools.class.write',
  [TOOL_RISK_CLASSES.DELETE]: 'tools.class.overwrite',
  [TOOL_RISK_CLASSES.EXECUTE]: 'tools.class.execute',
  [TOOL_RISK_CLASSES.EXTERNAL]: 'tools.class.external',
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
      label: TOOL_GROUP_LABEL_KEYS[riskClass] ? t(TOOL_GROUP_LABEL_KEYS[riskClass]) : riskClass,
      note: TOOL_GROUP_NOTE_KEYS[riskClass] ? t(TOOL_GROUP_NOTE_KEYS[riskClass]) : '',
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
export function toolStatusBadge(tool, { pythonReady = true, shellReady = true, webSearchHasKey = true } = {}) {
  if (tool?.name === 'run_python' && !pythonReady) {
    return {
      text: t('tools.gate.notConfigured'),
      title: t('tools.gate.python'),
    };
  }
  if (tool?.name === 'shell_execute' && !shellReady) {
    return {
      text: t('tools.gate.notConfigured'),
      title: t('tools.gate.shell'),
    };
  }
  if (tool?.name === 'web_search' && !webSearchHasKey) {
    return {
      text: t('tools.gate.keyMissing'),
      title: t('tools.gate.webSearch'),
    };
  }
  return null;
}

/** „8 von 9 aktiv“ für den Gruppenkopf. */
export function groupCountLabel(total, active) {
  return t('settings.tools.count', { active, total });
}

/** Beschriftung des Gruppen-Schalters: erst anschalten, was noch aus ist. */
export function groupToggleLabel(total, active) {
  return t(active < total ? 'tools.group.allOn' : 'tools.group.allOff');
}
