// Single integration point for the automated QA backend.
// Phase 1: real static-HTML analysis via a TanStack Start server function.

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

/** Editable blocklist for placeholder dealer-name detection (case-insensitive). */
export const DEALER_NAME_BLOCKLIST: string[] = [
  "DealerOn XXX",
  "Kerndt",
  "Rothbard",
  "Dealer Name Here",
  "XXXX",
  "Lorem Dealer",
];

/**
 * Runs the automated QA batch.
 *
 * Delegates to the TanStack Start server function (`runQaBatchServer`), which
 * runs on the server and can fetch arbitrary public URLs without CORS issues.
 * Input (`QaBatchRow[]`) and output (`QaPageResult[]`) contracts are unchanged,
 * so the UI needs no modification.
 */
export async function runQaBatch(rows: QaBatchRow[]): Promise<QaPageResult[]> {
  const { runQaBatchServer } = await import("./qaEngine.server");
  return runQaBatchServer({ data: rows });
}
