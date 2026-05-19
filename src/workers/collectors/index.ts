// Collector registry. The scheduled cron runner iterates this list; each
// source is failure-isolated by runCollectors (one bad source degrades one
// widget, not the run). Order is informational only.

import type { Collector } from '../../lib/types';
import { polymarketCollector } from './polymarket';
import { manifoldCollector } from './manifold';
import { gdeltCollector } from './gdelt';
import { kielCollector } from './kiel';
import { firmsCollector } from './firms';
import { worldbankCollector } from './worldbank';
import { worldbankGemCollector } from './worldbankGem';
import { nbuCollector } from './nbu';
import { nbuCpiCollector } from './nbuCpi';
import { cbrCollector } from './cbr';
import { oryxCollector } from './oryx';

export const allCollectors: Collector[] = [
  polymarketCollector,
  manifoldCollector,
  gdeltCollector,
  kielCollector,
  firmsCollector,
  worldbankCollector,
  worldbankGemCollector,
  nbuCollector,
  nbuCpiCollector,
  cbrCollector,
  oryxCollector,
];
