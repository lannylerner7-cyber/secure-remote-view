import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Super-admin visibility for the auto-enrollment Deployment Key.
 * Returns configured/masked status only — the plaintext value is never
 * exposed at runtime. Rotation happens via the workspace Secrets manager;
 * existing enrolled devices keep working (they use per-device tokens).
 */
export const getDeploymentKeyStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isSuper } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "super_admin",
    });
    if (!isSuper) throw new Error("Forbidden");

    const key = process.env.AGENT_DEPLOYMENT_KEY ?? "";
    if (!key) return { configured: false as const };
    return {
      configured: true as const,
      length: key.length,
      last4: key.slice(-4),
    };
  });
