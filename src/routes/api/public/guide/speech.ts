import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getGuideReply } from "@/lib/guide-answer.server";
import { getGuideSpeech } from "@/lib/guide-speech.server";
import { guardGuideRequest, readGuideJson, guideHeaders, guideErrorResponse, GuideHttpError } from "@/lib/guide-http.server";

const Input = z.object({
  answerId: z.string().regex(/^[a-z-]{1,60}$/),
  textHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const Route = createFileRoute("/api/public/guide/speech")({
  server: { handlers: { POST: async ({ request }) => {
    try {
      guardGuideRequest(request, "speech", 20);
      const parsed = Input.safeParse(await readGuideJson(request));
      if (!parsed.success) throw new GuideHttpError(400, "Choose a verified guide answer to hear.");
      const reply = await getGuideReply(parsed.data.answerId);
      if (!reply) throw new GuideHttpError(404, "That guide answer isn't available.");
      if (reply.textHash !== parsed.data.textHash) {
        throw new GuideHttpError(409, "That answer has changed. Ask again to hear the latest verified information.");
      }
      return Response.json(await getGuideSpeech(reply), { headers: guideHeaders });
    } catch (error) { return guideErrorResponse(error); }
  } } },
});
