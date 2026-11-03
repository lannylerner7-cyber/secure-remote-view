import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sessionAuthorized } from "./authorization.server";
import { usesLegacyActions } from "@/shared/legacy-monitor";

/** The old receiver polls this capture command; no general power operation is exposed. */
export const requestLegacyMonitor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: { sessionId: string; deviceName: string }) => {
    if (!value || typeof value.sessionId !== "string" || value.sessionId.length > 64 ||
        typeof value.deviceName !== "string" || !value.deviceName.length || value.deviceName.length > 200)
      throw new Error("Invalid monitor request");
    return value;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: session, error } = await supabase.from("sessions")
      .select("id, device_id, technician_id, authorization_id, state, media_mode")
      .eq("id", data.sessionId).maybeSingle();
    if (error || !session || session.state !== "active" || !session.authorization_id)
      throw new Error("An authorized active session is required");
    if (session.technician_id !== userId) {
      const role = await supabase.rpc("has_role", { _user_id: userId, _role: "super_admin" as never });
      if (role.error || role.data !== true) throw new Error("This session belongs to another technician");
    }
    if (!(await sessionAuthorized(supabase, session.id))) throw new Error("View permission is no longer valid");
    const device = await supabase.from("devices").select("metadata").eq("id", session.device_id!).maybeSingle();
    if (device.error || !device.data || !usesLegacyActions(session.media_mode, device.data.metadata))
      throw new Error("Use the acknowledged live channel for this Agent");
    const metadata = device.data.metadata as Record<string, unknown> | null;
    if (!Array.isArray(metadata?.monitors) || !metadata.monitors.some(m =>
      m && typeof m === "object" && (m as Record<string, unknown>).device_name === data.deviceName))
      throw new Error("The Agent has not reported that display");
    const inserted = await supabase.from("power_commands").insert({
      device_id: session.device_id!, requested_by: userId, kind: "switch_monitor",
      expires_at: new Date(Date.now() + 10_000).toISOString(),
      payload: { protocol: "legacy-monitor-v1", session_id: session.id,
        authorization_id: session.authorization_id, device_name: data.deviceName },
    }).select("id").single();
    if (inserted.error) throw new Error("Could not queue the legacy display request");
    return { commandId: inserted.data.id, status: "queued_unconfirmed" as const };
  });
