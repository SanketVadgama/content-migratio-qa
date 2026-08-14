// Detection of hardcoded dealer values that should have been replacement codes.
// Mirrors the matching rules of the CMS-side replacement script (GA_.js):
// per-code case-sensitivity (ci) and bounded-substring (ss) behavior, plus
// wave ordering and longest-first processing. Runs on PURE VISIBLE TEXT only.

/** Per-code matching rules, taken verbatim from the replacement script. */
const CODE_RULES: Record<string, { ci: boolean; ss: boolean; wave: number }> = {
  "%(ADDRESS)": { ci: true, ss: false, wave: 1 },
  "%(DEALERSHIP_NAME)": { ci: true, ss: false, wave: 1 },
  "%(DEALERSHIP_MAKE)": { ci: true, ss: false, wave: 2 },
  "#STREET#": { ci: true, ss: false, wave: 2 },
  "%(CITY)": { ci: true, ss: false, wave: 2 },
  "%(STATE-NAME)": { ci: true, ss: false, wave: 2 },
  "%(STATE)": { ci: false, ss: true, wave: 2 },
  "%(ZIP)": { ci: false, ss: false, wave: 2 },
  "#Phone#": { ci: false, ss: false, wave: 2 },
  "#Phone2#": { ci: false, ss: false, wave: 2 },
  "#Phone3#": { ci: false, ss: false, wave: 2 },
  "%(BIG_CITY2)": { ci: true, ss: false, wave: 2 },
  "%(BIG_CITY3)": { ci: true, ss: false, wave: 2 },
  "%(BIG_CITY4)": { ci: true, ss: false, wave: 2 },
  "%(BIG_CITY5)": { ci: true, ss: false, wave: 2 },
  "%(BIG_CITY6)": { ci: true, ss: false, wave: 2 },
  "%(BIG_CITY7)": { ci: true, ss: false, wave: 2 },
  "%(BIG_CITY8)": { ci: true, ss: false, wave: 2 },
  "%(BIG_CITY9)": { ci: true, ss: false, wave: 2 },
  "%(BIG_CITY10)": { ci: true, ss: false, wave: 2 },
  // Extra placeholders — default to case-sensitive, unbounded, wave 2.
  "%(STATE_ABBREV)": { ci: false, ss: true, wave: 2 },
  "%(MAKES)": { ci: true, ss: false, wave: 2 },
  "%(METRO-STATE)": { ci: true, ss: false, wave: 2 },
  "%(METRO_STATE_NAME)": { ci: true, ss: false, wave: 2 },
  "#Phone-Number#": { ci: false, ss: false, wave: 2 },
  "#Phone2-Number#": { ci: false, ss: false, wave: 2 },
  "#Phone3-Number#": { ci: false, ss: false, wave: 2 },
};

/** Default rule for any code the user provides that isn't in the known table. */
const DEFAULT_RULE = { ci: true, ss: false, wave: 2 };

export interface CodeValuePair {
  code: string;
  value: string;
  ci: boolean;
  ss: boolean;
  wave: number;
}

export interface DealerCodeHit {
  code: string;
  value: string;
  /** Number of times the literal value was found in the text. */
  count: number;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the same regex the replacement script uses. */
function buildRegex(search: string, ci: boolean, ss: boolean): RegExp {
  const escaped = escapeRegExp(search);
  const pattern = ss ? "(?<![A-Za-z])" + escaped + "(?=[,\\.\\s]|$)" : escaped;
  return new RegExp(pattern, ci ? "gi" : "g");
}

/**
 * Parse the user's "code = value" input (one pair per line). Lines without an
 * "=" or with an empty value are ignored. Blank lines and lines starting with
 * "#" as a comment... note: codes legitimately start with "#", so we only treat
 * a line as a comment if it starts with "//".
 */
export function parseCodeValuePairs(input: string): CodeValuePair[] {
  const pairs: CodeValuePair[] = [];
  const seen = new Set<string>();
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const code = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!code || !value) continue;
    const rule = CODE_RULES[code] ?? DEFAULT_RULE;
    // De-dupe identical value+code (avoid double counting).
    const dedupeKey = `${code}::${value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    pairs.push({ code, value, ci: rule.ci, ss: rule.ss, wave: rule.wave });
  }
  return pairs;
}

/**
 * Detect literal dealer values in the given visible text. Processes wave 1
 * before wave 2, and longest value first within each wave, mirroring the
 * script's ordering so a longer value (full address) is counted before a
 * shorter one nested inside it. Once a span of text is attributed to a code,
 * it's masked so a shorter value inside it isn't double-counted.
 */
export function detectDealerValues(text: string, pairs: CodeValuePair[]): DealerCodeHit[] {
  if (!text || pairs.length === 0) return [];

  const ordered = [...pairs].sort((a, b) => {
    if (a.wave !== b.wave) return a.wave - b.wave;
    return b.value.length - a.value.length;
  });

  // Work on a mutable copy we can mask, so nested shorter values aren't
  // recounted inside a longer match.
  let working = text;
  const hits: DealerCodeHit[] = [];

  for (const pair of ordered) {
    const regex = buildRegex(pair.value, pair.ci, pair.ss);
    let count = 0;
    working = working.replace(regex, (match) => {
      count++;
      // Mask with a same-length run of a char that won't re-match.
      return "\u0000".repeat(match.length);
    });
    if (count > 0) {
      hits.push({ code: pair.code, value: pair.value, count });
    }
  }

  return hits;
}
