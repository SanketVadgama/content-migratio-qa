// Shared QA types, checklist catalog, and constants.
// Imported by BOTH qaEngine.ts (client) and qaEngine.server.ts (server) —
// this file has NO imports from either, which breaks the circular dependency
// that otherwise fails the production build.

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

/** Structured inspection data shown on-screen under a check (never in the PDF/download). */
export interface QaCheckDetails {
  /** Kind of detail payload, so the UI knows how to render it. */
  kind: "images" | "links" | "oversized-images" | "dealer-codes";
  items: QaDetailItem[];
}

export interface QaDetailItem {
  /** For images: the src. For links: the href. */
  primary: string;
  /** For images: the alt text (or empty). For links: the visible link text. */
  secondary?: string;
  /** Per-item status flag, e.g. "tagged" / "untagged" / "missing-alt" / "oversized". */
  flag?: "ok" | "warn" | "fail";
  /** Short human note, e.g. "no alt text" or "declared 4000px wide". */
  note?: string;
  /** Extra lines of detail, e.g. the full list of GA4 data-dotagging attributes on a link. */
  extra?: string[] | undefined;
}

/** One automated check result for a page. */
export interface QaCheck {
  id: string;
  category: CheckCategory;
  label: string;
  status: CheckStatus;
  /** Human-readable supporting detail, present for fail/review checks. */
  evidence?: string | undefined;
  /** Optional structured inspection data — shown on-screen only, omitted from downloads. */
  details?: QaCheckDetails | undefined;
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

/** Master catalog of every check the engine knows how to evaluate. */
export const CHECK_CATALOG: Record<string, { category: CheckCategory; label: string }> = {
  // Responsive / Layout
  "resp-mobile-tablet": {
    category: "Responsive / Layout",
    label: "Mobile and tablet views checked for responsiveness and broken content",
  },
  "resp-image-title-stacking": {
    category: "Responsive / Layout",
    label: "Correct image → title → content stacking on mobile",
  },
  "resp-mobile-360": {
    category: "Responsive / Layout",
    label: "Mobile layout checked down to 360px screen width",
  },
  "resp-header-1800": {
    category: "Responsive / Layout",
    label: "Header checked at 1800px+ for overlap and navigation positioning",
  },
  "resp-overflow": { category: "Responsive / Layout", label: "No horizontal overflow / scrollbar" },
  // Content
  "content-dealer-names": {
    category: "Content",
    label: 'Placeholder dealer names such as "DealerOn XXX", "Kerndt", or "Rothbard" have been replaced',
  },
  "content-lorem": {
    category: "Content",
    label: "Lorem ipsum, class placeholder text, and test/danger text have been removed",
  },
  "content-spelling": {
    category: "Content",
    label: "Spacing and spelling issues from copied/pasted content have been corrected",
  },
  "content-empty-sections": { category: "Content", label: "Empty or unused content sections are hidden" },
  "content-dealer-logo": { category: "Content", label: "Dealer logo is properly cropped and resized" },
  "content-links-carried-over": {
    category: "Content",
    label: "All links from the reference/original page have been carried over",
  },
  "content-single-h1": { category: "Content", label: "Exactly one H1 is present" },
  // Links / Tracking
  "links-ga4": { category: "Links / Tracking", label: "GA4 tagging has been added to applicable internal/external links" },
  "links-404": { category: "Links / Tracking", label: "No links lead to a 404 page" },
  // Technical / Accessibility
  "tech-element-order": { category: "Technical / Accessibility", label: "Element order has been manually reviewed/updated" },
  "tech-custom-forms": { category: "Technical / Accessibility", label: "Custom forms have been run through the tagging generator" },
  "tech-dealer-codes": { category: "Technical / Accessibility", label: "Dealer Info Replacement codes are used where possible" },
  "tech-image-size": {
    category: "Technical / Accessibility",
    label: "Oversized images have been manually resized or use an appropriate width setting",
  },
  "tech-alt-text": {
    category: "Technical / Accessibility",
    label: "Images contain descriptive alt text or appropriate aria-label/background image treatment",
  },
  // Final Review
  "final-case-description": { category: "Final Review", label: "Case description has been re-read" },
  "final-special-requests": { category: "Final Review", label: "All special requests have been completed or addressed" },
};

/**
 * Per-page-type checklists, matching the reference QA tool exactly.
 * Each list is the ordered set of check ids that apply to that page type.
 */
export const CHECKLIST_BY_TYPE: Record<PageType, string[]> = {
  homepage: [
    "resp-mobile-tablet",
    "resp-header-1800",
    "resp-overflow",
    "content-dealer-names",
    "content-lorem",
    "content-spelling",
    "content-empty-sections",
    "content-dealer-logo",
    "content-single-h1",
    "links-ga4",
    "links-404",
    "tech-element-order",
    "tech-dealer-codes",
    "tech-image-size",
    "tech-alt-text",
    "final-case-description",
    "final-special-requests",
  ],
  "content-migration": [
    "resp-mobile-tablet",
    "resp-image-title-stacking",
    "resp-mobile-360",
    "resp-overflow",
    "content-single-h1",
    "content-spelling",
    "content-links-carried-over",
    "links-ga4",
    "links-404",
    "tech-element-order",
    "tech-custom-forms",
    "tech-dealer-codes",
    "tech-image-size",
    "tech-alt-text",
    "final-case-description",
    "final-special-requests",
  ],
  other: [
    "resp-mobile-tablet",
    "resp-overflow",
    "content-single-h1",
    "content-lorem",
    "content-spelling",
    "content-empty-sections",
    "links-ga4",
    "links-404",
    "tech-alt-text",
    "tech-image-size",
    "final-case-description",
    "final-special-requests",
  ],
};

/** Returns the ordered check definitions for a given page type. */
export function checksForType(type: PageType): { id: string; category: CheckCategory; label: string }[] {
  return CHECKLIST_BY_TYPE[type].map((id) => ({
    id,
    category: CHECK_CATALOG[id].category,
    label: CHECK_CATALOG[id].label,
  }));
}

/** Flat union of all known checks (used by the engine's evaluation map). */
export const CHECK_DEFINITIONS: { id: string; category: CheckCategory; label: string }[] = Object.entries(
  CHECK_CATALOG,
).map(([id, def]) => ({ id, category: def.category, label: def.label }));

/** Editable blocklist for placeholder dealer-name detection (case-insensitive). */
export const DEALER_NAME_BLOCKLIST: string[] = [
  "DealerOn XXX",
  "Kerndt",
  "Rothbard",
  "Dealer Name Here",
  "XXXX",
  "Lorem Dealer",
];
