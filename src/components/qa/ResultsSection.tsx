import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/qa/StatusPill";
import {
  CATEGORY_ORDER,
  type CheckStatus,
  type QaCheckDetails,
  type QaDetailItem,
  type QaPageResult,
} from "@/lib/qaEngine";
import { ChevronDown, ChevronRight, Info, ListChecks } from "lucide-react";
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
  const [expandAll, setExpandAll] = useState(false);
  const summary = summarisePage(page, overrides);
  const percent = Math.round((summary.autoResolved / summary.total) * 100);

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-start gap-3 p-5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={open ? "Collapse page" : "Expand page"}
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="min-w-0 flex-1 text-left"
        >
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
        </button>
        {open ? (
          <button
            type="button"
            onClick={() => setExpandAll((v) => !v)}
            className="shrink-0 whitespace-nowrap rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {expandAll ? "Collapse all checks" : "Expand all checks"}
          </button>
        ) : null}
      </div>

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
                        details={check.details}
                        overridden={Boolean(overrides[key])}
                        forceExpand={expandAll}
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
  details,
  overridden,
  forceExpand,
  onOverride,
}: {
  label: string;
  status: CheckStatus;
  autoStatus: CheckStatus;
  evidence?: string | undefined;
  details?: QaCheckDetails | undefined;
  overridden: boolean;
  forceExpand: boolean;
  onOverride: (status: CheckStatus | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasEvidence = Boolean(evidence) && (autoStatus === "fail" || autoStatus === "review");
  const hasDetails = Boolean(details && details.items.length > 0);
  const canExpand = hasEvidence || hasDetails;
  const isExpanded = (expanded || forceExpand) && canExpand;

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
          {canExpand ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((value) => !value)}
              className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            >
              {hasDetails ? <ListChecks className="size-3.5" /> : <Info className="size-3.5" />}
              {isExpanded ? "Hide" : hasDetails ? `Details (${details!.items.length})` : "Evidence"}
            </Button>
          ) : null}
          <StatusPill status={status} />
        </div>
      </div>

      {isExpanded ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/50 p-3">
          {hasEvidence ? <p className="text-sm text-foreground">{evidence}</p> : null}

          {hasDetails ? <DetailList details={details!} /> : null}

          {hasEvidence ? (
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
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Renders the on-screen inspection lists (images / links / oversized). Never part of the download. */
function DetailList({ details }: { details: QaCheckDetails }) {
  if (details.kind === "links") {
    return (
      <div className="mt-1 divide-y divide-border/50 overflow-hidden rounded-md border border-border/60">
        {details.items.map((item, i) => (
          <LinkRow key={`${item.primary}-${i}`} item={item} />
        ))}
      </div>
    );
  }

  if (details.kind === "dealer-codes") {
    return (
      <div className="mt-1 divide-y divide-border/50 overflow-hidden rounded-md border border-border/60">
        {details.items.map((item, i) => (
          <div key={`${item.primary}-${i}`} className="flex items-center gap-2 bg-card px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={item.primary}>
              "{item.primary}"
            </span>
            {item.secondary ? (
              <span className="shrink-0 font-mono text-xs text-brand" title={`Should use ${item.secondary}`}>
                {item.secondary}
              </span>
            ) : null}
            {item.note ? <FlagPill flag={item.flag} note={item.note} /> : null}
          </div>
        ))}
      </div>
    );
  }

  // images / oversized-images
  return (
    <div className="mt-1 space-y-2">
      {details.items.map((item, i) => (
        <div
          key={`${item.primary}-${i}`}
          className="flex items-start gap-3 rounded-md border border-border/60 bg-card px-3 py-2"
        >
          <a
            href={item.primary}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0"
            title="Open full-size image"
          >
            <img
              src={item.primary}
              alt=""
              className="size-10 shrink-0 cursor-zoom-in rounded object-cover ring-1 ring-border transition hover:ring-2 hover:ring-brand"
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
              }}
            />
          </a>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs text-foreground" title={item.primary}>
              {item.primary}
            </p>
            {item.secondary ? (
              <p className="truncate text-xs text-muted-foreground" title={item.secondary}>
                alt: {item.secondary}
              </p>
            ) : (
              <p className="text-xs italic text-muted-foreground">(no alt text)</p>
            )}
          </div>
          {item.note ? <FlagPill flag={item.flag} note={item.note} /> : null}
        </div>
      ))}
    </div>
  );
}

/** Compact single-row link entry; GA4 tags collapse behind a toggle. */
function LinkRow({ item }: { item: QaDetailItem }) {
  const [showTags, setShowTags] = useState(false);
  const hasTags = Boolean(item.extra && item.extra.length > 0);

  return (
    <div className="bg-card px-3 py-1.5">
      <div className="flex items-center gap-2">
        <a
          href={item.primary}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate font-mono text-xs text-foreground hover:text-brand hover:underline"
          title={item.primary}
        >
          {item.primary}
        </a>
        {item.secondary && item.secondary !== "(no text)" ? (
          <span className="hidden max-w-[30%] shrink-0 truncate text-xs text-muted-foreground sm:inline" title={item.secondary}>
            {item.secondary}
          </span>
        ) : null}
        {hasTags ? (
          <button
            type="button"
            onClick={() => setShowTags((v) => !v)}
            className="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            {showTags ? "hide tags" : `tags (${item.extra!.length})`}
          </button>
        ) : null}
        {item.note ? <FlagPill flag={item.flag} note={item.note} /> : null}
      </div>
      {showTags && hasTags ? (
        <div className="mt-1 mb-1 flex flex-wrap gap-1 rounded border border-border/50 bg-muted/40 p-1.5">
          {item.extra!.map((line, j) => (
            <span key={j} className="rounded bg-card px-1.5 py-0.5 font-mono text-[10px] leading-tight text-foreground/80">
              {line}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FlagPill({ flag, note }: { flag?: "ok" | "warn" | "fail"; note: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
        flag === "ok" && "border-success/30 text-success",
        flag === "warn" && "border-warning/40 text-warning-foreground",
        flag === "fail" && "border-danger/30 text-danger",
        !flag && "border-border text-muted-foreground",
      )}
    >
      {note}
    </span>
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
