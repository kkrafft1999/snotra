'use strict';

const { normalizeUsagePeriod } = require('../../shared/contracts/usage-report');

/**
 * The usage report (#1258). The renderer names the days of the period; which
 * chats there are and what they spent is main's business.
 *
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {ReturnType<typeof import('../services/usage-report-service').createUsageReportService>} deps.usageReport
 * @param {Record<string, string>} deps.REQ
 */
function registerUsageReportHandlers({ ipcMain, usageReport, REQ }) {
  ipcMain.handle(REQ.USAGE_REPORT, async (_event, period) =>
    usageReport.report(/** @type {{ from: string|null, to: string|null }} */ (normalizeUsagePeriod(period))));
}

module.exports = { registerUsageReportHandlers };
