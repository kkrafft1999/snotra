/**
 * ToolApproval-Port (Issue #66, Konzept §6): Nutzerfreigabe für einen
 * Tool-Aufruf, ohne dass der Core weiß, wie die Karte angezeigt wird.
 *
 * Der Adapter im Main-Prozess bindet jede Anfrage an eine zufällige
 * `requestId`, Fenster, Sitzung, Lauf, Tool-Call, Plan und Policy-Version.
 * Antworten dürfen nur eine Entscheidung liefern, keine neuen Argumente.
 * Ohne erreichbare Oberfläche wird eine Anfrage sicher abgelehnt
 * (`invalidated`, Grund `no_approval_ui`).
 */

/**
 * @typedef {Object} ToolApprovalRequest
 * @property {string} tool
 * @property {string[]} riskClasses
 * @property {Array<{ path: string, kind: string, exists: boolean, sensitive: boolean, version?: string|null }>} targets
 * @property {string} reason  Klartext-Begründung für die Karte
 * @property {string} mode
 * @property {boolean} sessionAllowed  ob „Für diese Sitzung erlauben“ angeboten wird
 * @property {string} [sessionScopeLabel]
 * @property {string} [providerLabel]  bei read-sensitive: Provider, an den der Inhalt geht
 * @property {{ kind: string, text: string, truncated: boolean, masked: boolean }} [preview]
 * @property {string} planKey  stabiler Schlüssel des validierten Plans
 * @property {string} policyVersion
 * @property {string} [chatId]
 */

/**
 * @typedef {Object} ToolApprovalOutcome
 * @property {'allow-once'|'allow-session'|'deny'} response
 * @property {boolean} [invalidated]  Anfrage verfallen (Abbruch, Fenster zu, Kontextwechsel, keine UI)
 * @property {string} [reason]  PERMISSION_DENIAL_REASONS-Wert bei invalidated
 * @property {string} [requestId]
 */

/**
 * @typedef {Object} ToolApprovalPort
 * @property {(sessionId: string|number) => boolean} isAvailable
 * @property {(params: { sessionId: string|number, request: ToolApprovalRequest, abortSignal?: AbortSignal })
 *   => Promise<ToolApprovalOutcome>} requestApproval
 * @property {(sessionId: string|number, reason?: string) => void} [invalidateSession]
 */

module.exports = {};
