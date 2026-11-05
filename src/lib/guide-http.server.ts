import { createHash, randomBytes } from "node:crypto";

export class GuideHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const guideHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const salt = randomBytes(16).toString("hex");
const buckets = new Map<string, { count: number; until: number }>();

/** Bounded, process-local protection; IPs are never retained or logged. */
export function guardGuideRequest(request: Request, scope: string, limit: number) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0].trim()
    || request.headers.get("host") || new URL(request.url).host;
  let sameOrigin = false;
  try { sameOrigin = !!origin && new URL(origin).host === host; } catch { /* rejected below */ }
  if (!sameOrigin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new GuideHttpError(403, "Please use the guide on this website.");
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new GuideHttpError(415, "A JSON request is required.");
  }
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const key = `${scope}:${createHash("sha256").update(salt + ip).digest("hex")}`;
  const bucket = buckets.get(key) ?? { count: 0, until: now + 60_000 };
  if (bucket.count >= limit || (buckets.size >= 2000 && !buckets.has(key))) {
    throw new GuideHttpError(429, "Please wait a minute before trying again.");
  }
  bucket.count++;
  buckets.set(key, bucket);
}

export async function readGuideJson(request: Request): Promise<unknown> {
  const max = 2048;
  if (Number(request.headers.get("content-length") || 0) > max) {
    throw new GuideHttpError(413, "That request is too long.");
  }
  if (!request.body) throw new GuideHttpError(400, "A request is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new GuideHttpError(413, "That request is too long.");
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof GuideHttpError) throw error;
    throw new GuideHttpError(400, "The request could not be read.");
  } finally { reader.releaseLock(); }
}

export function guideErrorResponse(error: unknown) {
  const known = error instanceof GuideHttpError;
  if (!known) console.warn(JSON.stringify({ scope: "homepage_guide", event: "request_failed" }));
  return Response.json(
    { error: known ? error.message : "The guide is temporarily unavailable. Please try again." },
    { status: known ? error.status : 503, headers: { ...guideHeaders, ...(known && error.status === 429 ? { "Retry-After": "60" } : {}) } },
  );
}
