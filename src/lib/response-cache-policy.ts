/** Prevent intermediary/browser reuse of private or operational responses.
 * Static assets and public marketing pages keep their existing cache policy.
 * Do not buffer/consume the response body: SSE must remain a live stream.
 */
export function applyResponseCachePolicy(request: Request, response: Response): Response {
  const path = new URL(request.url).pathname;
  const privateResponse = path === "/health" || path === "/api" || path.startsWith("/api/") ||
    path.startsWith("/_server") || /^\/(console|payments|account)(\/|$)/.test(path) ||
    request.headers.has("authorization") || response.headers.has("set-cookie");
  if (!privateResponse) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, no-transform");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  headers.delete("Expires");
  headers.delete("ETag");
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}
