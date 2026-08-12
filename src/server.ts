// QA render service — a standalone Node + Playwright server.
// Renders a page at multiple viewports and measures the responsive/layout
// checks that static HTML can't decide. Deploy on Railway/Render/Fly.
//
// POST /render  { "url": "https://...", "token": "SECRET" }
//   -> { ok: true, results: { overflow, header1800, stacking } }
//
// Protect it with RENDER_TOKEN so only your app can call it.

import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

const RENDER_TOKEN = process.env.RENDER_TOKEN || "";
const PORT = process.env.PORT || 8080;

// Viewports we measure. width/height in CSS px.
const VIEWPORTS = {
  mobile: { width: 360, height: 800 },
  tablet: { width: 768, height: 1024 },
  wide: { width: 1800, height: 1000 },
};

// A single shared browser instance, launched lazily and reused across requests.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browserPromise;
}

/** Measure a page at one viewport; returns overflow + header metrics. */
async function measureViewport(browser, url, viewport) {
  const context = await browser.newContext({
    viewport,
    userAgent: "Mozilla/5.0 (compatible; MigrationQA/1.0; +render-service)",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    // Give lazy content a moment to settle.
    await page.waitForTimeout(500);

    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      const scrollWidth = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0);
      const clientWidth = doc.clientWidth;
      const overflowPx = scrollWidth - clientWidth;

      // Find elements that stick out past the viewport right edge (common overflow culprits).
      const offenders = [];
      const vw = window.innerWidth;
      const all = document.querySelectorAll("body *");
      for (let i = 0; i < all.length && offenders.length < 5; i++) {
        const el = all[i];
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > vw + 2) {
          const tag = el.tagName.toLowerCase();
          const cls = (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : "");
          offenders.push(`${tag}${cls} (right=${Math.round(rect.right)}px)`);
        }
      }

      // Header sanity: does a <header> exist and does it span a reasonable width at this viewport?
      const header = document.querySelector("header, .headerWrapper, [role='banner']");
      let headerInfo = null;
      if (header) {
        const hr = header.getBoundingClientRect();
        headerInfo = { width: Math.round(hr.width), viewport: vw, ratio: hr.width / vw };
      }

      return { scrollWidth, clientWidth, overflowPx, offenders, headerInfo, viewport: vw };
    });

    return metrics;
  } finally {
    await context.close();
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  if (RENDER_TOKEN && req.body?.token !== RENDER_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const url = req.body?.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "Valid url required" });
  }

  try {
    const browser = await getBrowser();
    const [mobile, tablet, wide] = await Promise.all([
      measureViewport(browser, url, VIEWPORTS.mobile),
      measureViewport(browser, url, VIEWPORTS.tablet),
      measureViewport(browser, url, VIEWPORTS.wide),
    ]);

    // Derive check results from the raw metrics.
    // Overflow: fail if any viewport shows horizontal overflow beyond a 2px tolerance.
    const overflowViewports = [
      { name: "360px", m: mobile },
      { name: "768px", m: tablet },
      { name: "1800px", m: wide },
    ];
    const overflowFails = overflowViewports.filter((v) => v.m.overflowPx > 2);
    const overflow = {
      pass: overflowFails.length === 0,
      detail: overflowFails.length
        ? overflowFails
            .map((v) => `${v.name}: overflows by ${Math.round(v.m.overflowPx)}px` + (v.m.offenders.length ? ` (e.g. ${v.m.offenders[0]})` : ""))
            .join("; ")
        : "No horizontal overflow at 360px, 768px, or 1800px.",
    };

    // Header at 1800px: warn if header spans much less than viewport (unstyled gutters)
    // or overflows it. This is a heuristic, not a verdict — surfaced as review-worthy detail.
    let header1800;
    if (!wide.headerInfo) {
      header1800 = { pass: null, detail: "No <header> element found to check at 1800px." };
    } else {
      const ratio = wide.headerInfo.ratio;
      if (ratio > 1.01) {
        header1800 = { pass: false, detail: `Header overflows viewport at 1800px (header ${wide.headerInfo.width}px > ${wide.headerInfo.viewport}px).` };
      } else if (ratio < 0.75) {
        header1800 = { pass: false, detail: `Header only spans ${Math.round(ratio * 100)}% of the 1800px viewport — possible unstyled gutters.` };
      } else {
        header1800 = { pass: true, detail: `Header spans ${Math.round(ratio * 100)}% of the 1800px viewport.` };
      }
    }

    // Mobile stacking / responsiveness: reuse the mobile overflow signal as the concrete part.
    // True image->title->content order needs content-specific rules, so we report the
    // measurable part (no mobile overflow + content fits) and leave order to manual.
    const stacking = {
      pass: mobile.overflowPx <= 2,
      detail:
        mobile.overflowPx <= 2
          ? "Content fits within 360px width without horizontal scroll."
          : `Content overflows at 360px by ${Math.round(mobile.overflowPx)}px — check stacking.`,
    };

    return res.json({
      ok: true,
      results: { overflow, header1800, stacking },
      raw: { mobile, tablet, wide },
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: err instanceof Error ? err.message : "Render failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`QA render service listening on :${PORT}`);
});
