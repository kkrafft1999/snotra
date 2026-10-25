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

/**
 * Like `formatTokensShort`, with millions as "6.2 M" rather than "6,200 K" —
 * for the sums of the usage report (#1258), which add up a whole history.
 *
 * @param {unknown} value
 */
export function formatTokensCompact(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  // From 999,500 on the K figure would round to "1,000 K".
  if (n < 999_500) return formatTokensShort(n);
  const inM = n / 1_000_000;
  if (inM < 10) return `${oneDecimalFormatter().format(inM)} M`;
  return `${tokenFormatter().format(Math.round(inM))} M`;
}
