/**
 * ICE configuration for the web console. Authenticated: only signed-in
 * technicians/admins get TURN credentials.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getIceConfig, describeIce, type IceConfigDto } from "@/lib/ice.server";

export const getIceServers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<IceConfigDto> => {
    const cfg = await getIceConfig();
    console.log(`[ice] issued hasTurn=${cfg.hasTurn} servers=${describeIce(cfg)}`);
    return cfg;
  });
