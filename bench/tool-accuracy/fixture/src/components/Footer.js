'use strict';

function renderFooter(invoice) {
  return `Payable within 14 days. Currency: ${invoice.currency}`;
}

module.exports = { renderFooter };
