'use strict';

function formatCurrency(amount, currency) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(amount);
}

module.exports = { formatCurrency };
