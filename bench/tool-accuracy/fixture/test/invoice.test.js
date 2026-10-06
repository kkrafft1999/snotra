'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { calculateTotal, applyDiscount } = require('../src/invoice');

test('calculateTotal sums quantity times unit price', () => {
  assert.strictEqual(calculateTotal([{ quantity: 2, unit_price: 5 }]), 10);
});

test('applyDiscount rejects more than 100 percent', () => {
  assert.throws(() => applyDiscount(100, 120));
});
