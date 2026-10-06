'use strict';

const fs = require('fs');
const { parseSales } = require('./parser');
const { InvoiceBuilder, calculateTotal } = require('./invoice');
const { formatCurrency } = require('./utils/currency');

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error('Usage: node src/index.js <sales.csv>');
    process.exit(1);
  }
  const rows = parseSales(fs.readFileSync(file, 'utf8'));
  const builder = new InvoiceBuilder({ currency: 'EUR' });
  for (const row of rows) builder.addLine(row);
  const invoice = builder.build();
  console.log(`Total: ${formatCurrency(calculateTotal(invoice.lines), 'EUR')}`);
}

main(process.argv);
