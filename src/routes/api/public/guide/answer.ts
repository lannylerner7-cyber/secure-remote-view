import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { answerGuideQuestion } from "@/lib/guide-answer.server";
import { guardGuideRequest, readGuideJson, guideHeaders, guideErrorResponse, GuideHttpError } from "@/lib/guide-http.server";

const Input = z.object({
  question: z.string().trim().min(1).max(500),
  previousId: z.string().regex(/^[a-z-]{1,60}$/).optional(),
}).strict();

export const Route = createFileRoute("/api/public/guide/answer")({
  server: { handlers: { POST: async ({ request }) => {
    try {
      guardGuideRequest(request, "answer", 30);
      const parsed = Input.safeParse(await readGuideJson(request));
      if (!parsed.success) throw new GuideHttpError(400, "Ask a question of up to 500 characters.");
      const answer = await answerGuideQuestion(parsed.data.question, parsed.data.previousId);
      // No visitor text or personal details in logs or provider calls.
      return Response.json(answer, { headers: guideHeaders });
    } catch (error) { return guideErrorResponse(error); }
  } } },
});
