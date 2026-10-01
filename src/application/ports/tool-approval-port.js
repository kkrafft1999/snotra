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
 * @property {Array<{ path: string, kind: string, exists: boolean, sensitive: boolean, version?: string|null,
 *   sensitiveReason?: string, recovery?: string, skillName?: string, skillPath?: string }>} targets
 * @property {Array<object>} reasonParts  the card's explanation as catalogue keys, worded in the renderer (#306)
 * @property {string} mode
 * @property {'access'|'output'} checkpoint  before the call runs, or before its sensitive output goes out (§4)
 * @property {boolean} sessionAllowed  ob „Für diese Sitzung erlauben“ angeboten wird
 * @property {object} [sessionScope]  what a session approval covers, as the card says it (#447)
 * @property {string} [providerLabel]  bei read-sensitive: Provider, an den der Inhalt geht
 * @property {string} [providerKey]  bei read-sensitive: the endpoint the content is bound to (§4)
 * @property {{ kind: string, text: string, truncated: boolean, masked: boolean }} [preview]
 * @property {string} planKey  stabiler Schlüssel des validierten Plans
 * @property {string} policyVersion
 * @property {string} [chatId]
 * @property {boolean} [alwaysAllowed]  whether "always allow this command" is offered (#121)
 * @property {string} [alwaysUnavailableReason]  COMMAND_RULE_UNAVAILABLE_REASONS value when it is not
 * @property {object} [commandRule]  the rule main stores on "always"; never sent to the renderer
 */

/**
 * @typedef {Object} ToolApprovalOutcome
 * @property {'allow-once'|'allow-session'|'allow-always'|'deny'} response
 * @property {boolean} [invalidated]  Anfrage verfallen (Abbruch, Fenster zu, Kontextwechsel, keine UI)
 * @property {string} [reason]  PERMISSION_DENIAL_REASONS-Wert bei invalidated
 * @property {string} [requestId]
 * @property {string} [ruleId]  the command rule stored for `allow-always` (#121)
 */

/**
 * @typedef {Object} ToolApprovalPort
 * @property {(sessionId: string|number) => boolean} isAvailable
 * @property {(params: { sessionId: string|number, request: ToolApprovalRequest, abortSignal?: AbortSignal })
 *   => Promise<ToolApprovalOutcome>} requestApproval
 * @property {(sessionId: string|number, reason?: string) => void} [invalidateSession]
 * @property {(chatId: string|null, reason?: string) => void} [invalidateChat]  one chat's open requests (#320)
 * @property {(chatIds: Iterable<string|null>, reason?: string) => void} [invalidateExceptChats]
 *   every open request outside the given chats — the visible one and the running ones (#320)
 */

module.exports = {};
