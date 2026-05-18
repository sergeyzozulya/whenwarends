// Thin re-export for the scheduled cron runner. The runner imports
// `cbrCollector` and persists its result (see src/lib/sources/contract.ts).
export { cbrCollector } from '../../lib/sources/cbr';
