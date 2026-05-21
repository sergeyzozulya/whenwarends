// Shared war-end market selection + resolution-date derivation, used by BOTH
// the Polymarket and Manifold collectors so "is this a war-end market" and
// "what date does it resolve" mean exactly the same thing on each platform
// (SPEC §8.1). Pure and deterministic; unit-tested in
// tests/unit/sources/warEndFilter.test.ts.

/**
 * Intent terms for "the Russia–Ukraine war ends / ceasefire / peace deal".
 * Broad on phrasing so live markets ("ceasefire agreement by...", "signs peace
 * deal with Russia", "war end") all match.
 */
export const WAR_END_PATTERN =
  /\b(war ends?|end of (?:the )?war|end the war|ceasefire|cease-fire|truce|armistice|peace deal|peace agreement|peace treaty|peace settlement|peace plan|invasion ends?|end of (?:the )?invasion)\b/i;

/** Must clearly be the Russia–Ukraine conflict, not some other war. */
export const CONFLICT_PATTERN =
  /\b(ukrain\w*|russia\w*|russo[- ]ukrainian|kyiv|kremlin|putin|zelensk\w*)\b/i;

/**
 * Exclusions: markets that mention ceasefire/peace tangentially but are NOT a
 * "when does the war end" forecast (so they don't pollute the chart/CDF). Two
 * groups: (1) off-topic subjects (territory, casualties, personalities, deal
 * terms), and (2) CONDITIONAL framings where the war's end is a deadline/clause
 * for something else ("X before the war ends", "by the time a ceasefire…"),
 * which is the dominant noise on Manifold. Polymarket's curated grid is
 * unaffected (its war-end questions contain none of these).
 */
export const EXCLUDE_PATTERN =
  /\b(referendum (?:scheduled|called)|calls a referendum|capture|captures?|recaptur\w*|troops fighting|enter ukraine|meet next|where will|nobel|nuclear|drone|how many|control|territor\w*|crimea|annex\w*|occup\w*|front ?line|brokered|stalemate|involve\w*|live to see|die|death|interview|presiden\w*|sanction\w*|stop being)\b/i;

/** Conditional/clause framings: the war-end phrase is a deadline, not the subject. */
const CONDITIONAL_PATTERN =
  /(before the (?:end of the )?war|by the time|at the end of the war|once the war|after the war|end up in a stalemate)/i;

/** True when a question reads as a Russia–Ukraine war-end forecast. */
export function isWarEndMarket(question: string): boolean {
  if (/^\s*if\b/i.test(question)) return false; // conditional ("If a peace deal…")
  if (EXCLUDE_PATTERN.test(question)) return false;
  if (CONDITIONAL_PATTERN.test(question)) return false;
  return WAR_END_PATTERN.test(question) && CONFLICT_PATTERN.test(question);
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

/** UTC ISO-8601 (`...Z`) for a given Y/M/D at midnight, or undefined. */
export function isoUtcDate(
  year: number,
  monthIdx: number,
  day: number
): string | undefined {
  if (!Number.isInteger(year) || year < 2022 || year > 2100) return undefined;
  if (monthIdx < 0 || monthIdx > 11) return undefined;
  if (day < 1 || day > 31) return undefined;
  const t = Date.UTC(year, monthIdx, day);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * Best-effort ISO-8601 UTC normalisation of an already-timestamped string.
 * Re-serialises through Date to guarantee a valid UTC `Z` string and reject
 * garbage. Returns undefined when unparseable.
 */
export function toIsoUtc(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

export interface ResolutionDateOpts {
  /** Grouped-market row title, e.g. Polymarket "December 31". */
  groupItemTitle?: string | null;
  /** Platform close/end timestamp (any parseable form), used as last resort. */
  closeIso?: string | null;
  /** Used for the year/now fallback when nothing else is parseable. */
  fallbackIso: string;
}

/**
 * Derive the TRUE per-market resolution date from the question text. Priority:
 *  1. A full date in the question: "by December 31, 2026", "before 2027",
 *     "by June 30" (year inferred from a nearby year or the close date).
 *  2. groupItemTitle ("December 31") + an inferred year.
 *  3. The platform close timestamp (coarse for grouped markets).
 */
export function deriveResolutionDate(
  question: string,
  opts: ResolutionDateOpts
): string {
  const q = question;
  const { groupItemTitle, closeIso, fallbackIso } = opts;

  const yearFromText = q.match(/\b(20\d{2})\b/);
  const endYear = closeIso ? new Date(closeIso).getUTCFullYear() : undefined;
  const fallbackYear = new Date(fallbackIso).getUTCFullYear();

  // "before 2027" → Dec 31 of the prior year (by the end of the year before).
  const beforeYear = q.match(/\bbefore\s+(20\d{2})\b/i);
  if (beforeYear) {
    const y = Number(beforeYear[1]) - 1;
    const iso = isoUtcDate(y, 11, 31);
    if (iso) return iso;
  }

  // "<Month> <Day>" (optionally a year): "by December 31, 2026?" or row text.
  const monthRe =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s*(20\d{2}))?/i;
  const md =
    q.match(monthRe) ?? (groupItemTitle ? groupItemTitle.match(monthRe) : null);
  if (md) {
    const monthIdx = MONTHS[md[1].toLowerCase()];
    const day = Number(md[2]);
    const year = md[3]
      ? Number(md[3])
      : yearFromText
        ? Number(yearFromText[1])
        : endYear ?? fallbackYear;
    const iso = isoUtcDate(year, monthIdx, day);
    if (iso) return iso;
  }

  // "in 2026" / "by 2027" with no month → end of that year.
  const bareYear = q.match(/\b(?:in|by|during)\s+(20\d{2})\b/i);
  if (bareYear) {
    const iso = isoUtcDate(Number(bareYear[1]), 11, 31);
    if (iso) return iso;
  }

  return toIsoUtc(closeIso) ?? fallbackIso;
}
