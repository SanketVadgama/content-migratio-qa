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
  const [running, setRunning] = useState(false);

  function handleResetCache() {
    clearPersistedKeys(Object.values(STORAGE_KEYS));
    setCaseInfo(emptyCaseInfo);
    setRows([newRow()]);
    setPages([]);
    setOverrides({});
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

  async function handleRun() {
    const cleaned = rows
      .map((row) => ({ ...row, pageUrl: row.pageUrl.trim(), referenceUrl: row.referenceUrl?.trim() || "" }))
      .filter((row) => row.pageUrl !== "");
    if (cleaned.length === 0) return;

    setRunning(true);
    setOverrides({});
    try {
      const results = await runQaBatch(cleaned);
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
