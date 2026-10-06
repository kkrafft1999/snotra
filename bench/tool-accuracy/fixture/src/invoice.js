'use strict';

const TAX_RATE = 0.19;

function calculateTotal(lines) {
  let total = 0;
  for (const line of lines) {
    total += line.quantity * line.unit_price;
  }
  return total;
}

function applyDiscount(total, percent) {
  if (percent < 0 || percent > 100) {
    throw new Error('Discount must be between 0 and 100');
  }
  return total - (total * percent) / 100;
}

function calculateTax(total) {
  return total * TAX_RATE;
}

class InvoiceBuilder {
  constructor({ currency }) {
    this.currency = currency;
    this.lines = [];
  }

  addLine(line) {
    this.lines.push(line);
    return this;
  }

  build() {
    const net = calculateTotal(this.lines);
    return {
      currency: this.currency,
      lines: this.lines,
      net,
      tax: calculateTax(net),
    };
  }
}

module.exports = { TAX_RATE, calculateTotal, applyDiscount, calculateTax, InvoiceBuilder };
