// Thin re-export for the scheduled cron runner. The runner imports
// `deepStateCollector` (daily Russian-occupied area, km²) and persists its
// result. Only the derived scalar is stored, never the GPL-mirror geometry.
export { deepStateCollector } from '../../lib/sources/deepstate';
