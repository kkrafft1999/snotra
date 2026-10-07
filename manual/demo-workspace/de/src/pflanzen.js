import { readFileSync } from 'node:fs';

export function lesePflanzen(file = new URL('../pflanzen.csv', import.meta.url)) {
  const [, ...rows] = readFileSync(file, 'utf8').trim().split('\n');
  return rows.map((row) => {
    const [name, spacing, from, until, sun] = row.split(',');
    return { name, spacingCm: Number(spacing), sowFrom: day(from), sowUntil: day(until), sun };
  });
}

const day = (monthDay) => new Date(`2026-${monthDay}`);
