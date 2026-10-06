# Architecture

## Overview

The tool reads a CSV file, builds invoices and prints a summary.

## Modules

### Parser

`src/parser.js` turns the CSV export into row objects.

### Invoice

`src/invoice.js` holds the arithmetic: totals, discounts and tax.

#### Tax

The tax rate is fixed at 19 %.

### Components

`src/components/` renders the header and footer of an invoice.

## Data flow

CSV → parser → InvoiceBuilder → output.

## Open questions

- Should the tax rate be configurable?
- Do we need multi-currency support?
