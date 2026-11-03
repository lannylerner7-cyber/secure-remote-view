import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getLiveAuthorization = createServerFn({ method: "POST" })
  .inputValidator(z.object({ sessionId: z.string().uuid() }).strict())
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { sessionAuthorized, currentAuthorization } = await import("@/lib/authorization.server");
    if (!(await sessionAuthorized(context.supabase, data.sessionId, "view")))
      throw new Error("This live session is not authorized.");
    const { data: session, error } = await context.supabase.from("sessions")
      .select("device_id,authorization_id").eq("id", data.sessionId).maybeSingle();
    if (error || !session?.device_id || !session.authorization_id)
      throw new Error("Session permissions are unavailable.");
    const { adminClient } = await import("@/lib/server-supabase");
    const grant = await currentAuthorization(adminClient(), session.device_id);
    if (!grant || grant.revokedAt !== null || grant.id !== session.authorization_id)
      throw new Error("Device authorization has changed.");
    return grant;
  });
