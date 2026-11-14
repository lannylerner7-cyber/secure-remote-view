import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { applyResponseCachePolicy } from "./lib/response-cache-policy";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(request: Request, response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  // srvx aborts this request when its response socket closes. h3 may turn
  // that cancellation into its generic HTTPError response before we see it.
  // It is not evidence of a failed page render or an Agent curtain failure.
  if (request.signal.aborted) return cancelledResponse();

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function cancelledResponse(): Response {
  return new Response(null, {
    status: 499, statusText: "Client Closed Request",
    headers: { "cache-control": "private, no-store" },
  });
}

function isRequestCancellation(request: Request, error: unknown): boolean {
  if (!request.signal.aborted) return false;
  // h3 wraps DOMException in HTTPError.cause. Do not suppress unrelated
  // server errors, or an upstream timeout on a still-connected request.
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && error && typeof error === "object"; depth++) {
    if (seen.has(error)) break;
    seen.add(error);
    if ("name" in error && error.name === "AbortError") return true;
    // Node's aborted incoming request uses Error/ECONNRESET instead of a
    // DOMException. Do not hide arbitrary upstream connection resets.
    if ("code" in error && error.code === "ECONNRESET" &&
        "message" in error && error.message === "aborted") return true;
    error = "cause" in error ? error.cause : null;
  }
  return false;
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    if (request.signal.aborted) return applyResponseCachePolicy(request, cancelledResponse());
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return applyResponseCachePolicy(request, await normalizeCatastrophicSsrResponse(request, response));
    } catch (error) {
      if (isRequestCancellation(request, error))
        return applyResponseCachePolicy(request, cancelledResponse());
      console.error(error);
      return applyResponseCachePolicy(request, new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
    }
  },
};
