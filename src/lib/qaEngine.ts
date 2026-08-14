// Client-safe entry point for the QA engine.
// Re-exports all shared types/constants from qaEngineTypes, and exposes
// runQaBatch, which delegates to the server function. Keeping the shared
// types in a separate module (qaEngineTypes) avoids a circular import
// between this file and qaEngine.server.ts.

export * from "./qaEngineTypes";

import type { QaBatchRow, QaPageResult } from "./qaEngineTypes";

/**
 * Runs the automated QA batch.
 *
 * Delegates to the TanStack Start server function (`runQaBatchServer`), which
 * runs on the server and can fetch arbitrary public URLs without CORS issues.
 * `dealerCodeInput` is the raw "code = value" text for the dealer-codes check.
 */
export async function runQaBatch(
  rows: QaBatchRow[],
  dealerCodeInput = "",
  siteType: "automotive" | "leadscience" = "automotive",
): Promise<QaPageResult[]> {
  const { runQaBatchServer } = await import("./qaEngine.server");
  return runQaBatchServer({ data: { rows, dealerCodeInput, siteType } });
}
