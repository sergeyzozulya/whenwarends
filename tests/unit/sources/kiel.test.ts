import { describe, it, expect } from 'vitest';
import {
  createKielCollector,
  extractCommitmentRows,
  cellText,
  cellNumber,
  cellDate,
  AID_COMMITMENTS_METRIC,
  KielSourceError,
  KIEL_SHEET,
} from '../../../src/lib/sources/kiel';
import type { Env } from '../../../src/lib/types';

// Minimal Env stub — collectors only read operator config off env; the kiel
// collector reads KIEL_DATASET_URL. Cast is justified: nothing else is used.
const envWith = (url?: string): Env =>
  ({ ...(url ? { KIEL_DATASET_URL: url } : {}) } as unknown as Env);

// Mirrors the real "Fig 1. Allocated over time" layout: title/blank rows, a
// header row (with the exact upstream strings), monthly data rows as
// Date + numbers, then a trailing blank row that ends the table.
function realisticMatrix(): unknown[][] {
  return [
    [],
    [null, 'Dynamics of support: total allocations by month'],
    [],
    [null, 'This figure shows total bilateral aid …'],
    [],
    [],
    [
      null,
      'Month',
      'United States, allocated (€ billion)',
      'Europe, allocated (€ billion)',
      'Total aid, committed (€ billion)',
      'Total aid, allocated (€ billion)',
    ],
    [1, new Date(Date.UTC(2022, 0, 1)), 0, 0.0015, 0.2669, 0.2669],
    [2, new Date(Date.UTC(2022, 1, 1)), 0.356, 2.4, 4.0299, 3.2125],
    // a gap month (committed missing) — must be skipped, never fabricated
    [3, new Date(Date.UTC(2022, 2, 1)), 1.07, 3.69, null, 5.1044],
    [],
    [99, 'footnote text that is not a date', 0, 0, 0, 0],
  ];
}

describe('cell helpers', () => {
  it('cellText handles strings, formula {result}, and richText', () => {
    expect(cellText('  Month ')).toBe('Month');
    expect(cellText({ formula: 'A1', result: 'Total' })).toBe('Total');
    expect(cellText({ richText: [{ text: 'Total ' }, { text: 'aid' }] })).toBe(
      'Total aid'
    );
    expect(cellText(null)).toBe('');
  });

  it('cellNumber unwraps formula results and rejects non-numbers', () => {
    expect(cellNumber(4.0299)).toBe(4.0299);
    expect(cellNumber({ formula: 'SUM(x)', result: 1.5 })).toBe(1.5);
    expect(cellNumber('1,234.5')).toBe(1234.5);
    expect(cellNumber(null)).toBeNull();
    expect(cellNumber('n/a')).toBeNull();
  });

  it('cellDate accepts Date, ISO string, formula result; else null', () => {
    const d = new Date(Date.UTC(2022, 0, 1));
    expect(cellDate(d)).toEqual(d);
    expect(cellDate({ formula: 'x', result: d })).toEqual(d);
    expect(cellDate('2022-02-01T00:00:00Z')?.getUTCMonth()).toBe(1);
    expect(cellDate(0.2669)).toBeNull();
    expect(cellDate('not a date')).toBeNull();
  });
});

describe('extractCommitmentRows', () => {
  it('finds headers by text, scales € bn → EUR, anchors to month start', () => {
    const rows = extractCommitmentRows(realisticMatrix());
    expect(rows).toEqual([
      { monthIso: '2022-01-01T00:00:00.000Z', eur: 0.2669 * 1e9 },
      { monthIso: '2022-02-01T00:00:00.000Z', eur: 4.0299 * 1e9 },
    ]); // March skipped (no committed figure); footnote row stops the table
  });

  it('is robust to columns being reordered between releases', () => {
    const rows = extractCommitmentRows([
      [null, 'Total aid, committed (€ billion)', 'Month'],
      [null, 7.5, new Date(Date.UTC(2024, 5, 1))],
      [],
    ]);
    expect(rows).toEqual([
      { monthIso: '2024-06-01T00:00:00.000Z', eur: 7.5e9 },
    ]);
  });

  it('throws when the headers cannot be located', () => {
    expect(() =>
      extractCommitmentRows([
        [null, 'Quarter', 'Some other column'],
        [null, 'Q1', 1],
      ])
    ).toThrow(/Month.*committed|committed.*Month|headers/i);
  });

  it('throws when header is found but there are no monthly rows', () => {
    expect(() =>
      extractCommitmentRows([
        [null, 'Month', 'Total aid, committed (€ billion)'],
        [],
      ])
    ).toThrow(/no monthly rows/i);
  });
});

describe('createKielCollector', () => {
  it('maps the workbook to aid_commitments_eur snapshots', async () => {
    // A tiny real .xlsx built with exceljs so the full fetch→parse→map path
    // is exercised (no network: fetcher is injected).
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(KIEL_SHEET);
    ws.addRow([]);
    ws.addRow([null, 'Month', 'Total aid, committed (€ billion)']);
    ws.addRow([1, new Date(Date.UTC(2023, 8, 1)), 12.5]);
    ws.addRow([2, new Date(Date.UTC(2023, 9, 1)), 13.25]);
    const buf = await wb.xlsx.writeBuffer();

    const collector = createKielCollector({
      fetchKiel: async () => new Uint8Array(buf as ArrayBuffer),
    });
    const { snapshots } = await collector.run(envWith('https://x/kiel.xlsx'));

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      metric: AID_COMMITMENTS_METRIC,
      source: 'kiel',
      ts: '2023-09-01T00:00:00.000Z',
      value: 12.5e9,
      confidence: 1,
    });
    expect(snapshots[1].value).toBe(13.25e9);
  });

  it('throws a typed KielSourceError when the source is unreachable', async () => {
    const collector = createKielCollector({
      fetchKiel: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(collector.run(envWith('https://x/kiel.xlsx'))).rejects.toBeInstanceOf(
      KielSourceError
    );
  });

  it('throws a typed KielSourceError when the bytes are not a workbook', async () => {
    const collector = createKielCollector({
      fetchKiel: async () => new TextEncoder().encode('<html>error</html>').buffer,
    });
    await expect(collector.run(envWith('https://x/kiel.xlsx'))).rejects.toBeInstanceOf(
      KielSourceError
    );
  });
});
