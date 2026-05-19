import { z } from 'zod';

// Oryx visually-confirmed equipment-loss dataset (machine-readable mirror).
//
// Real source (public, no auth, CC BY-NC — non-commercial use, credited):
//   GET https://raw.githubusercontent.com/scarnecchia/oryx_data/main/
//       totals_by_system.csv
//
// One CSV row = one photo-confirmed piece of equipment, e.g.:
//   country,origin,system,status,url,date_recorded,sysID,imageID,statusID,matID
//   Russia,Russia,'Orlan-10' UAV,destroyed,https://…,2022-06-26,1,1,1,7-111
//
// Only `country` ("Russia" | "Ukraine") and `date_recorded` (YYYY-MM-DD) are
// consumed; the cumulative row count per country over time is the honest
// "confirmed equipment losses" series (matches Oryx's own headline method).
// Parsed defensively: unknown columns are ignored; rows whose country isn't
// one of the two belligerents, or whose date is malformed, are dropped.

export const OryxRowSchema = z.object({
  country: z.string(),
  date_recorded: z.string(),
});

export type OryxRow = z.infer<typeof OryxRowSchema>;
