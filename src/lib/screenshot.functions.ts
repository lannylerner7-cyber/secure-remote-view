import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sessionAuthorized } from "./authorization.server";

export const authorizeSessionScreenshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ sessionId: z.string().uuid(), deviceId: z.string().uuid(), authorizationId: z.string().uuid(),
    controllerId: z.string().min(1).max(128), peerId: z.string().uuid().nullable() }).strict())
  .handler(async ({ data, context }) => {
    const [session, roles] = await Promise.all([
      context.supabase.from("sessions").select("id,device_id,authorization_id,technician_id,admin_client_id,state")
        .eq("id",data.sessionId).maybeSingle(),
      context.supabase.from("user_roles").select("role").eq("user_id",context.userId),
    ]);
    if (session.error || roles.error) throw new Error("Screenshot authorization unavailable.");
    const s = session.data;
    if (!s || s.state !== "active" || s.device_id !== data.deviceId || s.authorization_id !== data.authorizationId ||
        s.technician_id !== context.userId || s.admin_client_id !== data.controllerId ||
        !roles.data?.some(r => ["super_admin","admin","technician"].includes(r.role)) ||
        !await sessionAuthorized(context.supabase,s.id,"recording"))
      throw new Error("Still-image export requires this session's recording permission and current controller.");
    if (data.peerId) {
      const offer = await context.supabase.from("session_signals").select("payload")
        .eq("session_id",s.id).eq("from_side","admin").eq("kind","offer").eq("admin_client_id",data.controllerId)
        .order("id",{ascending:false}).limit(1).maybeSingle();
      if (offer.error || (offer.data?.payload as {peer_id?:unknown}|null)?.peer_id !== data.peerId)
        throw new Error("The displayed peer changed.");
    }
    return { ok: true };
  });
