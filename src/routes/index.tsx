import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Content Migration QA — Verify Every Migrated Page" },
      {
        name: "description",
        content:
          "A workspace for tracking, reviewing, and signing off on content migration quality checks.",
      },
      { property: "og:title", content: "Content Migration QA" },
      {
        property: "og:description",
        content:
          "Track, review, and sign off on content migration quality checks in one workspace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-xl text-center">
        <span className="inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Workspace
        </span>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Content Migration QA
        </h1>
        <p className="mt-4 text-base text-muted-foreground">
          A blank starting point. Tell me what to build first — page inventory,
          diff review, checklists, or sign-off tracking.
        </p>
      </div>
    </main>
  );
}
