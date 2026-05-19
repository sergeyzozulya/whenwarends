// Thin re-export so the scheduled worker registers the Oryx
// confirmed-equipment-losses collector without reaching into src/lib/sources.

export { oryxCollector } from '../../lib/sources/oryx';
