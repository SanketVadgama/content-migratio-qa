import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Loader2, PlayCircle } from "lucide-react";
import type { PageType, QaBatchRow } from "@/lib/qaEngine";

interface Props {
  rows: QaBatchRow[];
  onChange: (rows: QaBatchRow[]) => void;
  onRun: () => void;
  running: boolean;
}

export function newRow(pageUrl = ""): QaBatchRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pageUrl,
    referenceUrl: "",
    pageType: "content-migration",
  };
}

const PAGE_TYPES: { value: PageType; label: string }[] = [
  { value: "homepage", label: "Homepage" },
  { value: "content-migration", label: "Content Migration" },
  { value: "other", label: "Other" },
];

export function BatchInputSection({ rows, onChange, onRun, running }: Props) {
  const [bulk, setBulk] = useState("");

  function updateRow(id: string, patch: Partial<QaBatchRow>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function applyBulk() {
    const urls = bulk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (urls.length === 0) return;
    const existing = rows.filter((row) => row.pageUrl.trim() !== "");
    onChange([...existing, ...urls.map((url) => newRow(url))]);
    setBulk("");
  }

  const readyCount = rows.filter((row) => row.pageUrl.trim() !== "").length;

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <header className="mb-5">
        <h2 className="text-base font-semibold text-foreground">Batch Input</h2>
        <p className="text-sm text-muted-foreground">
          Paste page URLs one per line, or build the list row by row.
        </p>
      </header>

      <div className="rounded-lg border border-dashed border-border bg-muted/40 p-4">
        <Label htmlFor="bulk-urls" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Paste bulk URLs
        </Label>
        <Textarea
          id="bulk-urls"
          value={bulk}
          onChange={(event) => setBulk(event.target.value)}
          rows={4}
          placeholder={"https://example.com/about\nhttps://example.com/service\nhttps://example.com/specials"}
          className="mt-2 bg-card font-mono text-sm"
        />
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={applyBulk} disabled={bulk.trim() === ""}>
            Add {bulk.split("\n").filter((line) => line.trim() !== "").length || ""} URLs to list
          </Button>
          <span className="text-xs text-muted-foreground">Splits on newline into rows below.</span>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <div className="hidden gap-3 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase lg:grid lg:grid-cols-[1fr_1fr_190px_40px]">
          <span>New page URL</span>
          <span>Reference URL (optional)</span>
          <span>Page type</span>
          <span />
        </div>

        {rows.map((row, index) => (
          <div
            key={row.id}
            className="grid gap-3 rounded-lg border border-border bg-background p-3 lg:grid-cols-[1fr_1fr_190px_40px] lg:items-center lg:border-transparent lg:bg-transparent lg:p-1"
          >
            <Input
              value={row.pageUrl}
              onChange={(event) => updateRow(row.id, { pageUrl: event.target.value })}
              placeholder={`https://example.com/page-${index + 1}`}
              className="font-mono text-sm"
              maxLength={500}
            />
            <Input
              value={row.referenceUrl ?? ""}
              onChange={(event) => updateRow(row.id, { referenceUrl: event.target.value })}
              placeholder="https://old-site.com/page"
              className="font-mono text-sm"
              maxLength={500}
            />
            <Select value={row.pageType} onValueChange={(value) => updateRow(row.id, { pageType: value as PageType })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove row"
              onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
              disabled={rows.length === 1}
              className="justify-self-end text-muted-foreground hover:text-danger"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, newRow()])}>
          <Plus className="size-4" /> Add row
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{readyCount} page{readyCount === 1 ? "" : "s"} queued</span>
          <Button type="button" onClick={onRun} disabled={running || readyCount === 0} variant="brand">
            {running ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
            {running ? "Running automated QA…" : "Run Automated QA"}
          </Button>
        </div>
      </div>
    </section>
  );
}
