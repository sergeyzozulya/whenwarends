// Thin re-export for the scheduled cron runner. The runner imports
// `worldbankCollector` and persists its result (see src/lib/sources/contract.ts).
export { worldbankCollector } from '../../lib/sources/worldbank';
