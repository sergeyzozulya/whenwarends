// Thin re-export so the scheduled worker registers the World Bank Global
// Economic Monitor collector (sub-annual: RU monthly CPI, RU/UA quarterly
// GDP y/y) without reaching into src/lib/sources directly.

export { worldbankGemCollector } from '../../lib/sources/worldbank';
