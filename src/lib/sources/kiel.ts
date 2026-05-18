// Kiel Ukraine Support Tracker collector — aid commitments curve.
//
// ── Source ──────────────────────────────────────────────────────────────────
//
// Kiel Institute — Ukraine Support Tracker (CC BY 4.0, no auth, free).
//   Landing: https://www.kielinstitut.de/publications/ukraine-support-tracker-data-6453/
//
// Kiel has no JSON/CSV API. The dataset is a versioned Excel workbook whose
// download URL embeds a per-release UUID + `Release_NN` (e.g.
// `…-Ukraine_Support_Tracker_Release_28.xlsx`) and rotates every release. So
// the fetch URL is operator configuration via `KIEL_DATASET_URL`; when Kiel
// ships a new release the operator updates that one env value — no code change.
//
// The workbook's "Fig 1. Allocated over time" sheet carries a clean monthly
// table with a "Month" column (real dates) and a "Total aid, committed
// (€ billion)" column — already in euros, so NO FX conversion is needed. We
// locate the columns by HEADER TEXT (not fixed positions) so ordinary column
// moves between releases don't break ingestion; a major sheet restructure
// fails loudly and in isolation (KielSourceError) rather than fabricating data.

import type { Collector, CollectorResult, Env, SnapshotInput } from '../types';
import ExcelJS from 'exceljs';
import { fetchWithRetry } from './contract';
import { KielExtractedRowsSchema, type KielExtractedRow } from './kiel.schema';

export const KIEL_DEFAULT_URL =
  'https://www.kielinstitut.de/publications/ukraine-support-tracker-data-6453/';

export const AID_COMMITMENTS_METRIC = 'aid_commitments_eur';
export const KIEL_SHEET = 'Fig 1. Allocated over time';
const EUR_PER_BILLION = 1_000_000_000;

export class KielSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message); // ES2020 lib: Error has no options arg; set cause manually
    this.name = 'KielSourceError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Injectable fetcher so tests never hit the network. Returns the raw xlsx. */
export interface KielFetchers {
  fetchKiel: (url: string) => Promise<ArrayBuffer | Uint8Array>;
}

const defaultFetchers: KielFetchers = {
  fetchKiel: async (url) => {
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      throw new KielSourceError(`Kiel source HTTP ${res.status} for ${url}`);
    }
    return res.arrayBuffer();
  },
};

function resolveKielUrl(env: Env): string {
  // KIEL_DATASET_URL is operator configuration, not part of the typed Env
  // contract, and may be absent on a fresh deployment.
  const fromEnv = (env as unknown as { KIEL_DATASET_URL?: unknown })
    .KIEL_DATASET_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return KIEL_DEFAULT_URL;
}

// --- pure cell helpers (exceljs yields {result} for formula cells) ---

function unwrap(v: unknown): unknown {
  if (v && typeof v === 'object' && 'result' in (v as Record<string, unknown>)) {
    return (v as { result: unknown }).result;
  }
  return v;
}

export function cellText(v: unknown): string {
  const u = unwrap(v);
  if (u == null) return '';
  if (typeof u === 'object' && 'richText' in (u as Record<string, unknown>)) {
    const rt = (u as { richText: { text?: string }[] }).richText;
    return rt.map((p) => p.text ?? '').join('').trim();
  }
  return String(u).trim();
}

export function cellNumber(v: unknown): number | null {
  const u = unwrap(v);
  if (typeof u === 'number' && Number.isFinite(u)) return u;
  if (typeof u === 'string' && u.trim() !== '') {
    const n = Number(u.replace(/[\s,]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function cellDate(v: unknown): Date | null {
  const u = unwrap(v);
  if (u instanceof Date && !Number.isNaN(u.getTime())) return u;
  if (typeof u === 'string') {
    const t = Date.parse(u);
    if (!Number.isNaN(t)) return new Date(t);
  }
  return null;
}

function monthStartUtcIso(d: Date): string {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0)
  ).toISOString();
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Pure extraction from a 2-D matrix of cell values (the target sheet's rows).
 * Finds the header row containing a "Month" column and a "…committed…(€…)"
 * column by text, then reads monthly rows until the month column stops being
 * a date. Throws if the headers cannot be found or no rows are produced.
 */
export function extractCommitmentRows(
  rows: unknown[][]
): KielExtractedRow[] {
  let monthCol = -1;
  let commCol = -1;
  let headerRow = -1;

  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    let m = -1;
    let c = -1;
    for (let i = 0; i < cells.length; i++) {
      const txt = norm(cellText(cells[i]));
      if (txt === 'month') m = i;
      if (
        txt.includes('committed') &&
        (txt.includes('€') || txt.includes('eur'))
      ) {
        c = i;
      }
    }
    if (m >= 0 && c >= 0) {
      monthCol = m;
      commCol = c;
      headerRow = r;
      break;
    }
  }

  if (headerRow < 0) {
    throw new Error(
      `Kiel sheet "${KIEL_SHEET}": could not locate "Month" + committed (€) headers`
    );
  }

  const out: KielExtractedRow[] = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    const month = cellDate(cells[monthCol]);
    if (!month) break; // end of the contiguous monthly table
    const bn = cellNumber(cells[commCol]);
    if (bn == null) continue; // a gap month — skip, never fabricate
    out.push({ monthIso: monthStartUtcIso(month), eur: bn * EUR_PER_BILLION });
  }

  if (out.length === 0) {
    throw new Error(
      `Kiel sheet "${KIEL_SHEET}": header found but no monthly rows extracted`
    );
  }
  return out;
}

/** Read the target sheet from a workbook buffer into a 0-based cell matrix. */
async function sheetMatrix(
  buffer: ArrayBuffer | Uint8Array
): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  // exceljs bundles an older `Buffer` type; @types/node's generic
  // `Buffer<ArrayBuffer>` is structurally incompatible but runtime-identical.
  // `any` is the contained, justified escape for this cross-package mismatch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(Buffer.from(buffer as ArrayBuffer) as any);
  const ws = wb.getWorksheet(KIEL_SHEET);
  if (!ws) {
    throw new Error(`workbook has no "${KIEL_SHEET}" sheet`);
  }
  // getSheetValues() is 1-based: index 0 unused, each row 1-based as well.
  const sv = ws.getSheetValues() as unknown[];
  const rows: unknown[][] = [];
  for (let i = 1; i < sv.length; i++) {
    const rv = sv[i];
    rows.push(Array.isArray(rv) ? (rv as unknown[]).slice(1) : []);
  }
  return rows;
}

export function createKielCollector(
  fetchers: KielFetchers = defaultFetchers
): Collector {
  return {
    name: 'kiel',
    async run(env: Env): Promise<CollectorResult> {
      const url = resolveKielUrl(env);

      let buffer: ArrayBuffer | Uint8Array;
      try {
        buffer = await fetchers.fetchKiel(url);
      } catch (err) {
        if (err instanceof KielSourceError) throw err;
        throw new KielSourceError(
          `Kiel source unreachable (${url}): ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err }
        );
      }

      let extracted: KielExtractedRow[];
      try {
        const rows = await sheetMatrix(buffer);
        extracted = extractCommitmentRows(rows);
      } catch (err) {
        throw new KielSourceError(
          `Kiel workbook unparseable (${url}): ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err }
        );
      }

      // Zod-validate at the boundary; downstream works with typed objects.
      const records = KielExtractedRowsSchema.parse(extracted);
      const snapshots: SnapshotInput[] = records.map((rec) => ({
        metric: AID_COMMITMENTS_METRIC,
        source: 'kiel',
        ts: rec.monthIso,
        value: rec.eur,
        raw_blob: JSON.stringify({ eur_billion: rec.eur / EUR_PER_BILLION }),
        confidence: 1,
      }));
      return { snapshots };
    },
  };
}

export const kielCollector: Collector = createKielCollector();
