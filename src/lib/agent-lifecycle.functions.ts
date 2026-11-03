import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { RelaunchCommand } from "@/shared/agent-lifecycle";

export const requestAgentRelaunch = createServerFn({ method: "POST" })
  .inputValidator(z.object({ deviceId: z.string().uuid() }).strict())
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }): Promise<RelaunchCommand> => {
    const { adminClient } = await import("@/lib/server-supabase");
    const { data: result, error } = await adminClient().rpc("request_agent_relaunch", {
      _actor: context.userId, _device: data.deviceId,
    });
    if (error) {
      if (error.message.includes("authorized_watch_unavailable"))
        throw new Error("Watch is unavailable or startup/recovery is not authorized. This cannot wake an offline or uninstalled device.");
      if (error.message.includes("device_forbidden")) throw new Error("You cannot manage this device.");
      if (error.message.includes("windows_agent_required")) throw new Error("This action requires the updated Windows Agent.");
      if (error.message.includes("updated_agent_required")) throw new Error("This Agent does not advertise the lifecycle protocol. Update it before using browser relaunch.");
      if (error.message.includes("relaunch_rate_limited")) throw new Error("Wait 15 seconds before requesting another recovery.");
      throw new Error("Relaunch service unavailable. Verify the Agent lifecycle migration and server configuration.");
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.id !== "string")
      throw new Error("Relaunch returned an invalid receipt.");
    return result as unknown as RelaunchCommand;
  });
