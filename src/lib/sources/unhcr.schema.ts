import { z } from 'zod';

// Zod schema for the UNHCR Refugee Data Finder API (population endpoint).
//
// Real endpoint (UNHCR, public, no auth):
//   GET https://api.unhcr.org/population/v1/population/
//         ?limit=1000&yearFrom=2022&yearTo=<year>&coo=UKR&coa_all=true
//
//   coo=UKR fixes the country of ORIGIN to Ukraine; coa_all=true returns one
//   row per country of ASYLUM. Live-verified shape (2026-05-22):
//     { page, "short-url", maxPages, total, items: [ row, ... ] }
//   where each row carries year + the displacement counts. IDPs are attributed
//   to the origin country (the coa=UKR row), so summing `idps` across coa per
//   year yields Ukraine's IDP stock; summing `refugees` yields refugees abroad.
//
//   Numeric fields arrive as numbers OR strings ("0", "-"); the collector
//   coerces and treats non-numeric as 0. We validate only what we read and
//   passthrough the rest.

/** Coerce UNHCR's number|string|"-" cells; non-numeric → 0. */
const countCell = z
  .union([z.number(), z.string()])
  .transform((v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isFinite(n) ? n : 0;
  });

export const UnhcrPopulationRowSchema = z
  .object({
    year: z.number().int(),
    refugees: countCell,
    idps: countCell,
  })
  .passthrough();

export type UnhcrPopulationRow = z.infer<typeof UnhcrPopulationRowSchema>;

export const UnhcrPopulationResponseSchema = z.object({
  items: z.array(UnhcrPopulationRowSchema),
});

export type UnhcrPopulationResponse = z.infer<typeof UnhcrPopulationResponseSchema>;
