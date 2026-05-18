// Thin re-export so the scheduled worker can register the NBU collector
// without reaching into src/lib/sources directly.

export { nbuCollector, createNbuCollector } from '../../lib/sources/nbu';
