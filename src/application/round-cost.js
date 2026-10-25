'use strict';

const { mergeSessionCost } = require('../shared/contracts/cost');

/**
 * The estimated cost of one round as a chat's sum takes it (#949): what
 * `streamRound` priced, in the shape `ChatHistoryPort.addCost` adds. A round
 * the provider reported no usage for has none, whatever came of it — a
 * failed or cancelled round that was billed counts like a failed turn.
 *
 * @param {{ cost?: { entry: object, priceTable: { date: string, origin: string }|null } }|null|undefined} round
 * @returns {ReturnType<typeof mergeSessionCost>}
 */
function roundCost(round) {
  if (!round?.cost) return null;
  return mergeSessionCost(null, { models: [round.cost.entry], priceTable: round.cost.priceTable });
}

module.exports = { roundCost };
