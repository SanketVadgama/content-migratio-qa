// SSR server entry. vite.config.ts points TanStack Start's server build here
// (server: { entry: "server" }). This wraps the framework's default request
// handler so that any error thrown during server rendering is logged with a
// full stack (via error-capture) and returned as a friendly error page instead
// of a blank 500.

import defaultEntry, { createServerEntry } from "@tanstack/react-start/server-entry";

import { consumeLastCapturedError, describeError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

export default createServerEntry({
  async fetch(request) {
    try {
      return await defaultEntry.fetch(request);
    } catch (error) {
      // h3 may have already swallowed the real error into a generic 500;
      // recover the original out-of-band if present.
      const captured = consumeLastCapturedError();
      const detail = captured ?? error;
      console.error(describeError(detail));

      // Re-throw framework redirects / notFound-style responses untouched.
      if (detail != null && typeof detail === "object" && "statusCode" in detail) {
        throw detail;
      }

      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
});
