// Phase 1 automated QA engine — runs on the server (Nitro) via TanStack Start.
// Fetches public page HTML, parses it with node-html-parser (no browser), and
// resolves every check in CHECK_DEFINITIONS with real logic where statically
// decidable, or an honest "review"/"na" where a rendered browser (Phase 2) is
// required. One bad page never fails the batch.

import { createServerFn } from "@tanstack/react-start";
import { parse, type HTMLElement } from "node-html-parser";
import {
  CHECK_DEFINITIONS,
  DEALER_NAME_BLOCKLIST,
  type CheckStatus,
  type QaBatchRow,
  type QaCheck,
  type QaPageResult,
} from "./qaEngine";

const USER_AGENT = "Mozilla/5.0 (compatible; MigrationQA/1.0)";
const PAGE_TIMEOUT_MS = 15_000;
const MAX_LINKS_PER_PAGE = 100;
const PAGE_CONCURRENCY = 4;
const LINK_CONCURRENCY = 6;

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

async function fetchPage(url: string): Promise<FetchedPage> {
  try {
    const res = await fetchWithTimeout(url);
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
    "header",
    "footer",
    "nav",
    "script",
    "style",
    "noscript",
    ".headerWrapper",
    ".sitewide-footer-content",
    '[aria-label="Offers"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="navigation"]',
    '[class*="header"]',
    '[class*="footer"]',
    '[class*="navbar"]',
    '[id*="nav"]',
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

async function checkLink(url: string): Promise<number> {
  try {
    let res = await fetchWithTimeout(url, { method: "HEAD" }, PAGE_TIMEOUT_MS);
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithTimeout(url, { method: "GET" }, PAGE_TIMEOUT_MS);
    }
    return res.status;
  } catch {
    return 0; // network failure — treat as unreachable
  }
}

function buildChecks(map: Record<string, { status: CheckStatus; evidence?: string }>): QaCheck[] {
  return CHECK_DEFINITIONS.map((def) => {
    const r = map[def.id] ?? { status: "review" as CheckStatus, evidence: "Not evaluated." };
    return {
      id: def.id,
      category: def.category,
      label: def.label,
      status: r.status,
      evidence:
        r.status === "fail" || r.status === "review" ? r.evidence : undefined,
    } satisfies QaCheck;
  });
}

async function analyzePage(row: QaBatchRow): Promise<QaPageResult> {
  const page = await fetchPage(row.pageUrl);

  // Whole page unreachable → mark everything review, never crash the batch.
  if (!page.ok || !page.html) {
    const reason = page.error
      ? `Could not fetch page: ${page.error}`
      : `Could not fetch page (HTTP ${page.status}).`;
    const map: Record<string, { status: CheckStatus; evidence?: string }> = {};
    CHECK_DEFINITIONS.forEach((def, i) => {
      map[def.id] = { status: "review", evidence: i === 0 ? reason : "Page not analyzed." };
    });
    return { pageUrl: row.pageUrl, pageType: row.pageType, checks: buildChecks(map) };
  }

  // Scope to main content — header, footer, and nav are explicitly NOT QA'd.
  const { region, node: root } = scopeToContent(page.html);
  const scopedHtml = root.toString();
  const text = visibleText(parse(scopedHtml));
  const lowerText = text.toLowerCase();
  const lowerHtml = scopedHtml.toLowerCase();

  const map: Record<string, { status: CheckStatus; evidence?: string }> = {};
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
      let tagged = 0;
      anchors.forEach((a) => {
        const attrs = a.rawAttrs.toLowerCase();
        const href = (a.getAttribute("href") ?? "").toLowerCase();
        const onclick = (a.getAttribute("onclick") ?? "").toLowerCase();
        const isTagged =
          attrs.includes("ga4") ||
          attrs.includes("gtm") ||
          onclick.includes("gtag") ||
          onclick.includes("datalayer") ||
          href.includes("utm_");
        if (isTagged) tagged++;
      });
      const total = anchors.length;
      map["links-ga4"] =
        tagged === total
          ? { status: "pass" }
          : { status: "review", evidence: `${total - tagged} of ${total} links missing GA4 tagging.` };
    }
  }

  // links-404
  {
    const absolute = rawHrefs
      .map((h) => absolutize(h, row.pageUrl))
      .filter((u): u is string => !!u && /^https?:\/\//i.test(u));
    const unique = Array.from(new Set(absolute.map(normalizeDest)));
    const capped = unique.length > MAX_LINKS_PER_PAGE;
    const toCheck = unique.slice(0, MAX_LINKS_PER_PAGE);

    if (toCheck.length === 0) {
      map["links-404"] = { status: "pass" };
    } else {
      const statuses = await pool(toCheck, LINK_CONCURRENCY, async (u) => ({
        url: u,
        status: await checkLink(u),
      }));
      const broken = statuses.filter((s) => s.status >= 400 || s.status === 0);
      if (broken.length === 0) {
        map["links-404"] = { status: "pass" };
      } else {
        const sample = broken.slice(0, 5).map((b) => `${b.url} (${b.status || "unreachable"})`);
        map["links-404"] = {
          status: "fail",
          evidence:
            `${broken.length} broken link(s) found: ${sample.join("; ")}` +
            (capped ? ` — only first ${MAX_LINKS_PER_PAGE} links checked.` : "."),
        };
      }
    }
  }

  // links-carried-over (needs reference)
  if (!row.referenceUrl) {
    map["links-carried-over"] = { status: "na" };
  } else {
    const ref = await fetchPage(row.referenceUrl);
    if (!ref.ok || !ref.html) {
      map["links-carried-over"] = {
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
      const refSet = collect(refRoot, row.referenceUrl);
      const newSet = collect(root, row.pageUrl);
      const missing = [...refSet].filter((u) => !newSet.has(u));
      map["links-carried-over"] =
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

  // tech-alt-text
  {
    const imgs = root.querySelectorAll("img");
    if (imgs.length === 0) {
      map["tech-alt-text"] = { status: "na" };
    } else {
      const missing = imgs.filter((img) => {
        const alt = img.getAttribute("alt");
        const aria = img.getAttribute("aria-label");
        const role = (img.getAttribute("role") ?? "").toLowerCase();
        const hidden = (img.getAttribute("aria-hidden") ?? "").toLowerCase();
        const decorative = role === "presentation" || hidden === "true";
        return !decorative && !alt && !aria;
      });
      map["tech-alt-text"] =
        missing.length === 0
          ? { status: "pass" }
          : { status: "fail", evidence: `${missing.length} image(s) missing alt text.` };
    }
  }

  // tech-image-size — light static heuristic; full check is Phase 2
  {
    const imgs = root.querySelectorAll("img");
    const huge = imgs.filter((img) => {
      const w = parseInt(img.getAttribute("width") ?? "", 10);
      const styleW = /width:\s*(\d+)px/i.exec(img.getAttribute("style") ?? "");
      const styleWidth = styleW ? parseInt(styleW[1], 10) : NaN;
      return (Number.isFinite(w) && w > 3000) || (Number.isFinite(styleWidth) && styleWidth > 3000);
    });
    map["tech-image-size"] =
      huge.length > 0
        ? { status: "fail", evidence: `${huge.length} image(s) declared wider than 3000px.` }
        : { status: "review", evidence: "Requires rendered-browser check (Phase 2)." };
  }

  // Phase 2 / manual placeholders — set honestly
  map["resp-mobile-tablet"] = { status: "review", evidence: "Requires rendered-browser check (Phase 2)." };
  map["resp-overflow"] = { status: "review", evidence: "Requires rendered-browser check (Phase 2)." };
  map["resp-header-1800"] = { status: "review", evidence: "Requires rendered-browser check (Phase 2)." };
  map["tech-element-order"] = { status: "review", evidence: "Manual review — element order is intent-dependent." };
  map["tech-dealer-codes"] = { status: "review", evidence: "Manual review — depends on what could be templated." };
  map["final-case-description"] = { status: "review", evidence: "Manual confirmation required." };
  map["final-special-requests"] = { status: "review", evidence: "Manual confirmation required." };

  return { pageUrl: row.pageUrl, pageType: row.pageType, checks: buildChecks(map) };
}

export const runQaBatchServer = createServerFn({ method: "POST" })
  .validator((rows: QaBatchRow[]) => rows)
  .handler(async ({ data }) => {
    return pool(data, PAGE_CONCURRENCY, (row) => analyzePage(row));
  });
