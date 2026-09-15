// Phase 1 automated QA engine — runs on the server (Nitro) via TanStack Start.
// Fetches public page HTML, parses it with node-html-parser (no browser), and
// resolves every check in CHECK_DEFINITIONS with real logic where statically
// decidable, or an honest "review"/"na" where a rendered browser (Phase 2) is
// required. One bad page never fails the batch.

import { createServerFn } from "@tanstack/react-start";
import { parse, type HTMLElement } from "node-html-parser";
import {
  parseCodeValuePairs,
  detectDealerValues,
  resolveSiteType,
  filterPairsForSite,
  type CodeValuePair,
  type SiteType,
} from "./dealerCodes";
import {
  allChecks,
  DEALER_NAME_BLOCKLIST,
  type CheckStatus,
  type QaBatchRow,
  type QaCheck,
  type QaCheckDetails,
  type QaDetailItem,
  type QaPageResult,
} from "./qaEngineTypes";

const USER_AGENT = "Mozilla/5.0 (compatible; MigrationQA/1.0)";
const PAGE_TIMEOUT_MS = 15_000;
const MAX_LINKS_PER_PAGE = 100;
const PAGE_CONCURRENCY = 4;
const LINK_CONCURRENCY = 6;

// Optional Phase 2 render service (self-hosted Playwright). When RENDER_SERVICE_URL
// is set, the responsive checks call it for real measurements; otherwise they fall
// back to honest "review" placeholders so the app still works without it.
const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || "";
const RENDER_SERVICE_TOKEN = process.env.RENDER_SERVICE_TOKEN || "";

interface RenderCheck {
  pass: boolean | null;
  detail: string;
}
interface RenderResults {
  overflow: RenderCheck;
  header1800: RenderCheck;
  stacking: RenderCheck;
}

async function callRenderService(url: string): Promise<RenderResults | null> {
  if (!RENDER_SERVICE_URL) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    const res = await fetch(`${RENDER_SERVICE_URL.replace(/\/$/, "")}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, token: RENDER_SERVICE_TOKEN }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = (await res.json()) as { ok: boolean; results?: RenderResults };
    return data.ok && data.results ? data.results : null;
  } catch {
    return null;
  }
}

function renderCheckToStatus(c: RenderCheck): { status: CheckStatus; evidence?: string } {
  if (c.pass === true) return { status: "pass" };
  if (c.pass === false) return { status: "fail", evidence: c.detail };
  return { status: "review", evidence: c.detail };
}

interface FetchedPage {
  ok: boolean;
  status: number;
  html: string;
  error?: string;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = PAGE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
      signal: controller.signal,
      ...init,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensure a URL has a scheme. Users often paste "example.com/page" without
 * "https://", which makes fetch() throw. Prepend https:// when missing.
 * Protocol-relative ("//host/path") becomes https:. Returns trimmed input.
 */
function normalizeUrl(input: string): string {
  const url = input.trim();
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  return `https://${url}`;
}

async function fetchPage(url: string): Promise<FetchedPage> {
  try {
    const res = await fetchWithTimeout(normalizeUrl(url));
    const html = await res.text();
    return { ok: res.ok, status: res.status, html };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      html: "",
      error: err instanceof Error ? err.message : "Unknown fetch error",
    };
  }
}

/** Run tasks with a fixed concurrency limit, preserving input order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function visibleText(root: HTMLElement): string {
  // Drop script/style so their contents don't pollute text checks.
  root.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
  return root.text.replace(/\s+/g, " ").trim();
}

/**
 * Isolate the main content region so QA ignores header, footer, and nav.
 * Strategy: on a clone, remove all chrome (header/footer/nav/offer aside),
 * then prefer an explicit content container in priority order. Returns the
 * scoped node plus a label of which region was used (for the report).
 */
function scopeToContent(fullHtml: string): { region: string; node: HTMLElement } {
  const clone = parse(fullHtml);

  const stripSelectors = [
    // Chrome by semantic tag — but NOT the top-level document landmarks only;
    // these are safe because content headings never live inside <header>/<footer>/<nav>.
    "header",
    "footer",
    "nav",
    "script",
    "style",
    "noscript",
    // Known DealerOn/LeadScience chrome wrappers (specific, not substring-matched).
    ".headerWrapper",
    ".sitewide-footer-content",
    '[aria-label="Offers"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="navigation"]',
    "#nav",
    "#nav-sidebar",
    "#navbar-header",
    "#horizontal-navbar-collapse",
    "#vertical-navbar-collapse",
  ];
  stripSelectors.forEach((sel) => {
    try {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    } catch {
      /* invalid selector on some parsers — skip */
    }
  });

  const preferred = ["#content-main", "#content", "main", '[role="main"]', "article"];
  for (const sel of preferred) {
    const el = clone.querySelector(sel);
    if (el && el.text.replace(/\s+/g, "").length > 0) {
      return { region: sel, node: el };
    }
  }
  return { region: "body (fallback)", node: clone };
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function isCheckableLink(href: string): boolean {
  const h = href.trim().toLowerCase();
  if (!h) return false;
  if (h.startsWith("#")) return false;
  if (h.startsWith("mailto:")) return false;
  if (h.startsWith("tel:")) return false;
  if (h.startsWith("javascript:")) return false;
  return true;
}

function normalizeDest(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return `${u.origin}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

// Images larger than this (in bytes) are flagged as too heavy.
const IMAGE_SIZE_LIMIT_BYTES = 150 * 1024; // 150KB
const IMAGE_SIZE_CONCURRENCY = 6;

/**
 * Fetch an image's byte size. Tries a HEAD request for Content-Length first
 * (cheap); if that's missing, falls back to a GET and measures the body.
 * Returns null if the size can't be determined.
 */
async function imageByteSize(url: string): Promise<number | null> {
  try {
    const head = await fetchWithTimeout(url, { method: "HEAD" }, PAGE_TIMEOUT_MS);
    const len = head.headers.get("content-length");
    if (len && /^\d+$/.test(len)) return parseInt(len, 10);
  } catch {
    /* fall through to GET */
  }
  try {
    const res = await fetchWithTimeout(url, { method: "GET" }, PAGE_TIMEOUT_MS);
    const len = res.headers.get("content-length");
    if (len && /^\d+$/.test(len)) return parseInt(len, 10);
    const buf = await res.arrayBuffer();
    return buf.byteLength;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

/**
 * True if an element sits inside an accordion or FAQ region. Such links are
 * intentionally excluded from GA4 tagging, so we skip them in that check.
 * Walks up the ancestor chain looking for accordion/FAQ signals in class,
 * id, role, or data attributes.
 */
function isInAccordionOrFaq(el: HTMLElement | null): boolean {
  const signalRe = /(accordion|faq|collapse|collapsible|expander|disclosure)/i;
  let node: HTMLElement | null = el;
  let depth = 0;
  while (node && depth < 25) {
    const hay = (
      (node.getAttribute("class") ?? "") +
      " " +
      (node.getAttribute("id") ?? "") +
      " " +
      (node.getAttribute("role") ?? "") +
      " " +
      node.rawAttrs
    ).toLowerCase();
    if (signalRe.test(hay)) return true;
    node = node.parentNode as HTMLElement | null;
    depth++;
  }
  return false;
}

interface LinkCheckResult {
  status: number;
  /** Why it's considered broken, for the evidence line. Empty if OK. */
  problem: string;
}

/** Signals in page text/title that indicate a soft 404 (200 that's really "not found"). */
const SOFT_404_SIGNALS = [
  "404",
  "page not found",
  "page cannot be found",
  "page can't be found",
  "page you requested",
  "page you were looking for",
  "page you are looking for",
  "page doesn't exist",
  "page does not exist",
  "page no longer exists",
  "no longer exists",
  "nothing was found",
  "not be found",
  "couldn't find",
  "could not find",
  "can't find the page",
  "cannot find the page",
  "sorry, we couldn't find",
  "oops! that page",
  "oops, that page",
  "error 404",
  "404 error",
  "not found",
  "doesn't seem to exist",
  "does not seem to exist",
  "we can't seem to find",
  "this page may have been moved",
];

interface SoftFingerprint {
  title: string;
  length: number;
  sample: string;
}

/** Fetch a guaranteed-nonexistent URL on a base to fingerprint the site's soft-404 page. */
async function probeSoft404(base: string): Promise<SoftFingerprint | null> {
  try {
    const probeUrl = new URL(`/qa-probe-${Math.random().toString(36).slice(2, 10)}-does-not-exist/`, base).toString();
    const res = await fetchWithTimeout(probeUrl, { method: "GET" }, PAGE_TIMEOUT_MS);
    // If the probe correctly 404s, the site uses real status codes — no soft-404 baseline needed.
    if (res.status >= 400) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return null;
    const html = await res.text();
    const root = parse(html);
    const title = (root.querySelector("title")?.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const text = root.text.replace(/\s+/g, " ").trim().toLowerCase();
    return { title, length: text.length, sample: text.slice(0, 500) };
  } catch {
    return null;
  }
}

/**
 * Check a link with soft-404 + redirect-to-home detection.
 * Uses GET (some servers hide real 404s behind lenient HEAD handling).
 * `homeOrigin` is the site's homepage URL, used to spot links that only
 * "work" by redirecting to the homepage.
 */
async function checkLink(url: string, homeOrigin: string, softFp: SoftFingerprint | null): Promise<LinkCheckResult> {
  try {
    const res = await fetchWithTimeout(url, { method: "GET" }, PAGE_TIMEOUT_MS);

    if (res.status >= 400) {
      return { status: res.status, problem: `HTTP ${res.status}` };
    }

    // Redirect-to-home: final URL is the homepage but the link wasn't the homepage.
    if (homeOrigin) {
      const finalNorm = normalizeDest(res.url || url);
      const homeNorm = normalizeDest(homeOrigin);
      const reqNorm = normalizeDest(url);
      if (finalNorm === homeNorm && reqNorm !== homeNorm) {
        return { status: res.status, problem: "redirects to homepage (page likely gone)" };
      }
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const html = await res.text();
      const root = parse(html);
      const title = (root.querySelector("title")?.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const bodyText = root.text.replace(/\s+/g, " ").trim().toLowerCase();

      // (a) Definitive: the page's own canonical/og:url points at a 404 page.
      //     Many CMSes render a 200 body but self-identify via canonical="/404".
      const canonical = (
        root.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
        root.querySelector('meta[property="og:url"]')?.getAttribute("content") ??
        ""
      ).toLowerCase();
      if (/\/404(\.\w+)?(\/|$|\?)/.test(canonical) || /not[-_]?found/.test(canonical)) {
        return { status: res.status, problem: "soft 404 (canonical points to 404 page)" };
      }

      // (b) Title signal: a not-found phrase in the <title> is decisive.
      const titleHit = SOFT_404_SIGNALS.find((sig) => title.includes(sig));
      if (titleHit) {
        return { status: res.status, problem: `soft 404 (title: "${titleHit}")` };
      }

      // (c) Baseline fingerprint match (same title as the site's known 404 page).
      if (softFp && softFp.title.length > 0 && title === softFp.title) {
        return { status: res.status, problem: "soft 404 (matches site's not-found page)" };
      }

      // (d) Body signal, gated to short pages so real articles that merely
      //     mention "404"/"not found" aren't flagged.
      const bodyHit = SOFT_404_SIGNALS.find((sig) => bodyText.slice(0, 4000).includes(sig));
      if (bodyHit && bodyText.length < 1500) {
        return { status: res.status, problem: `soft 404 ("${bodyHit}")` };
      }
    }

    return { status: res.status, problem: "" };
  } catch {
    return { status: 0, problem: "unreachable" };
  }
}

function buildChecks(
  pageType: QaBatchRow["pageType"],
  map: Record<string, { status: CheckStatus; evidence?: string; details?: QaCheckDetails }>,
): QaCheck[] {
  // Show the full master checklist on every page, regardless of page type.
  void pageType;
  return allChecks().map((def) => {
    const r = map[def.id] ?? { status: "review" as CheckStatus, evidence: "Not evaluated." };
    return {
      id: def.id,
      category: def.category,
      label: def.label,
      status: r.status,
      evidence: r.status === "fail" || r.status === "review" ? r.evidence : undefined,
      details: r.details,
    } satisfies QaCheck;
  });
}

async function analyzePage(
  row: QaBatchRow,
  dealerPairsAll: CodeValuePair[] = [],
  siteFallback: SiteType = "automotive",
  websiteBase = "",
): Promise<QaPageResult> {
  const pageUrl = normalizeUrl(row.pageUrl);
  // URL detection wins; the manual toggle is only a fallback.
  const effectiveSiteType = resolveSiteType(pageUrl, siteFallback);
  const dealerPairs = filterPairsForSite(dealerPairsAll, effectiveSiteType);
  const referenceUrl = row.referenceUrl ? normalizeUrl(row.referenceUrl) : "";
  const page = await fetchPage(pageUrl);

  // Whole page unreachable → mark everything review, never crash the batch.
  if (!page.ok || !page.html) {
    const reason = page.error
      ? `Could not fetch page: ${page.error}`
      : `Could not fetch page (HTTP ${page.status}).`;
    const map: Record<string, { status: CheckStatus; evidence?: string; details?: QaCheckDetails }> = {};
    allChecks().forEach((def, i) => {
      map[def.id] = { status: "review", evidence: i === 0 ? reason : "Page not analyzed." };
    });
    return { pageUrl, pageType: row.pageType, checks: buildChecks(row.pageType, map) };
  }

  // Scope to main content — header, footer, and nav are explicitly NOT QA'd.
  const { region, node: root } = scopeToContent(page.html);
  const scopedHtml = root.toString();
  const text = visibleText(parse(scopedHtml));
  const lowerText = text.toLowerCase();
  const lowerHtml = scopedHtml.toLowerCase();

  const map: Record<string, { status: CheckStatus; evidence?: string; details?: QaCheckDetails }> = {};
  const scopeNote = ` (scoped to ${region})`;

  // ======================= CONTENT =======================

  // content-single-h1
  {
    const count = root.querySelectorAll("h1").length;
    map["content-single-h1"] =
      count === 1
        ? { status: "pass" }
        : { status: "fail", evidence: `${count} h1 element${count === 1 ? "" : "s"} found${scopeNote}.` };
  }

  // content-heading-hierarchy — no skipped levels (H1 → H2 → H3)
  {
    const headings = root
      .querySelectorAll("h1,h2,h3,h4,h5,h6")
      .map((h) => ({ level: parseInt(h.tagName.slice(1), 10), text: h.text.replace(/\s+/g, " ").trim() }));
    if (headings.length === 0) {
      map["content-heading-hierarchy"] = { status: "fail", evidence: `No headings found${scopeNote}.` };
    } else {
      const skips: string[] = [];
      let previous = 0;
      headings.forEach((h) => {
        if (previous && h.level > previous + 1) {
          skips.push(`H${previous} → H${h.level} ("${h.text.slice(0, 50)}")`);
        }
        previous = h.level;
      });
      map["content-heading-hierarchy"] =
        skips.length === 0
          ? { status: "pass", evidence: `${headings.length} headings, no skipped levels${scopeNote}.` }
          : { status: "fail", evidence: `${skips.length} skipped heading level(s): ${skips.slice(0, 5).join("; ")}.` };
    }
  }

  // content-interactive-tested — detect interactive widgets; functionality itself is manual
  {
    const widgetSelectors = [
      '[class*="accordion"]',
      '[class*="collapse"]',
      '[class*="tab-"]',
      '[role="tab"]',
      '[class*="slider"]',
      '[class*="carousel"]',
      '[class*="gallery"]',
      '[class*="modal"]',
      '[data-bs-toggle]',
      '[data-toggle]',
    ];
    let found = 0;
    widgetSelectors.forEach((sel) => {
      try {
        found += root.querySelectorAll(sel).length;
      } catch {
        /* skip unsupported selector */
      }
    });
    map["content-interactive-tested"] =
      found === 0
        ? { status: "na", evidence: `No accordions, tabs, sliders, galleries or modals detected${scopeNote}.` }
        : {
            status: "review",
            evidence: `${found} interactive element(s) detected — styling and functionality need a manual test.`,
          };
  }

  // content-sidebar-code — required on practice area and testimonials pages
  {
    const path = (() => {
      try {
        return new URL(pageUrl).pathname.toLowerCase();
      } catch {
        return pageUrl.toLowerCase();
      }
    })();
    const requiresSidebar =
      /(practice|attorney|service|area|testimonial|review)/.test(path) || row.pageType === "content-migration";
    const rawSource = (row.rawHtml ?? page.html).toLowerCase();
    const hasSidebarCode = /#sidebar[a-z_]*#/.test(rawSource) || /%\(sidebar/.test(rawSource);
    const hasSidebarMarkup =
      /class="[^"]*sidebar/.test(page.html.toLowerCase()) || /id="[^"]*sidebar/.test(page.html.toLowerCase());
    if (!requiresSidebar) {
      map["content-sidebar-code"] = { status: "na", evidence: "Page does not appear to require the sidebar." };
    } else if (hasSidebarCode || hasSidebarMarkup) {
      map["content-sidebar-code"] = {
        status: "pass",
        evidence: hasSidebarCode ? "Sidebar replacement code found." : "Sidebar markup rendered on the page.",
      };
    } else {
      map["content-sidebar-code"] = {
        status: "fail",
        evidence: "No sidebar replacement code or sidebar markup found on a page that requires one.",
      };
    }
  }

  // ======================= STYLING =======================

  // style-no-hardcoded-hex — inline hex colours in style attributes / style blocks
  {
    const inlineHex = Array.from(page.html.matchAll(/style="[^"]*?(#[0-9a-fA-F]{3,8})\b[^"]*"/g)).map((m) => m[1]);
    const styleBlocks = Array.from(page.html.matchAll(/<style[\s\S]*?<\/style>/gi)).join(" ");
    const blockHex = Array.from(styleBlocks.matchAll(/#[0-9a-fA-F]{6}\b/g)).map((m) => m[0]);
    const all = [...inlineHex, ...blockHex];
    const unique = Array.from(new Set(all.map((h) => h.toLowerCase())));
    map["style-no-hardcoded-hex"] =
      all.length === 0
        ? { status: "pass", evidence: "No hardcoded hex colors found in inline styles or embedded style blocks." }
        : {
            status: "fail",
            evidence: `${all.length} hardcoded hex color value(s) found (${unique
              .slice(0, 8)
              .join(", ")}) — use sitewide classes or variables instead.`,
          };
  }

  // style-cta-more-links
  {
    const ctas =
      root.querySelectorAll('a[class*="btn"]').length +
      root.querySelectorAll('a[class*="more-link"]').length +
      root.querySelectorAll('[class*="cta"]').length;
    map["style-cta-more-links"] =
      ctas === 0
        ? { status: "fail", evidence: `No CTA buttons or .more-links found in the content${scopeNote}.` }
        : { status: "review", evidence: `${ctas} CTA/.more-link element(s) found — strategic placement is a manual call.` };
  }

  map["style-branding-aligned"] = {
    status: "review",
    evidence: "Manual review — compare against the homepage, sidebar page, and client branding.",
  };
  map["style-ls-layout"] = {
    status: "review",
    evidence: "Manual review — component structure and scannability need a visual check.",
  };

  // ======================= LINKS (shared collection) =======================
  const anchors = root.querySelectorAll("a");
  const rawHrefs = anchors.map((a) => a.getAttribute("href") ?? "").filter((h) => isCheckableLink(h));

  // links-ga4
  {
    if (anchors.length === 0) {
      map["links-ga4"] = { status: "na" };
    } else {
      const linkItems: QaDetailItem[] = [];
      let tagged = 0;
      let applicable = 0;
      anchors.forEach((a) => {
        const attrs = a.rawAttrs;
        const attrsLower = attrs.toLowerCase();
        const href = a.getAttribute("href") ?? "";
        const onclick = (a.getAttribute("onclick") ?? "").toLowerCase();
        const linkText = a.text.replace(/\s+/g, " ").trim();

        // Accordion/FAQ links are intentionally not GA4-tagged — exclude them.
        if (isInAccordionOrFaq(a)) {
          linkItems.push({
            primary: href || "(no href)",
            secondary: linkText || "(no text)",
            flag: "ok",
            note: "excluded (accordion/FAQ)",
          });
          return;
        }

        applicable++;
        const isTagged =
          attrsLower.includes("data-dotagging") ||
          attrsLower.includes("ga4") ||
          attrsLower.includes("gtm") ||
          onclick.includes("gtag") ||
          onclick.includes("datalayer") ||
          href.toLowerCase().includes("utm_");
        if (isTagged) tagged++;

        const ga4Attrs: string[] = [];
        const attrRegex = /(data-dotagging-[a-z-]+)="([^"]*)"/gi;
        let m: RegExpExecArray | null;
        while ((m = attrRegex.exec(attrs)) !== null) {
          ga4Attrs.push(`${m[1]}="${m[2]}"`);
        }

        linkItems.push({
          primary: href || "(no href)",
          secondary: linkText || "(no text)",
          flag: isTagged ? "ok" : "warn",
          note: isTagged ? "GA4 tagged" : "no GA4 tagging",
          extra: ga4Attrs.length ? ga4Attrs : undefined,
        });
      });
      const total = applicable;
      const details: QaCheckDetails = { kind: "links", items: linkItems };
      map["links-ga4"] =
        total === 0
          ? { status: "pass", evidence: `All links excluded (accordion/FAQ)${scopeNote}.`, details }
          : tagged === total
            ? { status: "pass", details }
            : {
                status: "fail",
                evidence: `${total - tagged} of ${total} applicable links missing GA4 tagging${scopeNote}.`,
                details,
              };
    }
  }

  // links-new-window — PDF and external links must open in a new window
  {
    let pageHost = "";
    try {
      pageHost = new URL(pageUrl).host.replace(/^www\./, "");
    } catch {
      pageHost = "";
    }
    const items: QaDetailItem[] = [];
    let offenders = 0;
    let applicable = 0;
    anchors.forEach((a) => {
      const href = (a.getAttribute("href") ?? "").trim();
      if (!isCheckableLink(href)) return;
      const isPdf = /\.pdf(\?|#|$)/i.test(href);
      let isExternal = false;
      if (/^https?:\/\//i.test(href)) {
        try {
          isExternal = new URL(href).host.replace(/^www\./, "") !== pageHost;
        } catch {
          isExternal = false;
        }
      }
      if (!isPdf && !isExternal) return;
      applicable++;
      const target = (a.getAttribute("target") ?? "").toLowerCase();
      const ok = target === "_blank";
      if (!ok) offenders++;
      items.push({
        primary: href,
        secondary: a.text.replace(/\s+/g, " ").trim(),
        flag: ok ? "ok" : "fail",
        note: `${isPdf ? "PDF" : "external"} · ${ok ? 'target="_blank"' : "opens in same window"}`,
      });
    });
    if (applicable === 0) {
      map["links-new-window"] = { status: "na", evidence: `No PDF or external links found${scopeNote}.` };
    } else {
      const details: QaCheckDetails = { kind: "links", items };
      map["links-new-window"] =
        offenders === 0
          ? { status: "pass", evidence: `All ${applicable} PDF/external link(s) open in a new window.`, details }
          : {
              status: "fail",
              evidence: `${offenders} of ${applicable} PDF/external link(s) do not open in a new window.`,
              details,
            };
    }
  }

  // links-phone-codes — phone numbers must be clickable tel: links using replacement codes
  {
    const telLinks = anchors.filter((a) => (a.getAttribute("href") ?? "").toLowerCase().startsWith("tel:"));
    const phoneRe = /(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
    const plainNumbers = Array.from(new Set((text.match(phoneRe) ?? []).map((n) => n.trim())));
    const linkedNumbers = new Set(
      telLinks.map((a) => (a.getAttribute("href") ?? "").replace(/[^\d]/g, "").slice(-10)),
    );
    const unlinked = plainNumbers.filter((n) => !linkedNumbers.has(n.replace(/[^\d]/g, "").slice(-10)));
    const rawSource = row.rawHtml ?? "";
    const usesPhoneCode = /#phone[a-z_]*#/i.test(rawSource) || /%\(\s*phone/i.test(rawSource);
    const hardcodedTel = telLinks.filter((a) => /\d{7,}/.test(a.getAttribute("href") ?? ""));

    const items: QaDetailItem[] = telLinks.map((a) => ({
      primary: a.getAttribute("href") ?? "",
      secondary: a.text.replace(/\s+/g, " ").trim(),
      flag: "ok",
      note: "clickable tel: link",
    }));
    unlinked.forEach((n) =>
      items.push({ primary: n, secondary: "", flag: "fail", note: "phone number is not clickable" }),
    );

    if (telLinks.length === 0 && plainNumbers.length === 0) {
      map["links-phone-codes"] = { status: "na", evidence: `No phone numbers found${scopeNote}.` };
    } else if (unlinked.length > 0) {
      map["links-phone-codes"] = {
        status: "fail",
        evidence: `${unlinked.length} phone number(s) are not clickable: ${unlinked.slice(0, 5).join(", ")}.`,
        details: { kind: "links", items },
      };
    } else if (rawSource && !usesPhoneCode && hardcodedTel.length > 0) {
      map["links-phone-codes"] = {
        status: "fail",
        evidence: `${hardcodedTel.length} tel: link(s) hardcode the number instead of using a phone replacement code.`,
        details: { kind: "links", items },
      };
    } else {
      map["links-phone-codes"] = {
        status: "pass",
        evidence: `${telLinks.length} clickable phone link(s), no unlinked numbers${scopeNote}.`,
        details: { kind: "links", items },
      };
    }
  }

  // links-reference-relative — internal links must use relative paths, must not be
  // broken, and must match the reference page's link set.
  {
    const homeOrigin = websiteBase ? normalizeUrl(websiteBase) : "";
    let pageHost = "";
    try {
      pageHost = new URL(pageUrl).host.replace(/^www\./, "");
    } catch {
      pageHost = "";
    }

    // (a) absolute internal links that should be relative
    const absoluteInternal: string[] = [];
    anchors.forEach((a) => {
      const href = (a.getAttribute("href") ?? "").trim();
      if (!/^https?:\/\//i.test(href)) return;
      try {
        if (new URL(href).host.replace(/^www\./, "") === pageHost) absoluteInternal.push(href);
      } catch {
        /* ignore */
      }
    });

    // (b) broken links (real 404 + soft-404 detection)
    const resolveForCheck = (href: string): string | null => {
      const h = href.trim();
      if (/^https?:\/\//i.test(h)) return h;
      if (h.startsWith("/") && homeOrigin) {
        try {
          return new URL(h, homeOrigin).toString();
        } catch {
          return null;
        }
      }
      return absolutize(h, pageUrl);
    };
    const resolved = rawHrefs.map(resolveForCheck).filter((u): u is string => !!u && /^https?:\/\//i.test(u));
    const unique = Array.from(new Set(resolved.map(normalizeDest)));
    const capped = unique.length > MAX_LINKS_PER_PAGE;
    const toCheck = unique.slice(0, MAX_LINKS_PER_PAGE);

    let probeBase = homeOrigin;
    if (!probeBase) {
      try {
        probeBase = new URL(pageUrl).origin;
      } catch {
        probeBase = "";
      }
    }
    const softFp = toCheck.length && probeBase ? await probeSoft404(probeBase) : null;
    const results = await pool(toCheck, LINK_CONCURRENCY, async (u) => ({
      url: u,
      ...(await checkLink(u, homeOrigin, softFp)),
    }));
    const broken = results.filter((r) => r.problem !== "");

    // (c) reference comparison
    let missingFromReference: string[] = [];
    let referenceNote = "";
    if (referenceUrl) {
      const ref = await fetchPage(referenceUrl);
      if (!ref.ok || !ref.html) {
        referenceNote = ` Reference page could not be fetched${ref.error ? `: ${ref.error}` : ` (HTTP ${ref.status})`}.`;
      } else {
        const refRoot = scopeToContent(ref.html).node;
        const pathsOf = (r: HTMLElement, base: string) =>
          new Set(
            r
              .querySelectorAll("a")
              .map((a) => a.getAttribute("href") ?? "")
              .filter(isCheckableLink)
              .map((h) => absolutize(h, base))
              .filter((u): u is string => !!u && /^https?:\/\//i.test(u))
              .map((u) => {
                try {
                  return new URL(u).pathname.replace(/\/$/, "").toLowerCase();
                } catch {
                  return u.toLowerCase();
                }
              }),
          );
        const refSet = pathsOf(refRoot, referenceUrl);
        const newSet = pathsOf(root, pageUrl);
        missingFromReference = [...refSet].filter((p) => !newSet.has(p));
      }
    } else {
      referenceNote = " No reference URL supplied, so link parity was not compared.";
    }

    const items: QaDetailItem[] = results.map((r) => ({
      primary: r.url,
      flag: r.problem ? "fail" : "ok",
      note: r.problem ? r.problem : `OK (${r.status})`,
    }));
    absoluteInternal.forEach((h) =>
      items.push({ primary: h, flag: "fail", note: "absolute internal URL — use a relative path" }),
    );
    missingFromReference.forEach((p) =>
      items.push({ primary: p, flag: "warn", note: "on reference page, missing here" }),
    );

    const problems: string[] = [];
    if (broken.length) {
      problems.push(
        `${broken.length} broken link(s): ${broken
          .slice(0, 4)
          .map((b) => `${b.url} — ${b.problem}`)
          .join("; ")}`,
      );
    }
    if (absoluteInternal.length) {
      problems.push(`${absoluteInternal.length} internal link(s) use an absolute URL instead of a relative path`);
    }
    if (missingFromReference.length) {
      problems.push(
        `${missingFromReference.length} reference link(s) missing here: ${missingFromReference.slice(0, 4).join(", ")}`,
      );
    }

    if (toCheck.length === 0 && absoluteInternal.length === 0) {
      map["links-reference-relative"] = { status: "na", evidence: `No checkable links found${scopeNote}.` };
    } else if (problems.length === 0) {
      map["links-reference-relative"] = {
        status: "pass",
        evidence: `Checked ${toCheck.length} link(s) — all reachable and relative.${referenceNote}`,
        details: { kind: "links", items },
      };
    } else {
      map["links-reference-relative"] = {
        status: "fail",
        evidence: `${problems.join(". ")}.${capped ? ` Only first ${MAX_LINKS_PER_PAGE} links checked.` : ""}${referenceNote}`,
        details: { kind: "links", items },
      };
    }
  }

  // ======================= CONTENT (reference parity) =======================
  {
    const leftovers = DEALER_NAME_BLOCKLIST.filter((term) => lowerHtml.includes(term.toLowerCase()));
    const placeholders = ["lorem ipsum", "dolor sit amet", "your text here", "insert text", "sample text"].filter((p) =>
      lowerText.includes(p),
    );
    const problems: string[] = [];
    if (leftovers.length) problems.push(`leftover placeholder text from reused code: ${leftovers.join(", ")}`);
    if (placeholders.length) problems.push(`placeholder copy present: ${placeholders.join(", ")}`);

    if (referenceUrl) {
      const ref = await fetchPage(referenceUrl);
      if (ref.ok && ref.html) {
        const refText = visibleText(scopeToContent(ref.html).node);
        const sentences = refText
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 60);
        const missing = sentences.filter((s) => !text.includes(s.slice(0, 60)));
        if (sentences.length > 0) {
          const pct = Math.round(((sentences.length - missing.length) / sentences.length) * 100);
          if (missing.length > 0) {
            problems.push(
              `${missing.length} of ${sentences.length} reference passages not found on the new page (${pct}% carried over)`,
            );
          }
        }
      } else {
        problems.push("reference page could not be fetched for comparison");
      }
    }

    if (!referenceUrl) {
      map["content-from-reference"] = {
        status: problems.length ? "fail" : "review",
        evidence: problems.length
          ? problems.join("; ") + "."
          : "Add a reference URL to auto-compare the migrated copy against the source page.",
      };
    } else {
      map["content-from-reference"] = problems.length
        ? { status: "fail", evidence: problems.join("; ") + "." }
        : { status: "pass", evidence: "All reference copy found on the new page and no leftover placeholder text." };
    }
  }

  // content-logical-sections — structural signal only; meaning is manual
  {
    const sections = root.querySelectorAll("section").length + root.querySelectorAll('div[class*="section"]').length;
    const emptySections = [
      ...root.querySelectorAll("section"),
      ...root.querySelectorAll('div[class*="section"]'),
    ].filter((el) => !el.querySelector("img") && !el.querySelector("iframe") && el.text.replace(/\s+/g, "").length === 0);
    map["content-logical-sections"] =
      emptySections.length > 0
        ? { status: "fail", evidence: `${emptySections.length} empty/unused section(s) found${scopeNote}.` }
        : {
            status: "review",
            evidence: `${sections} content section(s) found — logical order needs a manual read.`,
          };
  }

  // content-replacement-codes (#NAME#, #PHONE#, other client info)
  if (dealerPairs.length === 0) {
    map["content-replacement-codes"] = {
      status: "review",
      evidence: "Add client code = value pairs above to auto-check for hardcoded values.",
    };
  } else {
    const usingRaw = Boolean(row.rawHtml && row.rawHtml.trim());
    const sourceText = usingRaw ? visibleText(scopeToContent(row.rawHtml as string).node) : text;
    const sourceLabel = usingRaw ? "raw CMS HTML" : `scoped to ${region}`;
    const sourceNote = ` (${sourceLabel} · ${effectiveSiteType})`;
    const hits = detectDealerValues(sourceText, dealerPairs);
    if (hits.length === 0) {
      map["content-replacement-codes"] = {
        status: "pass",
        evidence: `No hardcoded client values found${sourceNote}.`,
      };
    } else {
      const totalOccurrences = hits.reduce((sum, h) => sum + h.count, 0);
      const items: QaDetailItem[] = hits.map((h) => ({
        primary: h.value,
        secondary: h.code,
        flag: "fail",
        note: `should be ${h.code}${h.count > 1 ? ` · ${h.count}×` : ""}`,
      }));
      map["content-replacement-codes"] = {
        status: "fail",
        evidence: `${hits.length} value(s) hardcoded that should use replacement codes (${totalOccurrences} occurrence(s))${sourceNote}.`,
        details: { kind: "dealer-codes", items },
      };
    }
  }

  // ======================= IMAGES AND VIDEOS =======================
  const imgEls = root.querySelectorAll("img");
  interface ImgInfo {
    el: (typeof imgEls)[number];
    absSrc: string | null;
    rawSrc: string;
    bytes: number | null;
  }
  const imgInfos: ImgInfo[] = await pool(imgEls, IMAGE_SIZE_CONCURRENCY, async (img) => {
    const rawSrc = img.getAttribute("src") ?? "";
    const absSrc = rawSrc ? absolutize(rawSrc, pageUrl) : null;
    const bytes = absSrc && /^https?:\/\//i.test(absSrc) ? await imageByteSize(absSrc) : null;
    return { el: img, absSrc, rawSrc, bytes };
  });

  // img-alt-text
  {
    const cssImageEls = root.querySelectorAll('[style*="background-image"]');
    if (imgInfos.length === 0 && cssImageEls.length === 0) {
      map["img-alt-text"] = { status: "na" };
    } else {
      const imgItems: QaDetailItem[] = [];
      const missing = imgInfos.filter(({ el: img, absSrc, rawSrc, bytes }) => {
        const alt = img.getAttribute("alt");
        const aria = img.getAttribute("aria-label");
        const role = (img.getAttribute("role") ?? "").toLowerCase();
        const hidden = (img.getAttribute("aria-hidden") ?? "").toLowerCase();
        const decorative = role === "presentation" || hidden === "true";
        const isMissing = !decorative && !alt && !aria;
        const thin = !isMissing && !decorative && (alt ?? aria ?? "").trim().length < 10;
        const sizeNote = bytes != null ? ` · ${formatBytes(bytes)}` : "";
        imgItems.push({
          primary: absSrc ?? rawSrc ?? "(no src)",
          secondary: alt ?? aria ?? "",
          flag: isMissing ? "fail" : thin ? "warn" : "ok",
          note:
            (decorative
              ? "decorative (exempt)"
              : isMissing
                ? "MISSING alt text"
                : thin
                  ? "alt text is very short"
                  : alt
                    ? "has alt text"
                    : "has aria-label") + sizeNote,
        });
        return isMissing;
      });
      const cssMissingAria = cssImageEls.filter((el) => !el.getAttribute("aria-label") && el.text.trim().length === 0);
      cssMissingAria.forEach((el) => {
        const bg = /background-image:\s*url\(['"]?([^'")]+)/i.exec(el.getAttribute("style") ?? "");
        imgItems.push({
          primary: bg ? (absolutize(bg[1], pageUrl) ?? bg[1]) : "(css background image)",
          secondary: "",
          flag: "fail",
          note: "CSS image missing aria-label",
        });
      });
      const details: QaCheckDetails = { kind: "images", items: imgItems };
      const totalMissing = missing.length + cssMissingAria.length;
      map["img-alt-text"] =
        totalMissing === 0
          ? { status: "pass", details }
          : {
              status: "fail",
              evidence: `${missing.length} image(s) missing alt text and ${cssMissingAria.length} CSS image(s) missing aria-label${scopeNote}.`,
              details,
            };
    }
  }

  // img-optimized — file size + webp preference
  {
    if (imgInfos.length === 0) {
      map["img-optimized"] = { status: "na" };
    } else {
      const items: QaDetailItem[] = [];
      let overLimit = 0;
      let nonWebp = 0;
      imgInfos.forEach(({ el: img, absSrc, rawSrc, bytes }) => {
        const src = absSrc ?? rawSrc ?? "";
        const isWebp = /\.webp(\?|#|$)/i.test(src) || /\.avif(\?|#|$)/i.test(src);
        const isOver = bytes != null && bytes > IMAGE_SIZE_LIMIT_BYTES;
        if (isOver) overLimit++;
        if (!isWebp) nonWebp++;
        const parts = [bytes != null ? formatBytes(bytes) : "size unknown", isWebp ? "webp/avif" : "not webp"];
        items.push({
          primary: src || "(no src)",
          secondary: img.getAttribute("alt") ?? "",
          flag: isOver ? "fail" : isWebp ? "ok" : "warn",
          note: (isOver ? "OVER 150KB — " : "") + parts.join(" · "),
        });
      });
      const details: QaCheckDetails = { kind: "oversized-images", items };
      if (overLimit > 0) {
        map["img-optimized"] = {
          status: "fail",
          evidence: `${overLimit} image(s) over 150KB${nonWebp ? `; ${nonWebp} not in webp format` : ""}${scopeNote}.`,
          details,
        };
      } else if (nonWebp > 0) {
        map["img-optimized"] = {
          status: "review",
          evidence: `All images within 150KB, but ${nonWebp} are not webp — webp is preferred.`,
          details,
        };
      } else {
        map["img-optimized"] = { status: "pass", evidence: `All images webp and within 150KB${scopeNote}.`, details };
      }
    }
  }

  // img-lazy-loading — everything after the first two images should be lazy
  {
    if (imgInfos.length === 0) {
      map["img-lazy-loading"] = { status: "na" };
    } else {
      const belowFold = imgInfos.slice(2);
      const items: QaDetailItem[] = [];
      const missing = belowFold.filter(({ el: img, absSrc, rawSrc }) => {
        const loading = (img.getAttribute("loading") ?? "").toLowerCase();
        const ok = loading === "lazy";
        items.push({
          primary: absSrc ?? rawSrc ?? "(no src)",
          secondary: img.getAttribute("alt") ?? "",
          flag: ok ? "ok" : "fail",
          note: ok ? 'loading="lazy"' : "missing loading=lazy",
        });
        return !ok;
      });
      const details: QaCheckDetails = { kind: "images", items };
      map["img-lazy-loading"] =
        belowFold.length === 0
          ? { status: "na", evidence: "All images are above the fold." }
          : missing.length === 0
            ? { status: "pass", evidence: `All ${belowFold.length} below-the-fold image(s) are lazy loaded.`, details }
            : {
                status: "fail",
                evidence: `${missing.length} of ${belowFold.length} below-the-fold image(s) missing loading="lazy".`,
                details,
              };
    }
  }

  // img-dimensions — inherent width/height to prevent CLS
  {
    if (imgInfos.length === 0) {
      map["img-dimensions"] = { status: "na" };
    } else {
      const items: QaDetailItem[] = [];
      const missing = imgInfos.filter(({ el: img, absSrc, rawSrc }) => {
        const w = img.getAttribute("width");
        const h = img.getAttribute("height");
        const ok = Boolean(w && h);
        items.push({
          primary: absSrc ?? rawSrc ?? "(no src)",
          secondary: img.getAttribute("alt") ?? "",
          flag: ok ? "ok" : "fail",
          note: ok ? `${w}×${h}` : `missing ${!w && !h ? "width and height" : !w ? "width" : "height"}`,
        });
        return !ok;
      });
      const details: QaCheckDetails = { kind: "images", items };
      map["img-dimensions"] =
        missing.length === 0
          ? { status: "pass", evidence: `All ${imgInfos.length} image(s) declare width and height.`, details }
          : {
              status: "fail",
              evidence: `${missing.length} of ${imgInfos.length} image(s) missing inherent width/height (CLS risk).`,
              details,
            };
    }
  }

  // video-embeddable-only / video-embed-title
  {
    const iframes = root.querySelectorAll("iframe");
    const videoTags = root.querySelectorAll("video");
    if (iframes.length === 0 && videoTags.length === 0) {
      map["video-embeddable-only"] = { status: "na", evidence: `No videos or embeds found${scopeNote}.` };
      map["video-embed-title"] = { status: "na", evidence: `No embeds found${scopeNote}.` };
    } else {
      const selfHosted = videoTags.filter((v) => !!v.querySelector("source") || !!v.getAttribute("src"));
      map["video-embeddable-only"] =
        selfHosted.length > 0
          ? {
              status: "fail",
              evidence: `${selfHosted.length} self-hosted <video> element(s) found — only embeddable videos should be migrated.`,
            }
          : {
              status: "pass",
              evidence: `${iframes.length} embed(s) found, all iframe-based${scopeNote}.`,
            };

      if (iframes.length === 0) {
        map["video-embed-title"] = { status: "na", evidence: "No iframe embeds found." };
      } else {
        const noTitle = iframes.filter((f) => !(f.getAttribute("title") ?? "").trim());
        map["video-embed-title"] =
          noTitle.length === 0
            ? { status: "pass", evidence: `All ${iframes.length} embed(s) include a title attribute.` }
            : {
                status: "fail",
                evidence: `${noTitle.length} of ${iframes.length} embed(s) are missing a title attribute.`,
              };
      }
    }
  }

  map["img-relevant"] = {
    status: imgInfos.length === 0 ? "na" : "review",
    evidence:
      imgInfos.length === 0
        ? undefined
        : `${imgInfos.length} image(s) on the page — topical and location relevance needs a manual look.`,
  };

  // ======================= FORMS =======================
  {
    const forms = root.querySelectorAll("form");
    const rawSource = (row.rawHtml ?? page.html).toLowerCase();
    const hasContactUsCode = rawSource.includes("#contactus#");
    const replacementForms = (rawSource.match(/#[a-z_]*form[a-z_]*#|#contactus#/g) ?? []).length;
    const customForms = Math.max(forms.length - replacementForms, 0);
    const isContactPage = /contact/i.test(pageUrl);
    const hasSidebar =
      /class="[^"]*sidebar/.test(page.html.toLowerCase()) || /id="[^"]*sidebar/.test(page.html.toLowerCase());

    // forms-tagging-generator
    map["forms-tagging-generator"] =
      customForms === 0
        ? { status: "na", evidence: "No custom forms detected on the page." }
        : {
            status: "review",
            evidence: `${customForms} custom form(s) detected — confirm they were run through the tagging generator.`,
          };

    // forms-no-contactus-ls
    if (effectiveSiteType !== "leadscience") {
      map["forms-no-contactus-ls"] = { status: "na", evidence: "Not an LS site." };
    } else {
      map["forms-no-contactus-ls"] = hasContactUsCode
        ? { status: "fail", evidence: "#CONTACTUS# found on an LS site — it must not be used here." }
        : { status: "pass", evidence: "#CONTACTUS# not present." };
    }

    // forms-no-sidebar-contact
    if (!isContactPage) {
      map["forms-no-sidebar-contact"] = { status: "na", evidence: "Not the Contact Us page." };
    } else {
      map["forms-no-sidebar-contact"] = hasSidebar
        ? { status: "fail", evidence: "Sidebar markup found on the Contact Us page — it should be removed." }
        : { status: "pass", evidence: "No sidebar on the Contact Us page." };
    }

    // forms-two-form-mix
    if (forms.length < 2) {
      map["forms-two-form-mix"] = {
        status: "na",
        evidence: `${forms.length} form(s) on the page — the two-form rule does not apply.`,
      };
    } else if (forms.length === 2) {
      map["forms-two-form-mix"] =
        replacementForms >= 1 && customForms >= 1
          ? { status: "pass", evidence: "One replacement-code form and one custom form detected." }
          : {
              status: "review",
              evidence: `2 forms detected (${replacementForms} replacement-code, ${customForms} custom) — confirm it is one of each.`,
            };
    } else {
      map["forms-two-form-mix"] = {
        status: "review",
        evidence: `${forms.length} forms detected — confirm this is intentional.`,
      };
    }
  }

  // ======================= RESPONSIVENESS =======================
  const render = await callRenderService(pageUrl);
  if (render) {
    const overflow = renderCheckToStatus(render.overflow);
    const stacking = renderCheckToStatus(render.stacking);
    const header = renderCheckToStatus(render.header1800);
    map["resp-no-horizontal-scroll"] = overflow;
    map["resp-stacking-spacing"] = stacking;
    map["resp-breakpoints"] = {
      status: overflow.status === "pass" && stacking.status === "pass" && header.status === "pass" ? "pass" : "review",
      evidence:
        overflow.status === "pass" && stacking.status === "pass" && header.status === "pass"
          ? undefined
          : "Rendered checks flagged an issue — step through 1920px to 360px manually.",
    };
    map["resp-columns-height"] = {
      status: "review",
      evidence: "Column height balance needs a visual check at tablet and desktop widths.",
    };
  } else {
    const placeholder = "Requires rendered-browser check (render service not configured).";
    map["resp-breakpoints"] = { status: "review", evidence: placeholder };
    map["resp-no-horizontal-scroll"] = { status: "review", evidence: placeholder };
    map["resp-stacking-spacing"] = { status: "review", evidence: placeholder };
    map["resp-columns-height"] = { status: "review", evidence: placeholder };
  }

  // ======================= ACCESSIBILITY =======================
  map["a11y-spot-check"] = {
    status: "review",
    evidence: "Run the page through https://ada-des.lovable.app/ and confirm the results.",
  };

  // ======================= IF USING AI =======================
  map["ai-no-giveaways"] = {
    status: "review",
    evidence: "Manual review — check for generic AI-looking imagery, copy, and layout.",
  };
  {
    const inlineStyles = (page.html.match(/style="/g) ?? []).length;
    map["ai-clean-code"] =
      inlineStyles > 25
        ? {
            status: "fail",
            evidence: `${inlineStyles} inline style attributes found — use Extend/Bootstrap classes before custom CSS.`,
          }
        : {
            status: "review",
            evidence: `${inlineStyles} inline style attribute(s) — code cleanliness still needs a manual read.`,
          };
  }

  return { pageUrl, pageType: row.pageType, checks: buildChecks(row.pageType, map) };
}

export interface QaBatchInput {
  rows: QaBatchRow[];
  /** Raw "code = value" pairs (one per line) for the dealer-codes check. */
  dealerCodeInput?: string;
  /** Fallback site type when a page URL doesn't match a known pattern. */
  siteType?: SiteType;
  /** Production Website URL (from Case Info) — base for resolving root-relative links. */
  websiteUrl?: string;
}

export const runQaBatchServer = createServerFn({ method: "POST" })
  .validator((input: QaBatchInput) => input)
  .handler(async ({ data }) => {
    const allPairs = parseCodeValuePairs(data.dealerCodeInput ?? "");
    const fallback = data.siteType ?? "automotive";
    const websiteUrl = data.websiteUrl?.trim() || "";
    return pool(data.rows, PAGE_CONCURRENCY, (row) => analyzePage(row, allPairs, fallback, websiteUrl));
  });
