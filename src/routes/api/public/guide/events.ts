import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { GUIDE_EVENTS } from "@/components/site/guide/guide-contract";
import { knowledgeEntries } from "@/components/site/guide/guide-knowledge";
import { guardGuideRequest, readGuideJson, guideHeaders, guideErrorResponse, GuideHttpError } from "@/lib/guide-http.server";

const topics = new Set(["greeting", "unknown", "catalog-unavailable", ...knowledgeEntries.map((entry) => entry.id)]);
const Input = z.object({
  event: z.enum(GUIDE_EVENTS),
  topic: z.string().refine((value) => topics.has(value)).optional(),
  page: z.number().int().min(1).max(100).optional(),
  durationMs: z.number().int().min(0).max(3_600_000).optional(),
  phase: z.enum(["seated", "greeting", "speaking", "presenting", "paused", "rising", "walking", "returning", "sitting", "standing", "approaching"]).optional(),
  reason: z.enum(["visitor", "hidden", "offscreen", "new_answer", "unmount", "provider", "playback", "static", "webgl", "network"]).optional(),
}).strict();

export const Route = createFileRoute("/api/public/guide/events")({
  server: { handlers: { POST: async ({ request }) => {
    try {
      guardGuideRequest(request, "events", 120);
      if (request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1") {
        return new Response(null, { status: 204, headers: guideHeaders });
      }
      const parsed = Input.safeParse(await readGuideJson(request));
      if (!parsed.success) throw new GuideHttpError(400, "Invalid guide event.");
      // Only enumerated events + known topic IDs + bounded numbers. Never
      // record questions, names, session IDs, IPs, or device fingerprints.
      console.info(JSON.stringify({ scope: "homepage_guide", timestamp: new Date().toISOString(), ...parsed.data }));
      return new Response(null, { status: 204, headers: guideHeaders });
    } catch (error) { return guideErrorResponse(error); }
  } } },
});
