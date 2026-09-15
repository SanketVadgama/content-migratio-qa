// Shared QA types, checklist catalog, and constants.
// Imported by BOTH qaEngine.ts (client) and qaEngine.server.ts (server) —
// this file has NO imports from either, which breaks the circular dependency
// that otherwise fails the production build.

export type PageType = "homepage" | "content-migration" | "other";

export type CheckStatus = "pass" | "fail" | "review" | "na";

export type CheckCategory =
  | "Content"
  | "Styling"
  | "Images and Videos"
  | "Links"
  | "Forms"
  | "Responsiveness"
  | "Accessibility"
  | "If Using AI";

/** One row of user input from the batch table. */
export interface QaBatchRow {
  id: string;
  pageUrl: string;
  referenceUrl?: string | undefined;
  pageType: PageType;
  /** Optional raw CMS HTML (pre-publish) for the accurate replacement-code check. */
  rawHtml?: string | undefined;
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
  "Content",
  "Styling",
  "Images and Videos",
  "Links",
  "Forms",
  "Responsiveness",
  "Accessibility",
  "If Using AI",
];

/** Master catalog of every check the engine knows how to evaluate. */
export const CHECK_CATALOG: Record<string, { category: CheckCategory; label: string }> = {
  // ---------- Content ----------
  "content-from-reference": {
    category: "Content",
    label:
      "The content is migrated from the correct reference page or SEO document. No old text is left over from reused code. No required content is left off the reference page.",
  },
  "content-logical-sections": {
    category: "Content",
    label: "Content is organized logically into sections that support the meaning of the text.",
  },
  "content-interactive-tested": {
    category: "Content",
    label: "Accordions, tabs, sliders, galleries, modals, etc. have been tested for both styling and functionality.",
  },
  "content-sidebar-code": {
    category: "Content",
    label:
      "The sidebar replacement code is included on required pages (namely, practice area pages and the testimonials page).",
  },
  "content-replacement-codes": {
    category: "Content",
    label: "Replacement codes have been used wherever possible for #NAME#, #PHONE#, and other client info.",
  },
  "content-single-h1": { category: "Content", label: "One and only one H1 is included on the page." },
  "content-heading-hierarchy": {
    category: "Content",
    label: "Heading hierarchy is logical: H1 → H2 → H3, with no skipped levels.",
  },

  // ---------- Styling ----------
  "style-branding-aligned": {
    category: "Styling",
    label:
      "Colors, backgrounds, borders, links and other visual styles are aligned with homepage, sidebar page, and client branding.",
  },
  "style-cta-more-links": {
    category: "Styling",
    label: "CTA buttons and .more-links are applied strategically to boost conversion.",
  },
  "style-no-hardcoded-hex": {
    category: "Styling",
    label: "Colors are assigned using classes or variables from sitewide styles, rather than hardcoded hex values.",
  },
  "style-ls-layout": {
    category: "Styling",
    label:
      "Layout meets LS standards - content is organized into components to make it more scannable, engaging, and structured.",
  },

  // ---------- Images and Videos ----------
  "img-relevant": {
    category: "Images and Videos",
    label: "Images are relevant and meaningful to the page topic and client's location.",
  },
  "img-optimized": {
    category: "Images and Videos",
    label: "Images are optimized and resized to reduce file size. Webp format is preferred.",
  },
  "img-lazy-loading": {
    category: "Images and Videos",
    label: "Images below the fold include loading=lazy attribute.",
  },
  "img-dimensions": {
    category: "Images and Videos",
    label: "Images include inherent height and width properties to prevent CLS.",
  },
  "img-alt-text": {
    category: "Images and Videos",
    label: "Detailed alt text has been added to HTML images. CSS images include aria-labels.",
  },
  "video-embeddable-only": { category: "Images and Videos", label: "Only embeddable videos have been migrated." },
  "video-embed-title": { category: "Images and Videos", label: "Embeds include title tags." },

  // ---------- Links ----------
  "links-reference-relative": {
    category: "Links",
    label: "Links match those on the reference site, and use the relative path (ex. /contact.html).",
  },
  "links-ga4": { category: "Links", label: "Links include correct GA4 tagging." },
  "links-new-window": { category: "Links", label: "PDF and external links open in a new window." },
  "links-phone-codes": {
    category: "Links",
    label: "Phone links use the correct phone number replacement codes and are clickable.",
  },

  // ---------- Forms ----------
  "forms-tagging-generator": { category: "Forms", label: "Custom forms have been run through the tagging generator." },
  "forms-no-contactus-ls": { category: "Forms", label: "#CONTACTUS# has not been added to LS sites." },
  "forms-no-sidebar-contact": { category: "Forms", label: "The sidebar is not included on the Contact Us page." },
  "forms-two-form-mix": {
    category: "Forms",
    label: "Pages with two forms use one replacement code form and one custom form, not two of either.",
  },

  // ---------- Responsiveness ----------
  "resp-breakpoints": { category: "Responsiveness", label: "All break points have been checked from 1920px to 360px." },
  "resp-no-horizontal-scroll": {
    category: "Responsiveness",
    label: "No horizontal scroll bars appear on any screen size.",
  },
  "resp-stacking-spacing": {
    category: "Responsiveness",
    label: "Content stacks logically and spacing between elements is correct on stacked content.",
  },
  "resp-columns-height": {
    category: "Responsiveness",
    label: "No side-by-side columns stretch too tall so as to make the content difficult to read.",
  },

  // ---------- Accessibility ----------
  "a11y-spot-check": {
    category: "Accessibility",
    label: "Work has been spot-checked for accessibility using https://ada-des.lovable.app/",
  },

  // ---------- If Using AI ----------
  "ai-no-giveaways": { category: "If Using AI", label: "Ensure visual design doesn't have any obvious AI giveaways." },
  "ai-clean-code": {
    category: "If Using AI",
    label:
      "AI Code is clean, minimal, and follows our best practices. Extend and Bootstrap classes are used wherever possible before applying custom CSS.",
  },
};

/** Every check id, in catalog (category) order. */
const ALL_IDS = Object.keys(CHECK_CATALOG);

/**
 * Per-page-type checklists. The reviewed checklist is identical for every page
 * type — page-specific nuance is handled inside individual checks (e.g. the
 * sidebar and Contact Us rules).
 */
export const CHECKLIST_BY_TYPE: Record<PageType, string[]> = {
  homepage: ALL_IDS,
  "content-migration": ALL_IDS,
  other: ALL_IDS,
};

/** Returns the ordered check definitions for a given page type. */
export function checksForType(type: PageType): { id: string; category: CheckCategory; label: string }[] {
  return CHECKLIST_BY_TYPE[type].map((id) => ({
    id,
    category: CHECK_CATALOG[id].category,
    label: CHECK_CATALOG[id].label,
  }));
}

/**
 * All checks in the catalog, ordered by category then catalog order.
 * Used when the UI should show the full master checklist on every page
 * regardless of page type.
 */
export function allChecks(): { id: string; category: CheckCategory; label: string }[] {
  const entries = Object.entries(CHECK_CATALOG).map(([id, def]) => ({
    id,
    category: def.category,
    label: def.label,
  }));
  return entries.sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
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
