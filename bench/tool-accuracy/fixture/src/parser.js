'use strict';

// Parses the CSV export of the shop system. The first line is the header.
function parseSales(text) {
  const [header, ...lines] = text.trim().split('\n');
  const columns = header.split(',');
  return lines.map((line) => {
    const values = line.split(',');
    const row = {};
    columns.forEach((column, index) => { row[column] = values[index]; });
    row.quantity = Number(row.quantity);
    row.unit_price = Number(row.unit_price);
    return row;
  });
}

module.exports = { parseSales };
