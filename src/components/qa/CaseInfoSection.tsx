import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { z } from "zod";

export interface CaseInfo {
  caseNumber: string;
  designerName: string;
  dealerName: string;
  websiteUrl: string;
  dateStarted: string;
  caseNotes: string;
}

export const emptyCaseInfo: CaseInfo = {
  caseNumber: "",
  designerName: "",
  dealerName: "",
  websiteUrl: "",
  dateStarted: "",
  caseNotes: "",
};

const caseSchema = z.object({
  caseNumber: z.string().trim().min(1, "Case number is required").max(60, "Case number is too long"),
  designerName: z.string().trim().min(1, "Designer name is required").max(120, "Designer name is too long"),
  dealerName: z.string().trim().max(160, "Dealer/website name is too long"),
  websiteUrl: z.union([z.literal(""), z.string().trim().url("Website URL must be a valid URL").max(500)]),
  dateStarted: z.string().trim().max(20),
  caseNotes: z.string().trim().max(2000, "Case notes must be under 2000 characters"),
});

interface Props {
  value: CaseInfo;
  onChange: (next: CaseInfo) => void;
}

export function CaseInfoSection({ value, onChange }: Props) {
  const [saving, setSaving] = useState(false);

  const set = (key: keyof CaseInfo) => (event: { target: { value: string } }) =>
    onChange({ ...value, [key]: event.target.value });

  async function handleSave() {
    const parsed = caseSchema.safeParse(value);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Please check the case details");
      return;
    }

    setSaving(true);
    const data = parsed.data;
    const { error } = await supabase.from("qa_cases").insert({
      case_number: data.caseNumber,
      designer_name: data.designerName,
      dealer_name: data.dealerName || null,
      website_url: data.websiteUrl || null,
      date_started: data.dateStarted || null,
      case_notes: data.caseNotes || null,
    });
    setSaving(false);

    if (error) {
      toast.error("Could not save case details. Please try again.");
      return;
    }
    toast.success("Case details saved");
  }

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Case Information</h2>
          <p className="text-sm text-muted-foreground">Identify the case being reviewed.</p>
        </div>
        <Button onClick={handleSave} disabled={saving} variant="secondary">
          {saving ? "Saving…" : "Save case"}
        </Button>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field id="case-number" label="Case Number" required>
          <Input id="case-number" value={value.caseNumber} onChange={set("caseNumber")} placeholder="e.g. 00458123" maxLength={60} />
        </Field>
        <Field id="designer-name" label="Designer Name" required>
          <Input id="designer-name" value={value.designerName} onChange={set("designerName")} placeholder="e.g. Jordan Reyes" maxLength={120} />
        </Field>
        <Field id="dealer-name" label="Dealer / Website Name">
          <Input id="dealer-name" value={value.dealerName} onChange={set("dealerName")} placeholder="e.g. Riverside Motors" maxLength={160} />
        </Field>
        <Field id="website-url" label="Website URL">
          <Input id="website-url" value={value.websiteUrl} onChange={set("websiteUrl")} placeholder="https://example.com" maxLength={500} />
        </Field>
        <Field id="date-started" label="Date Started">
          <Input id="date-started" type="date" value={value.dateStarted} onChange={set("dateStarted")} />
        </Field>
      </div>

      <div className="mt-4">
        <Field id="case-notes" label="Case Notes (optional)">
          <Textarea
            id="case-notes"
            value={value.caseNotes}
            onChange={set("caseNotes")}
            placeholder="Special requests, known issues, anything the reviewer should know…"
            rows={3}
            maxLength={2000}
          />
        </Field>
      </div>
    </section>
  );
}

function Field({
  id,
  label,
  required,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        {required ? <span className="ml-1 text-brand">*</span> : null}
      </Label>
      {children}
    </div>
  );
}
