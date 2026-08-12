// Single integration point for the automated QA backend.
// TODO: replace mock with Supabase edge function call

export type PageType = "homepage" | "content-migration" | "other";

export type CheckStatus = "pass" | "fail" | "review" | "na";

export type CheckCategory =
  | "Responsive / Layout"
  | "Content"
  | "Links / Tracking"
  | "Technical / Accessibility"
  | "Final Review";

/** One row of user input from the batch table. */
export interface QaBatchRow {
  id: string;
  pageUrl: string;
  referenceUrl?: string | undefined;
  pageType: PageType;
}

/** One automated check result for a page. */
export interface QaCheck {
  id: string;
  category: CheckCategory;
  label: string;
  status: CheckStatus;
  /** Human-readable supporting detail, present for fail/review checks. */
  evidence?: string | undefined;
}

/** Automated QA result for a single page. */
export interface QaPageResult {
  pageUrl: string;
  pageType: PageType;
  checks: QaCheck[];
}

export const CATEGORY_ORDER: CheckCategory[] = [
  "Responsive / Layout",
  "Content",
  "Links / Tracking",
  "Technical / Accessibility",
  "Final Review",
];

export const CHECK_DEFINITIONS: { id: string; category: CheckCategory; label: string }[] = [
  { id: "resp-mobile-tablet", category: "Responsive / Layout", label: "Mobile and tablet views checked" },
  { id: "resp-overflow", category: "Responsive / Layout", label: "No horizontal overflow / scrollbar" },
  { id: "resp-header-1800", category: "Responsive / Layout", label: "Header checked at 1800px+" },
  { id: "content-single-h1", category: "Content", label: "Exactly one H1 is present" },
  { id: "content-lorem", category: "Content", label: "Lorem ipsum / test text removed" },
  { id: "content-dealer-names", category: "Content", label: "Placeholder dealer names replaced" },
  { id: "content-spelling", category: "Content", label: "Spacing and spelling corrected" },
  { id: "content-empty-sections", category: "Content", label: "Empty sections hidden" },
  { id: "links-ga4", category: "Links / Tracking", label: "GA4 tagging present on links" },
  { id: "links-404", category: "Links / Tracking", label: "No links lead to a 404" },
  { id: "links-carried-over", category: "Links / Tracking", label: "All links from reference carried over" },
  { id: "tech-alt-text", category: "Technical / Accessibility", label: "Images have alt text / aria-label" },
  { id: "tech-image-size", category: "Technical / Accessibility", label: "Oversized images resized" },
  { id: "tech-element-order", category: "Technical / Accessibility", label: "Element order reviewed" },
  { id: "tech-dealer-codes", category: "Technical / Accessibility", label: "Dealer Info Replacement codes used" },
  { id: "final-case-description", category: "Final Review", label: "Case description re-read" },
  { id: "final-special-requests", category: "Final Review", label: "All special requests addressed" },
];

const MOCK_EVIDENCE: Record<string, string> = {
  "resp-overflow": "Horizontal scrollbar detected at 375px — hero image overflows by 24px.",
  "resp-header-1800": "Header container caps at 1440px, leaving unstyled gutters at 1920px.",
  "content-single-h1": "2 H1 elements found (hero heading and section heading).",
  "content-lorem": "1 block of placeholder copy found in the second content section.",
  "content-dealer-names": "Placeholder text \"Dealer Name Here\" found in the footer.",
  "content-spelling": "3 double-space occurrences and 1 suspected typo detected.",
  "links-ga4": "5 of 12 links are missing GA4 event attributes.",
  "links-404": "3 broken links found.",
  "links-carried-over": "2 links present on the reference page were not found on the new page.",
  "tech-alt-text": "2 images missing alt text.",
  "tech-image-size": "1 image served at 4000px wide (rendered at 800px).",
  "tech-element-order": "Section order differs from the reference page in 1 place.",
  "final-case-description": "Manual confirmation required — case description not machine-readable.",
  "final-special-requests": "Manual confirmation required — special requests are free text.",
};

/** Deterministic pseudo-random so repeated runs on the same URL look stable. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function mockStatus(row: QaBatchRow, checkId: string, index: number): CheckStatus {
  const seed = hash(`${row.pageUrl}::${checkId}`) % 100;
  if (checkId === "links-carried-over" && !row.referenceUrl) return "na";
  if (checkId.startsWith("final-")) return seed % 2 === 0 ? "review" : "pass";
  if (seed < 62) return "pass";
  if (seed < 80) return "review";
  if (seed < 92) return "fail";
  return index % 2 === 0 ? "na" : "pass";
}

/**
 * Runs the automated QA batch.
 *
 * TODO: replace mock with Supabase edge function call.
 * Swap the body below for an invoke of the QA edge function; the input
 * (`QaBatchRow[]`) and output (`QaPageResult[]`) contracts stay identical.
 */
export async function runQaBatch(rows: QaBatchRow[]): Promise<QaPageResult[]> {
  await new Promise((resolve) => setTimeout(resolve, 1500));

  return rows.map((row) => ({
    pageUrl: row.pageUrl,
    pageType: row.pageType,
    checks: CHECK_DEFINITIONS.map((definition, index) => {
      const status = mockStatus(row, definition.id, index);
      return {
        id: definition.id,
        category: definition.category,
        label: definition.label,
        status,
        evidence:
          status === "fail" || status === "review"
            ? (MOCK_EVIDENCE[definition.id] ?? "Automated check could not be resolved with confidence.")
            : undefined,
      } satisfies QaCheck;
    }),
  }));
}
