// Collector registry. The scheduled cron runner iterates this list; each
// source is failure-isolated by runCollectors (one bad source degrades one
// widget, not the run). Order is informational only.

import type { Collector } from '../../lib/types';
import { polymarketCollector } from './polymarket';
import { kalshiCollector } from './kalshi';
import { gdeltCollector } from './gdelt';
import { kielCollector } from './kiel';
import { firmsCollector } from './firms';
import { worldbankCollector } from './worldbank';
import { nbuCollector } from './nbu';
import { cbrCollector } from './cbr';

export const allCollectors: Collector[] = [
  polymarketCollector,
  kalshiCollector,
  gdeltCollector,
  kielCollector,
  firmsCollector,
  worldbankCollector,
  nbuCollector,
  cbrCollector,
];
