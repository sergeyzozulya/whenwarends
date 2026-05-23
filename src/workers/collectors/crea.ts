// Thin re-export for the scheduled cron runner. The runner imports
// `creaCollector` (cumulative € paid to Russia for fossil fuels) and persists
// its result. Source: CREA Russia Fossil Tracker (CC BY 4.0).
export { creaCollector } from '../../lib/sources/crea';
