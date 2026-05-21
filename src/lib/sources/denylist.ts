// Source denylist for the related-news pipeline. The canonical place that
// decides whether a news domain is state-controlled propaganda, a known
// Kremlin-narrative amplifier, or part of an automated spoof/swarm network.
//
// `isBlockedSource(hostname)` is the single entry point — it applies the static
// tiers AND the pattern matchers, so callers get the swarm-network coverage for
// free. Used by the GDELT collector (src/lib/sources/gdeltArticles.ts) to keep
// these sources out of the auto-published news selection and brief citations.

// ============================================================================
// TIER 1: State-controlled or formally sanctioned outlets.
//
// Inclusion criteria (any one suffices):
//   - Directly state-owned/operated by Russia, Belarus, Iran, China, or DPRK
//   - Designated by the US Treasury (OFAC) as a foreign disinformation entity
//   - Sanctioned by the EU Council (broadcasting ban / asset freeze)
//   - Sanctioned by Ukraine's NSDC as a hostile information operation
//   - Operated from or by Russian occupation administrations in Ukraine
//
// Each entry is defensible by pointing to a specific government action.
// Matched by registered domain or any subdomain.
// ============================================================================
export const STATE_MEDIA_DENYLIST: readonly string[] = [
  // --- Russian state media (federal) -----------------------------------------
  'rt.com',
  'sputnikglobe.com',
  'sputniknews.com',
  'sputniknews.cn',
  'sputnik.by',                // Belarus-targeted Sputnik edition
  'tass.com',
  'tass.ru',
  'ria.ru',
  'rian.ru',
  'ukraina.ru',                // RIA's Ukraine-focused arm, EU-sanctioned
  'tvzvezda.ru',               // MoD broadcaster
  '1tv.ru',                    // Channel One
  'smotrim.ru',                // VGTRK portal (Rossiya 1, Rossiya 24)
  'vesti.ru',                  // VGTRK news
  'ntv.ru',
  'ren.tv',
  '5-tv.ru',
  'iz.ru',                     // Izvestia (EU-sanctioned May 2024)
  'rg.ru',                     // Rossiyskaya Gazeta (EU-sanctioned)
  'kp.ru',                     // Komsomolskaya Pravda
  'pravda.ru',                 // (legacy tabloid; not the Pravda network — see Tier 2)
  'gazeta.ru',
  'lenta.ru',                  // Targeted in 2025 EU sanctions packages
  'regnum.ru',
  'eadaily.com',
  'rubaltic.ru',
  'fondsk.ru',                 // Strategic Culture (Russian-language site)

  // --- Belarusian state media ------------------------------------------------
  'belta.by',                  // State news agency

  // --- Russian occupation press in Ukraine -----------------------------------
  // Outlets operated by occupation administrations in Crimea, Donetsk, Luhansk,
  // Zaporizhzhia, and Kherson regions. Add more as new ones surface.
  'news-front.info',
  'news-front.su',
  'oane.ws',
  'dan-news.info',             // "DAN" — DNR occupation outlet
  'dan-news.ru',
  'lug-info.com',              // LNR occupation outlet
  'lug-info.ru',
  'za-news.ru',                // Zaporizhzhia occupation
  'tavrida.news',              // Crimea occupation
  'crimea24.tv',

  // --- US Treasury OFAC / State Dept designated -----------------------------
  'southfront.org',
  'southfront.press',          // SouthFront's current domain
  'strategic-culture.org',
  'globalresearch.ca',
  'orientalreview.org',
  'journal-neo.org',           // New Eastern Outlook

  // --- NSDC-sanctioned Ukrainian-targeted outlets ---------------------------
  // Decree of President of Ukraine, NSDC decisions Feb 2021 / Aug 2021 / 2022.
  'strana.ua',
  'strana.news',
  'strana.one',
  'strana.today',
  'strana.best',
  'sharij.net',
  'sharii.net',
  '112.ua',                    // 112 Ukraine
  'newsone.ua',
  'zik.ua',
  'vesti.ua',                  // Guzhva-era, related to Strana
  'znaj.ua',
  'politeka.net',
  'klymenko-time.com',
  'golos.ua',
  'timer-odessa.net',

  // --- Iranian state media ---------------------------------------------------
  'presstv.ir',
  'irna.ir',
  'tasnimnews.com',            // IRGC-linked
  'mehrnews.com',

  // --- PRC state media -------------------------------------------------------
  'cgtn.com',
  'globaltimes.cn',
  'xinhuanet.com',
  'news.cn',                   // Xinhua alt
  'people.cn',                 // People's Daily
  'chinadaily.com.cn',
];

// ============================================================================
// TIER 2: Independent outlets consistently flagged as Russian-narrative
// amplifiers by two or more credible monitors (ISD, NewsGuard, EUvsDisinfo,
// Alliance for Securing Democracy, Viginum, RSF).
//
// These are NOT state-owned, but persistently launder Kremlin narratives.
// Treat with softer UI than Tier 1 (e.g. warning label rather than hard
// block) — inclusion here is a judgment call, not a sanction.
// ============================================================================
export const PROPAGANDA_AMPLIFIER_LIST: readonly string[] = [
  // --- Dugin / Eurasianist network ------------------------------------------
  'geopolitica.ru',
  'katehon.com',

  // --- "Anti-imperialist" English-language amplifiers -----------------------
  'thegrayzone.com',
  'mintpressnews.com',
  'consortiumnews.com',
  'covertactionmagazine.com',
  'thealtworld.com',
  'thecradle.co',
  'theduran.com',
  'voltairenet.org',           // Thierry Meyssan
  'unz.com',                   // Ron Unz
  'fort-russ.com',
  'fort-russ.io',
  'anti-spiegel.ru',           // German-language Kremlin amplifier

  // --- Foreign "war correspondents" set up specifically post-2022 ----------
  'donbassinsider.com',        // Christelle Néant
  'international-reporters.com', // RSF documented Feb 2025
];

// ============================================================================
// PATTERN MATCHERS for swarm networks. These outpace any static list.
// Apply in addition to the denylists above.
// ============================================================================

/**
 * Pravda network ("Portal Kombat"). Per NewsGuard (Mar 2025): 150 domains,
 * 49 countries, 3.6 million articles in 2024 — purpose-built to flood LLM
 * training data and search results with pro-Kremlin narratives.
 * First detected by France's Viginum agency.
 */
export const PRAVDA_NETWORK_PATTERN =
  /(^|\.)(news-)?pravda-([a-z]{2,3})\.(com|news|info)$/i;

// Also catches `*.news-pravda.com` subdomain swarm (NATO.news-pravda.com, etc.)
export const PRAVDA_SUBDOMAIN_PATTERN =
  /(^|\.)news-pravda\.com$/i;

/**
 * Doppelganger campaign (Social Design Agency / Structura). Clones legitimate
 * outlets — Bild, Spiegel, Le Monde, Welt, Repubblica, Washington Post,
 * Ukrainska Pravda, Fox News, etc. — on lookalike TLDs. Hundreds of throwaway
 * domains; enumerate the persistent anchors, regex the rest.
 *
 * Pair a known-brand stem with a Doppelganger-favored TLD.
 */
const DOPPELGANGER_BRAND_STEMS = [
  'bild', 'spiegel', 'welt', 'faz', 'tagesspiegel', 'sueddeutsche',
  't-online', 'tonline', 'morgenpost', 'nd-aktuell',
  'lemonde', 'leparisien', 'lepoint', 'liberation', 'la-croix', '20minuts',
  'repubblica', 'ansa',
  'theguardian', 'dailymail', 'washingtonpost', 'fox-news',
  'pravda-ua', 'ua-pravda', 'unian', 'obozrevatel', 'rbk',
  'walla', 'mako',
];

const DOPPELGANGER_TLDS = [
  'ltd', 'beauty', 'lol', 'life', 'live', 'today', 'work', 'ws', 'cc',
  'pm', 'fm', 'cab', 'fun', 'ink', 'pro', 'quest', 'tours', 'media',
  'cam', 'cfd', 'top', 'agency', 'expert', 'pics', 'llc', 'asia',
  'eu.com', 'co.com',
];

export const DOPPELGANGER_PATTERN = new RegExp(
  `(^|\\.)(${DOPPELGANGER_BRAND_STEMS.join('|')})[a-z]{0,2}\\.(${DOPPELGANGER_TLDS.join('|').replace(/\./g, '\\.')})$`,
  'i'
);

/**
 * Convenience: check a hostname against everything.
 */
export function isBlockedSource(hostname: string): 'state' | 'amplifier' | 'pravda' | 'doppelganger' | null {
  const host = hostname.toLowerCase().replace(/^www\./, '');

  const matchesList = (list: readonly string[]) =>
    list.some(d => host === d || host.endsWith('.' + d));

  if (matchesList(STATE_MEDIA_DENYLIST)) return 'state';
  if (PRAVDA_NETWORK_PATTERN.test(host) || PRAVDA_SUBDOMAIN_PATTERN.test(host)) return 'pravda';
  if (DOPPELGANGER_PATTERN.test(host)) return 'doppelganger';
  if (matchesList(PROPAGANDA_AMPLIFIER_LIST)) return 'amplifier';
  return null;
}
