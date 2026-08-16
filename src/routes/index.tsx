import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CaseInfoSection, emptyCaseInfo, type CaseInfo } from "@/components/qa/CaseInfoSection";
import { BatchInputSection, newRow } from "@/components/qa/BatchInputSection";
import { ResultsSection, summarisePage } from "@/components/qa/ResultsSection";
import { runQaBatch, type CheckStatus, type QaBatchRow, type QaPageResult } from "@/lib/qaEngine";
import { usePersistentState, clearPersistedKeys } from "@/lib/usePersistentState";
import { Download, ShieldCheck, RotateCcw } from "lucide-react";

// localStorage keys for cached case state.
const STORAGE_KEYS = {
  caseInfo: "qa.caseInfo",
  rows: "qa.rows",
  pages: "qa.pages",
  overrides: "qa.overrides",
  dealerCodeInput: "qa.dealerCodeInput",
  siteType: "qa.siteType",
} as const;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Content Migration QA — Automated Batch Checks" },
      {
        name: "description",
        content:
          "Run automated QA across every migrated page: layout, content, links, accessibility and final review checks in one batch.",
      },
      { property: "og:title", content: "Content Migration QA — Automated" },
      {
        property: "og:description",
        content: "Batch-check migrated pages for layout, content, link and accessibility issues.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [caseInfo, setCaseInfo] = usePersistentState<CaseInfo>(STORAGE_KEYS.caseInfo, emptyCaseInfo);
  const [rows, setRows] = usePersistentState<QaBatchRow[]>(STORAGE_KEYS.rows, [newRow()]);
  const [pages, setPages] = usePersistentState<QaPageResult[]>(STORAGE_KEYS.pages, []);
  const [overrides, setOverrides] = usePersistentState<Record<string, CheckStatus>>(STORAGE_KEYS.overrides, {});
  const [dealerCodeInput, setDealerCodeInput] = usePersistentState<string>(STORAGE_KEYS.dealerCodeInput, "");
  const [siteType, setSiteType] = usePersistentState<"automotive" | "leadscience">(STORAGE_KEYS.siteType, "automotive");
  const [running, setRunning] = useState(false);

  function handleResetCache() {
    clearPersistedKeys(Object.values(STORAGE_KEYS));
    setCaseInfo(emptyCaseInfo);
    setRows([newRow()]);
    setPages([]);
    setOverrides({});
    setDealerCodeInput("");
    setSiteType("automotive");
    toast.success("Cleared saved case and results");
  }

  const totals = useMemo(() => {
    return pages.reduce(
      (acc, page) => {
        const summary = summarisePage(page, overrides);
        return {
          total: acc.total + summary.total,
          autoResolved: acc.autoResolved + summary.autoResolved,
          needsReview: acc.needsReview + summary.needsReview,
        };
      },
      { total: 0, autoResolved: 0, needsReview: 0 },
    );
  }, [pages, overrides]);

  function missingRequiredFields(): string[] {
    const missing: string[] = [];
    if (!caseInfo.caseNumber.trim()) missing.push("Case Number");
    if (!caseInfo.designerName.trim()) missing.push("Designer Name");
    if (!caseInfo.dealerName.trim()) missing.push("Dealer / Website Name");
    if (!caseInfo.websiteUrl.trim()) missing.push("Website URL");
    return missing;
  }

  async function handleRun() {
    const missing = missingRequiredFields();
    if (missing.length > 0) {
      toast.error(`Please fill required Case Information: ${missing.join(", ")}`);
      return;
    }
    const cleaned = rows
      .map((row) => ({ ...row, pageUrl: row.pageUrl.trim(), referenceUrl: row.referenceUrl?.trim() || "" }))
      .filter((row) => row.pageUrl !== "");
    if (cleaned.length === 0) return;

    // Soft warning: dealer codes empty means the replacement-code check can't run,
    // but we still proceed with the other checks.
    if (!dealerCodeInput.trim()) {
      toast.warning("No Dealer Replacement Codes entered — the replacement-code check will be skipped.");
    }

    setRunning(true);
    setOverrides({});
    try {
      const results = await runQaBatch(cleaned, dealerCodeInput, siteType, caseInfo.websiteUrl);
      setPages(results);
      toast.success(`Automated QA finished for ${results.length} page${results.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Automated QA failed to run. Please try again.");
    } finally {
      setRunning(false);
    }
  }

  function handleExport() {
    if (pages.length === 0) {
      toast.error("Run automated QA before exporting a report");
      return;
    }
    const missing = missingRequiredFields();
    if (missing.length > 0) {
      toast.error(`Please fill required Case Information: ${missing.join(", ")}`);
      return;
    }
    const lines: string[] = [
      "Content Migration QA Report",
      `Case Number: ${caseInfo.caseNumber || "—"}`,
      `Designer: ${caseInfo.designerName || "—"}`,
      `Dealer / Website: ${caseInfo.dealerName || "—"}`,
      `Website URL: ${caseInfo.websiteUrl || "—"}`,
      `Date Started: ${caseInfo.dateStarted || "—"}`,
      `Notes: ${caseInfo.caseNotes || "—"}`,
      "",
    ];
    for (const page of pages) {
      const summary = summarisePage(page, overrides);
      lines.push(`PAGE: ${page.pageUrl} (${page.pageType})`);
      lines.push(
        `${summary.autoResolved} of ${summary.total} auto-resolved · ${summary.needsReview} need review · ${summary.manual} manual`,
      );
      for (const check of page.checks) {
        const key = `${page.pageUrl}::${check.id}`;
        const status = overrides[key] ?? check.status;
        lines.push(
          `  [${status.toUpperCase()}]${overrides[key] ? " (manual)" : ""} ${check.category} — ${check.label}${
            check.evidence ? ` :: ${check.evidence}` : ""
          }`,
        );
      }
      lines.push("");
    }

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `qa-report-${caseInfo.caseNumber || "case"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("QA report exported");
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="size-5" />
            </span>
            <div>
              <h1 className="text-base font-semibold text-foreground">Content Migration QA — Automated</h1>
              <p className="text-xs text-muted-foreground">Batch page verification for migration cases</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm font-semibold text-foreground">
                {totals.autoResolved} of {totals.total} checks auto-resolved
              </p>
              <div className="mt-1 h-1.5 w-44 overflow-hidden rounded-full bg-neutral-soft">
                <div
                  className="h-full rounded-full bg-brand transition-all"
                  style={{ width: totals.total ? `${(totals.autoResolved / totals.total) * 100}%` : "0%" }}
                />
              </div>
            </div>
            <Button variant="outline" onClick={handleExport}>
              <Download className="size-4" /> Export QA Report
            </Button>
            <Button variant="ghost" onClick={handleResetCache} title="Clear saved case and results from this browser">
              <RotateCcw className="size-4" /> Reset Cache
            </Button>
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-6 pb-2">
          <p className="text-xs text-muted-foreground">All changes saved locally in this browser</p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <CaseInfoSection value={caseInfo} onChange={setCaseInfo} />
        <BatchInputSection rows={rows} onChange={setRows} onRun={handleRun} running={running} />

        <section className="rounded-xl border border-border bg-card p-6">
          <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Dealer Replacement Codes
                <span className="ml-2 rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-semibold tracking-wide text-warning-foreground uppercase">
                  Recommended
                </span>
              </h2>
              <p className="text-sm text-muted-foreground">
                Paste <code className="rounded bg-muted px-1 py-0.5 text-xs">code = value</code> pairs, one per line. The
                QA scan flags any of these values found hardcoded in the page's visible text (they should use the
                replacement code instead).
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-muted/50 p-1">
              <button
                type="button"
                onClick={() => setSiteType("automotive")}
                className={
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors " +
                  (siteType === "automotive"
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                Automotive
              </button>
              <button
                type="button"
                onClick={() => setSiteType("leadscience")}
                className={
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors " +
                  (siteType === "leadscience"
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                LeadScience
              </button>
            </div>
          </header>
          <textarea
            value={dealerCodeInput}
            onChange={(e) => setDealerCodeInput(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={"%(CITY) = Honolulu\n%(STATE) = HI\n%(DEALERSHIP_NAME) = Recovery Law Center\n#Phone# = 808-200-3813\n%(ADDRESS) = 1226 College Walk, Honolulu, HI 96817"}
            className="w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-sm text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Only visible text is checked — never alt text, attributes, or tracking codes. Site type is auto-detected from
            each URL (<code className="rounded bg-muted px-1 py-0.5 text-xs">*.leadscience.com</code> → LeadScience,{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">*.dealeron.com</code> → Automotive); the toggle above
            is the fallback for other URLs.{" "}
            {siteType === "leadscience"
              ? "Fallback: LeadScience (make codes ignored)."
              : "Fallback: Automotive (make codes checked)."}
          </p>
        </section>

        <ResultsSection
          pages={pages}
          overrides={overrides}
          running={running}
          onOverride={(key, status) =>
            setOverrides((current) => {
              const next = { ...current };
              if (status === null) delete next[key];
              else next[key] = status;
              return next;
            })
          }
        />
      </main>
    </div>
  );
}
