import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/qa/StatusPill";
import { CATEGORY_ORDER, type CheckStatus, type QaPageResult } from "@/lib/qaEngine";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageSummary {
  total: number;
  autoResolved: number;
  needsReview: number;
  manual: number;
}

export function summarisePage(page: QaPageResult, overrides: Record<string, CheckStatus>): PageSummary {
  let autoResolved = 0;
  let needsReview = 0;
  let manual = 0;
  for (const check of page.checks) {
    const key = `${page.pageUrl}::${check.id}`;
    const overridden = overrides[key];
    if (overridden) {
      manual += 1;
      continue;
    }
    if (check.status === "review") needsReview += 1;
    else autoResolved += 1;
  }
  return { total: page.checks.length, autoResolved, needsReview, manual };
}

interface Props {
  pages: QaPageResult[];
  overrides: Record<string, CheckStatus>;
  onOverride: (key: string, status: CheckStatus | null) => void;
  running: boolean;
}

export function ResultsSection({ pages, overrides, onOverride, running }: Props) {
  if (running) {
    return (
      <section className="rounded-xl border border-border bg-card p-10 text-center">
        <p className="text-sm font-medium text-foreground">Running automated checks…</p>
        <p className="mt-1 text-sm text-muted-foreground">Scanning each page across 17 QA checks.</p>
      </section>
    );
  }

  if (pages.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
        <p className="text-sm font-medium text-foreground">No results yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add page URLs above and run automated QA to see results here.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold text-foreground">Results</h2>
      {pages.map((page) => (
        <PageCard key={page.pageUrl} page={page} overrides={overrides} onOverride={onOverride} />
      ))}
    </section>
  );
}

const PAGE_TYPE_LABEL: Record<string, string> = {
  homepage: "Homepage",
  "content-migration": "Content Migration",
  other: "Other",
};

function PageCard({
  page,
  overrides,
  onOverride,
}: {
  page: QaPageResult;
  overrides: Record<string, CheckStatus>;
  onOverride: (key: string, status: CheckStatus | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const summary = summarisePage(page, overrides);
  const percent = Math.round((summary.autoResolved / summary.total) * 100);

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 p-5 text-left transition-colors hover:bg-muted/50"
      >
        {open ? (
          <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm font-medium text-foreground">{page.pageUrl}</span>
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {PAGE_TYPE_LABEL[page.pageType]}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {summary.autoResolved} of {summary.total} auto-resolved · {summary.needsReview} need review ·{" "}
            {summary.manual} manual
          </p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-soft">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${percent}%` }} />
          </div>
        </div>
      </button>

      {open ? (
        <div className="border-t border-border">
          {CATEGORY_ORDER.map((category) => {
            const checks = page.checks.filter((check) => check.category === category);
            if (checks.length === 0) return null;
            return (
              <div key={category} className="border-b border-border last:border-b-0">
                <h3 className="bg-muted/60 px-5 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {category}
                </h3>
                <ul>
                  {checks.map((check) => {
                    const key = `${page.pageUrl}::${check.id}`;
                    return (
                      <CheckRow
                        key={check.id}
                        label={check.label}
                        status={overrides[key] ?? check.status}
                        autoStatus={check.status}
                        evidence={check.evidence}
                        overridden={Boolean(overrides[key])}
                        onOverride={(status) => onOverride(key, status)}
                      />
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

function CheckRow({
  label,
  status,
  autoStatus,
  evidence,
  overridden,
  onOverride,
}: {
  label: string;
  status: CheckStatus;
  autoStatus: CheckStatus;
  evidence?: string | undefined;
  overridden: boolean;
  onOverride: (status: CheckStatus | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasEvidence = Boolean(evidence) && (autoStatus === "fail" || autoStatus === "review");

  return (
    <li className="border-b border-border/60 px-5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground">{label}</span>
          {overridden ? (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              Manual
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {hasEvidence ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((value) => !value)}
              className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            >
              <Info className="size-3.5" />
              {expanded ? "Hide evidence" : "Evidence"}
            </Button>
          ) : null}
          <StatusPill status={status} />
        </div>
      </div>

      {hasEvidence && expanded ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/50 p-3">
          <p className="text-sm text-foreground">{evidence}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Manual override:</span>
            <OverrideButton active={status === "pass" && overridden} onClick={() => onOverride("pass")} tone="pass">
              Mark pass
            </OverrideButton>
            <OverrideButton active={status === "fail" && overridden} onClick={() => onOverride("fail")} tone="fail">
              Mark fail
            </OverrideButton>
            {overridden ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onOverride(null)}>
                Reset to automated
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function OverrideButton({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: "pass" | "fail";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
        tone === "pass"
          ? "border-success/30 text-success hover:bg-success-soft"
          : "border-danger/30 text-danger hover:bg-danger-soft",
        active && (tone === "pass" ? "bg-success-soft" : "bg-danger-soft"),
      )}
    >
      {children}
    </button>
  );
}
