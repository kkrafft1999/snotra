import { getLocale } from '../i18n.js';

// Separators differ between the two languages, so the formatters follow the
// interface language (#290).
const tokenFormatter = () => new Intl.NumberFormat(getLocale());
const oneDecimalFormatter = () => new Intl.NumberFormat(getLocale(), {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * A compact token count: "980", "3.1 K", "17 K". The chat's context
 * breakdown and the settings (#1219) write their figures the same way.
 *
 * @param {unknown} value
 */
export function formatTokensShort(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return tokenFormatter().format(n);
  const inK = n / 1000;
  if (inK < 10) return `${oneDecimalFormatter().format(inK)} K`;
  return `${tokenFormatter().format(Math.round(inK))} K`;
}
