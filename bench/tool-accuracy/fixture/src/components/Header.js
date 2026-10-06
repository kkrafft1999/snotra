'use strict';

function renderHeader(invoice) {
  return `Invoice ${invoice.number} — ${invoice.customer}`;
}

module.exports = { renderHeader };
