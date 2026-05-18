// Thin re-export for the scheduled cron runner. The runner imports
// `polymarketCollector` and persists its result (see src/lib/sources/contract.ts).
export { polymarketCollector } from '../../lib/sources/polymarket';
