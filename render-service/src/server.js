/**
 * Migration QA — Phase 2 render service
 *
 * POST /render
 *   Body: { "url": "https://...", "token": "..." }
 *   Response: {
 *     ok: true,
 *     results: {
 *       overflow:   { pass: boolean|null, detail: string },
 *       header1800: { pass: boolean|null, detail: string },
 *       stacking:   { pass: boolean|null, detail: string },
 *       mobile360:  { pass: boolean|null, detail: string },
 *       mobileTablet:{ pass: boolean|null, detail: string }
 *     }
 *   }
 *
 * Only used by Responsive / Layout checks in the main QA app.
 * Does not affect Content, Links, Technical, or Final Review.
 */

import http from "node:http";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 3099);
const TOKEN = process.env.RENDER_SERVICE_TOKEN || "";
const NAV_TIMEOUT_MS = 30_000;
const OVERFLOW_TOLERANCE_PX = 2;

/** @typedef {{ pass: boolean|null, detail: string }} RenderCheck */

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  }
  return browserPromise;
}

async function setViewport(page, width, height = 900) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(400);
}

async function measureOverflow(page) {
  return page.evaluate((tolerance) => {
    const doc = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(doc.scrollWidth, body?.scrollWidth ?? 0);
    const clientWidth = doc.clientWidth;
    return {
      scrollWidth,
      clientWidth,
      overflow: scrollWidth > clientWidth + tolerance,
    };
  }, OVERFLOW_TOLERANCE_PX);
}

async function checkOverflow(page) {
  const widths = [360, 768, 1024, 1440, 1800];
  const failing = [];
  for (const width of widths) {
    await setViewport(page, width);
    const m = await measureOverflow(page);
    if (m.overflow) {
      failing.push(`${width}px (scroll ${m.scrollWidth} > client ${m.clientWidth})`);
    }
  }
  if (failing.length > 0) {
    return { pass: false, detail: `Horizontal overflow at: ${failing.join("; ")}` };
  }
  return { pass: true, detail: `No horizontal overflow at ${widths.join(", ")}px` };
}

async function checkHeader1800(page) {
  await setViewport(page, 1800, 900);
  const result = await page.evaluate(() => {
    const header =
      document.querySelector("header") ||
      document.querySelector('[role="banner"]') ||
      document.querySelector("nav");
    if (!header) {
      return { pass: null, detail: "No header/nav landmark found to measure." };
    }
    const hr = header.getBoundingClientRect();
    const issues = [];
    if (hr.height < 1 || hr.width < 1) issues.push("header has zero size");
    if (hr.top > 120) issues.push(`header top at ${Math.round(hr.top)}px (expected near top)`);
    if (hr.right < 0 || hr.left > window.innerWidth) issues.push("header is horizontally off-screen");
    const clickable = header.querySelectorAll("a, button, [role='button']");
    const boxes = [];
    for (const el of clickable) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      boxes.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    let overlapPairs = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 8 && overlapY > 8) overlapPairs += 1;
      }
    }
    if (overlapPairs > 2) issues.push(`${overlapPairs} overlapping nav/control pairs`);
    let clipped = 0;
    for (const b of boxes) {
      if (b.top < hr.top - 4 || b.bottom > hr.bottom + 20 || b.left < hr.left - 20 || b.right > hr.right + 20) {
        if (b.top >= hr.top - 4 && b.left >= hr.left - 20 && b.right <= hr.right + 20) continue;
        clipped += 1;
      }
    }
    if (clipped > 3) issues.push(`${clipped} header controls appear mis-positioned relative to header box`);
    if (issues.length > 0) return { pass: false, detail: `At 1800px: ${issues.join("; ")}` };
    return { pass: true, detail: `Header/nav OK at 1800px (${Math.round(hr.width)}×${Math.round(hr.height)})` };
  });
  return result;
}

async function checkMobile360(page) {
  await setViewport(page, 360, 800);
  const m = await measureOverflow(page);
  const extra = await page.evaluate(() => {
    const issues = [];
    const all = document.querySelectorAll("main *, [role='main'] *, .content *, body > div *");
    let checked = 0;
    for (const el of all) {
      if (checked > 400) break;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;
      checked += 1;
      if (r.left < -50) issues.push("element positioned far left of viewport");
      if (r.width > window.innerWidth + 40) issues.push("element wider than viewport");
      if (issues.length >= 3) break;
    }
    return [...new Set(issues)];
  });
  if (m.overflow) {
    return {
      pass: false,
      detail: `At 360px: horizontal overflow (scroll ${m.scrollWidth} > client ${m.clientWidth})${extra.length ? "; " + extra.join("; ") : ""}`,
    };
  }
  if (extra.length > 0) return { pass: false, detail: `At 360px: ${extra.join("; ")}` };
  return { pass: true, detail: "Layout fits at 360px with no horizontal overflow" };
}

async function checkMobileTablet(page) {
  const widths = [768, 1024];
  const failing = [];
  for (const width of widths) {
    await setViewport(page, width, 900);
    const m = await measureOverflow(page);
    if (m.overflow) failing.push(`${width}px (scroll ${m.scrollWidth} > client ${m.clientWidth})`);
  }
  if (failing.length > 0) {
    return { pass: false, detail: `Mobile/tablet overflow at: ${failing.join("; ")}` };
  }
  return { pass: true, detail: "No overflow at 768px and 1024px (mobile/tablet range)" };
}

async function checkStacking(page) {
  await setViewport(page, 360, 800);
  const result = await page.evaluate(() => {
    const root =
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.querySelector("article") ||
      document.body;
    if (!root) return { pass: null, detail: "No main content region found for stacking check." };
    const images = [...root.querySelectorAll("img")].filter((img) => {
      const r = img.getBoundingClientRect();
      return r.width >= 80 && r.height >= 40 && r.bottom > 0 && r.top < window.innerHeight * 1.5;
    });
    const headings = [...root.querySelectorAll("h1, h2")].filter((h) => {
      const r = h.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (images.length === 0 || headings.length === 0) {
      return {
        pass: null,
        detail: "Could not identify both a content image and a heading — stacking needs a manual glance.",
      };
    }
    images.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    headings.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const img = images[0];
    const title = headings[0];
    const imgRect = img.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    let contentEl = null;
    const candidates = root.querySelectorAll("p, li, .content, [class*='body'], [class*='text']");
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.top >= titleRect.top - 4 && r.height > 12 && (el.textContent || "").trim().length > 20) {
        contentEl = el;
        break;
      }
    }
    const contentTop = contentEl ? contentEl.getBoundingClientRect().top : null;
    const imageAboveTitle = imgRect.bottom <= titleRect.top + 24 || imgRect.top <= titleRect.top;
    const titleAboveContent =
      contentTop === null ? true : titleRect.bottom <= contentTop + 24 || titleRect.top <= contentTop;
    const sideBySide =
      Math.abs(imgRect.top - titleRect.top) < 40 &&
      Math.abs(imgRect.left - titleRect.left) > 60 &&
      imgRect.width < window.innerWidth * 0.7;
    if (sideBySide) {
      return { pass: false, detail: "At 360px, image and title appear side-by-side instead of stacked." };
    }
    if (imageAboveTitle && titleAboveContent) {
      return {
        pass: true,
        detail: "At 360px, image → title → content order looks stacked top-to-bottom.",
      };
    }
    if (!imageAboveTitle && titleRect.bottom < imgRect.top) {
      return {
        pass: false,
        detail: "At 360px, title appears above the image (expected image → title on mobile).",
      };
    }
    return {
      pass: null,
      detail: "Stacking order is ambiguous at 360px — confirm image → title → content visually.",
    };
  });
  return result;
}

async function analyzeUrl(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (compatible; MigrationQA-Render/1.0; +https://github.com/SanketVadgama/content-migratio-qa)",
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    try {
      await page.waitForLoadState("networkidle", { timeout: 8_000 });
    } catch {
      /* ignore */
    }
    await page.waitForTimeout(500);
    if (!response || response.status() >= 400) {
      const status = response?.status() ?? 0;
      const fail = { pass: null, detail: `Page returned HTTP ${status}; layout not measured.` };
      return { overflow: fail, header1800: fail, stacking: fail, mobile360: fail, mobileTablet: fail };
    }
    const overflow = await checkOverflow(page);
    const header1800 = await checkHeader1800(page);
    const mobile360 = await checkMobile360(page);
    const mobileTablet = await checkMobileTablet(page);
    const stacking = await checkStacking(page);
    return { overflow, header1800, stacking, mobile360, mobileTablet };
  } finally {
    await context.close();
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    return send(res, 200, { ok: true, service: "migration-qa-render", port: PORT });
  }
  if (req.method === "POST" && req.url === "/render") {
    try {
      const body = await readJson(req);
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const token = typeof body.token === "string" ? body.token : "";
      if (TOKEN && token !== TOKEN) {
        return send(res, 401, { ok: false, error: "Invalid token" });
      }
      if (!url || !/^https?:\/\//i.test(url)) {
        return send(res, 400, { ok: false, error: "Body must include a valid http(s) url" });
      }
      const results = await analyzeUrl(url);
      return send(res, 200, { ok: true, results });
    } catch (err) {
      console.error("[render] error:", err);
      return send(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : "Render failed",
      });
    }
  }
  send(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[migration-qa-render] listening on http://127.0.0.1:${PORT}`);
  console.log(
    `[migration-qa-render] token auth: ${TOKEN ? "enabled" : "disabled (set RENDER_SERVICE_TOKEN)"}`,
  );
  getBrowser()
    .then(() => console.log("[migration-qa-render] chromium ready"))
    .catch((err) => console.error("[migration-qa-render] chromium launch failed:", err));
});

async function shutdown() {
  console.log("[migration-qa-render] shutting down…");
  try {
    if (browserPromise) {
      const b = await browserPromise;
      await b.close();
    }
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
