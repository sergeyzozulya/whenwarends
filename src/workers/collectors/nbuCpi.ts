// Thin re-export so the scheduled worker registers the NBU Ukraine headline
// CPI collector (monthly, % y/y) without reaching into src/lib/sources.

export { nbuCpiCollector } from '../../lib/sources/nbuCpi';
