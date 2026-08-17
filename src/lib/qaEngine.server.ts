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

  // content-single-h1
  {
    const count = root.querySelectorAll("h1").length;
    map["content-single-h1"] =
      count === 1
        ? { status: "pass" }
        : { status: "fail", evidence: `${count} h1 element${count === 1 ? "" : "s"} found${scopeNote}.` };
  }

  // content-lorem
  {
    const phrases = ["lorem ipsum", "dolor sit amet", "your text here", "insert text", "sample text"];
    const hit = phrases.find((p) => lowerText.includes(p));
    map["content-lorem"] = hit
      ? { status: "fail", evidence: `Placeholder copy found: "${hit}".` }
      : { status: "pass" };
  }

  // content-dealer-names
  {
    const hits = DEALER_NAME_BLOCKLIST.filter((term) => lowerHtml.includes(term.toLowerCase()));
    map["content-dealer-names"] = hits.length
      ? { status: "fail", evidence: `Placeholder dealer text found: ${hits.join(", ")}.` }
      : { status: "pass" };
  }

  // content-spelling (heuristic only)
  {
    const doubleSpaces = (text.match(/ {2,}/g) ?? []).length;
    const repeatedPunct = (text.match(/([!?.]){2,}/g) ?? []).length;
    const total = doubleSpaces + repeatedPunct;
    map["content-spelling"] =
      total > 0
        ? {
            status: "review",
            evidence: `${doubleSpaces} double-space and ${repeatedPunct} repeated-punctuation occurrence(s).`,
          }
        : { status: "pass" };
  }

  // content-empty-sections
  {
    const candidates = [
      ...root.querySelectorAll("section"),
      ...root.querySelectorAll('div[class*="section"]'),
    ];
    const empty = candidates.filter((el) => {
      const inlineStyle = (el.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
      if (inlineStyle.includes("display:none")) return false;
      const hasMedia = el.querySelector("img") || el.querySelector("iframe");
      const hasText = el.text.replace(/\s+/g, "").length > 0;
      return !hasMedia && !hasText;
    });
    map["content-empty-sections"] =
      empty.length > 0
        ? { status: "review", evidence: `${empty.length} empty/unused section(s) found.` }
        : { status: "pass" };
  }

  // links collection (shared)
  const anchors = root.querySelectorAll("a");
  const rawHrefs = anchors
    .map((a) => a.getAttribute("href") ?? "")
    .filter((h) => isCheckableLink(h));

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

        // Collect every data-dotagging-* attribute so the report can show the full GA4 tagging.
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
          // Full GA4 tagging detail (all dotagging attributes on this link).
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
                status: "review",
                evidence: `${total - tagged} of ${total} applicable links missing GA4 tagging${scopeNote}.`,
                details,
              };
    }
  }

  // links-404
  {
    // Resolve each href for checking:
    //  - root-relative ("/contact/") → resolve against the production Website
    //    URL (Case Info) when provided, else the page URL.
    //  - absolute (http/https) → leave exactly as-is (external links must not
    //    be rewritten to the production base).
    //  - other relative ("about/", "../x") → resolve against the page URL.
    const homeOrigin = websiteBase ? normalizeUrl(websiteBase) : "";
    const resolveForCheck = (href: string): string | null => {
      const h = href.trim();
      if (/^https?:\/\//i.test(h)) return h; // already absolute — as-is
      if (h.startsWith("/") && homeOrigin) {
        try {
          return new URL(h, homeOrigin).toString();
        } catch {
          return null;
        }
      }
      return absolutize(h, pageUrl); // fallback: resolve against the page
    };

    const resolved = rawHrefs
      .map(resolveForCheck)
      .filter((u): u is string => !!u && /^https?:\/\//i.test(u));
    const unique = Array.from(new Set(resolved.map(normalizeDest)));
    const capped = unique.length > MAX_LINKS_PER_PAGE;
    const toCheck = unique.slice(0, MAX_LINKS_PER_PAGE);

    if (toCheck.length === 0) {
      map["links-404"] = { status: "pass" };
    } else {
      // Fingerprint the site's soft-404 page once (probe a guaranteed-missing
      // URL). Prefer the production base; fall back to the page's own origin.
      let probeBase = homeOrigin;
      if (!probeBase) {
        try {
          probeBase = new URL(pageUrl).origin;
        } catch {
          probeBase = "";
        }
      }
      const softFp = probeBase ? await probeSoft404(probeBase) : null;

      const results = await pool(toCheck, LINK_CONCURRENCY, async (u) => ({
        url: u,
        ...(await checkLink(u, homeOrigin, softFp)),
      }));
      const broken = results.filter((r) => r.problem !== "");
      if (broken.length === 0) {
        const baseNote = homeOrigin ? ` (root-relative links checked against ${homeOrigin})` : "";
        map["links-404"] = { status: "pass", evidence: `All ${toCheck.length} link(s) OK${baseNote}.` };
      } else {
        const items: QaDetailItem[] = broken.map((b) => ({
          primary: b.url,
          flag: "fail",
          note: b.problem,
        }));
        const sample = broken.slice(0, 5).map((b) => `${b.url} — ${b.problem}`);
        map["links-404"] = {
          status: "fail",
          evidence:
            `${broken.length} broken link(s) found: ${sample.join("; ")}` +
            (capped ? ` — only first ${MAX_LINKS_PER_PAGE} links checked.` : "."),
          details: { kind: "links", items },
        };
      }
    }
  }

  // links-carried-over (needs reference)
  if (!referenceUrl) {
    map["content-links-carried-over"] = { status: "na" };
  } else {
    const ref = await fetchPage(referenceUrl);
    if (!ref.ok || !ref.html) {
      map["content-links-carried-over"] = {
        status: "review",
        evidence: `Could not fetch reference page${ref.error ? `: ${ref.error}` : ` (HTTP ${ref.status})`}.`,
      };
    } else {
      const refRoot = scopeToContent(ref.html).node;
      const collect = (r: HTMLElement, base: string) =>
        new Set(
          r
            .querySelectorAll("a")
            .map((a) => a.getAttribute("href") ?? "")
            .filter(isCheckableLink)
            .map((h) => absolutize(h, base))
            .filter((u): u is string => !!u && /^https?:\/\//i.test(u))
            .map(normalizeDest),
        );
      const refSet = collect(refRoot, referenceUrl);
      const newSet = collect(root, pageUrl);
      const missing = [...refSet].filter((u) => !newSet.has(u));
      map["content-links-carried-over"] =
        missing.length === 0
          ? { status: "pass" }
          : {
              status: "review",
              evidence: `${missing.length} link(s) on reference not found on new page: ${missing
                .slice(0, 5)
                .join("; ")}.`,
            };
    }
  }

  // Shared image inventory: resolve each src to an absolute URL (so thumbnails
  // load in the report) and fetch its byte size once (for the 150KB rule).
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

  // tech-alt-text
  {
    if (imgInfos.length === 0) {
      map["tech-alt-text"] = { status: "na" };
    } else {
      const imgItems: QaDetailItem[] = [];
      const missing = imgInfos.filter(({ el: img, absSrc, rawSrc, bytes }) => {
        const alt = img.getAttribute("alt");
        const aria = img.getAttribute("aria-label");
        const role = (img.getAttribute("role") ?? "").toLowerCase();
        const hidden = (img.getAttribute("aria-hidden") ?? "").toLowerCase();
        const decorative = role === "presentation" || hidden === "true";
        const isMissing = !decorative && !alt && !aria;
        const sizeNote = bytes != null ? ` · ${formatBytes(bytes)}` : "";
        imgItems.push({
          primary: absSrc ?? rawSrc ?? "(no src)",
          secondary: alt ?? aria ?? "",
          flag: isMissing ? "fail" : "ok",
          note:
            (decorative
              ? "decorative (exempt)"
              : alt
                ? "has alt text"
                : aria
                  ? "has aria-label"
                  : "MISSING alt text") + sizeNote,
        });
        return isMissing;
      });
      const details: QaCheckDetails = { kind: "images", items: imgItems };
      map["tech-alt-text"] =
        missing.length === 0
          ? { status: "pass", details }
          : { status: "fail", evidence: `${missing.length} image(s) missing alt text${scopeNote}.`, details };
    }
  }

  // tech-image-size — flags images over 150KB (real byte size) and, as a
  // secondary heuristic, absurd declared widths. Rendered-dimension checks
  // remain Phase 2.
  {
    if (imgInfos.length === 0) {
      map["tech-image-size"] = { status: "na" };
    } else {
      const sizeItems: QaDetailItem[] = [];
      let overLimit = 0;
      let hugeWidth = 0;
      imgInfos.forEach(({ el: img, absSrc, rawSrc, bytes }) => {
        const w = parseInt(img.getAttribute("width") ?? "", 10);
        const styleW = /width:\s*(\d+)px/i.exec(img.getAttribute("style") ?? "");
        const styleWidth = styleW ? parseInt(styleW[1], 10) : NaN;
        const declared = Number.isFinite(w) ? w : Number.isFinite(styleWidth) ? styleWidth : NaN;

        const isOver = bytes != null && bytes > IMAGE_SIZE_LIMIT_BYTES;
        const isHugeWidth = Number.isFinite(declared) && declared > 3000;
        if (isOver) overLimit++;
        if (isHugeWidth) hugeWidth++;

        const parts: string[] = [];
        if (bytes != null) parts.push(formatBytes(bytes));
        else parts.push("size unknown");
        if (Number.isFinite(declared)) parts.push(`declared ${declared}px wide`);

        sizeItems.push({
          primary: absSrc ?? rawSrc ?? "(no src)",
          secondary: img.getAttribute("alt") ?? "",
          flag: isOver || isHugeWidth ? "fail" : "ok",
          note:
            (isOver ? `OVER 150KB — ${parts.join(" · ")}` : parts.join(" · ")) +
            (isHugeWidth ? " · width too large" : ""),
        });
      });
      const details: QaCheckDetails = { kind: "oversized-images", items: sizeItems };
      const problems = overLimit + hugeWidth;
      if (problems > 0) {
        const bits: string[] = [];
        if (overLimit > 0) bits.push(`${overLimit} image(s) over 150KB`);
        if (hugeWidth > 0) bits.push(`${hugeWidth} image(s) declared wider than 3000px`);
        map["tech-image-size"] = { status: "fail", evidence: `${bits.join("; ")}${scopeNote}.`, details };
      } else {
        map["tech-image-size"] = {
          status: "pass",
          evidence: `All images within 150KB${scopeNote}. Rendered-dimension check is Phase 2.`,
          details,
        };
      }
    }
  }

  // Responsive / Layout — real measurements via the render service when configured,
  // otherwise honest placeholders.
  const render = await callRenderService(pageUrl);
  if (render) {
    const overflow = renderCheckToStatus(render.overflow);
    const header = renderCheckToStatus(render.header1800);
    const stacking = renderCheckToStatus(render.stacking);
    map["resp-overflow"] = overflow;
    map["resp-header-1800"] = header;
    map["resp-mobile-tablet"] = stacking;
    map["resp-mobile-360"] = stacking;
    map["resp-image-title-stacking"] = {
      status: stacking.status === "pass" ? "review" : stacking.status,
      evidence:
        stacking.status === "pass"
          ? "Fits at 360px; image→title→content order still needs a manual glance."
          : stacking.evidence,
    };
  } else {
    map["resp-mobile-tablet"] = { status: "review", evidence: "Requires rendered-browser check (Phase 2)." };
    map["resp-overflow"] = { status: "review", evidence: "Requires rendered-browser check (Phase 2)." };
    map["resp-header-1800"] = { status: "review", evidence: "Requires rendered-browser check (Phase 2)." };
    map["resp-image-title-stacking"] = { status: "review", evidence: "Requires rendered-browser check (Phase 2)." };
    map["resp-mobile-360"] = { status: "review", evidence: "Requires rendered-browser check (Phase 2)." };
  }

  // Manual placeholders — set honestly
  map["content-dealer-logo"] = { status: "review", evidence: "Manual review — logo crop/resize needs a visual check." };
  map["tech-element-order"] = { status: "review", evidence: "Manual review — element order is intent-dependent." };
  map["tech-custom-forms"] = { status: "review", evidence: "Manual review — process check, not a page-state check." };
  // tech-dealer-codes — detect hardcoded dealer values that should have been
  // replacement codes. When raw CMS HTML is provided for the page, scan THAT
  // (it still contains the actual %(...) codes, so correctly-templated spots
  // show the code and won't match — only true hardcoded values are flagged).
  // Otherwise fall back to the live page's scoped visible text.
  if (dealerPairs.length === 0) {
    map["tech-dealer-codes"] = {
      status: "review",
      evidence: "Add dealer code = value pairs above to auto-check for hardcoded values.",
    };
  } else {
    const usingRaw = Boolean(row.rawHtml && row.rawHtml.trim());
    const sourceText = usingRaw ? visibleText(scopeToContent(row.rawHtml as string).node) : text;
    const sourceLabel = usingRaw ? "raw CMS HTML" : `scoped to ${region}`;
    const sourceNote = ` (${sourceLabel} · ${effectiveSiteType})`;
    const hits = detectDealerValues(sourceText, dealerPairs);
    if (hits.length === 0) {
      map["tech-dealer-codes"] = {
        status: "pass",
        evidence: `No hardcoded dealer values found${sourceNote}.`,
      };
    } else {
      const totalOccurrences = hits.reduce((sum, h) => sum + h.count, 0);
      const items: QaDetailItem[] = hits.map((h) => ({
        primary: h.value,
        secondary: h.code,
        flag: "fail",
        note: `should be ${h.code}${h.count > 1 ? ` · ${h.count}×` : ""}`,
      }));
      map["tech-dealer-codes"] = {
        status: "fail",
        evidence: `${hits.length} value(s) hardcoded that should use replacement codes (${totalOccurrences} occurrence(s))${sourceNote}.`,
        details: { kind: "dealer-codes", items },
      };
    }
  }
  map["final-case-description"] = { status: "review", evidence: "Manual confirmation required." };
  map["final-special-requests"] = { status: "review", evidence: "Manual confirmation required." };

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
