// Thin re-export for the scheduled cron runner. The runner imports
// `unhcrCollector` (annual refugees abroad + IDPs inside Ukraine) and persists
// its result. Source: UNHCR Refugee Data Finder (CC BY 4.0).
export { unhcrCollector } from '../../lib/sources/unhcr';
