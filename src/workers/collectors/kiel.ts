// Thin re-export so the cron runner can mount the Kiel collector alongside
// other scheduled sources. All logic lives in src/lib/sources/kiel.ts.
export { kielCollector } from '../../lib/sources/kiel';
