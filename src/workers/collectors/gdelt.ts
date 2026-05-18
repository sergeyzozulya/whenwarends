// Thin re-export so the scheduled cron runner can register the GDELT
// collector by importing from src/workers/collectors/. All logic lives in
// src/lib/sources/gdelt.ts.

export { gdeltCollector } from '../../lib/sources/gdelt';
