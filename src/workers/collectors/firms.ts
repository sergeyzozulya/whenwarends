// Thin re-export so the scheduled-collector worker can import every source
// from a uniform path. Logic lives in src/lib/sources/firms.ts.

export { firmsCollector, makeFirmsCollector } from '../../lib/sources/firms';
