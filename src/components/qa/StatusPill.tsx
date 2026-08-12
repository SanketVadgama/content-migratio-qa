import type { CheckStatus } from "@/lib/qaEngine";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<CheckStatus, { label: string; className: string }> = {
  pass: { label: "Pass", className: "bg-success-soft text-success border-success/25" },
  fail: { label: "Fail", className: "bg-danger-soft text-danger border-danger/25" },
  review: { label: "Needs review", className: "bg-warning-soft text-warning-foreground border-warning/35" },
  na: { label: "N/A", className: "bg-neutral-soft text-muted-foreground border-border" },
};

export function StatusPill({ status, className }: { status: CheckStatus; className?: string }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        style.className,
        className,
      )}
    >
      {style.label}
    </span>
  );
}

export const STATUS_LABELS = STATUS_STYLES;
