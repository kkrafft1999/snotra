# invoice-tool

A small command-line tool that turns CSV sales data into invoices.

## Installation

```sh
npm install
```

## Usage

```sh
node src/index.js data/sales.csv --currency EUR
```

### Options

- `--currency` — the currency code used for formatting (default `EUR`)
- `--discount` — a percentage discount applied to every invoice

## Development

Run the tests with `npm test`. The build writes to `dist/`.

## License

MIT
