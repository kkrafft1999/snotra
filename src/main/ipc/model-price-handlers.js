'use strict';

const MAX_DESCRIBED_MODELS = 200;

/**
 * Prices for the estimated chat cost (#949). The renderer names models and
 * prices only; where the table comes from is main's business.
 */
function registerModelPriceHandlers({ ipcMain, modelPrices, REQ }) {
  ipcMain.handle(REQ.MODEL_PRICES_DESCRIBE, async (_event, models) => {
    const list = Array.isArray(models) ? models.slice(0, MAX_DESCRIBED_MODELS) : [];
    return modelPrices.describe(list.map((entry) => ({
      providerId: typeof entry?.providerId === 'string' ? entry.providerId : '',
      model: typeof entry?.model === 'string' ? entry.model : '',
      baseUrl: typeof entry?.baseUrl === 'string' ? entry.baseUrl : '',
    })));
  });

  ipcMain.handle(REQ.MODEL_PRICES_SET_OVERRIDE, async (_event, payload) =>
    modelPrices.setOverride(payload?.model, payload?.price ?? null));

  ipcMain.handle(REQ.MODEL_PRICES_UPDATE, async () => modelPrices.updateTable());
}

module.exports = { registerModelPriceHandlers };
