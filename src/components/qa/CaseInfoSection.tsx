import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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

interface Props {
  value: CaseInfo;
  onChange: (next: CaseInfo) => void;
}

export function CaseInfoSection({ value, onChange }: Props) {
  const set = (key: keyof CaseInfo) => (event: { target: { value: string } }) =>
    onChange({ ...value, [key]: event.target.value });

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <header className="mb-5">
        <h2 className="text-base font-semibold text-foreground">Case Information</h2>
        <p className="text-sm text-muted-foreground">
          Identify the case being reviewed. These details appear on the exported report.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field id="case-number" label="Case Number" required>
          <Input id="case-number" value={value.caseNumber} onChange={set("caseNumber")} placeholder="e.g. 00458123" maxLength={60} />
        </Field>
        <Field id="designer-name" label="Designer Name" required>
          <Input id="designer-name" value={value.designerName} onChange={set("designerName")} placeholder="e.g. Jordan Reyes" maxLength={120} />
        </Field>
        <Field id="dealer-name" label="Dealer / Website Name" required>
          <Input id="dealer-name" value={value.dealerName} onChange={set("dealerName")} placeholder="e.g. Riverside Motors" maxLength={160} />
        </Field>
        <Field id="website-url" label="Website URL" required>
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
