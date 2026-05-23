// Thin re-export for the scheduled cron runner. The runner imports
// `eiaCollector` (daily Brent crude spot price) and persists its result.
export { eiaCollector } from '../../lib/sources/eia';
