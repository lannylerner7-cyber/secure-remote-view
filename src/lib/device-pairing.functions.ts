import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { IssuedPairing } from "@/shared/device-pairing";

const grantSchema = z.object({
  noticeVersion: z.literal(1),
  mode: z.enum(["attended", "unattended"]),
  capabilities: z.object({
    view: z.literal(true), control: z.boolean(), clipboard: z.boolean(),
    files: z.boolean(), recording: z.boolean(),
  }).strict(),
}).strict();

export const listPairingLicenses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { adminClient } = await import("@/lib/server-supabase");
    const admin = adminClient();
    const { data: roles, error: rolesError } = await context.supabase
      .from("user_roles").select("role").eq("user_id", context.userId);
    if (rolesError) throw new Error("Could not verify your account permissions.");
    const superAdmin = (roles as Array<{ role: string }> | null)?.some((role) => role.role === "super_admin") === true;
    let query = admin.from("licenses").select("id,company,expires_at,seat_limit")
      .eq("status", "active").not("user_id", "is", null)
      .gt("expires_at", new Date().toISOString()).lte("starts_at", new Date().toISOString());
    if (!superAdmin) query = query.eq("user_id", context.userId);
    const { data, error } = await query.order("company");
    if (error) throw new Error("Could not load eligible licenses.");
    return (data ?? []).map((license) => ({
      id: license.id, organization: license.company ?? "",
      expiresAt: license.expires_at, seatLimit: license.seat_limit,
    }));
  });

export const createDevicePairing = createServerFn({ method: "POST" })
  .inputValidator(z.object({ licenseId: z.string().uuid(), grant: grantSchema }).strict())
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }): Promise<IssuedPairing> => {
    const { adminClient } = await import("@/lib/server-supabase");
    const { generatePairingCode, hashPairingValue, parsePairingOffer, pairingError } =
      await import("@/lib/device-pairing.server");
    const code = generatePairingCode();
    const { data: result, error } = await adminClient().rpc("create_device_pairing", {
      _actor: context.userId, _license: data.licenseId,
      _code_hash: hashPairingValue(code.replace(/-/g, "")), _grant: data.grant,
    });
    if (error) throw new Error(pairingError(error.message));
    const offer = parsePairingOffer(result);
    if (!offer) throw new Error("Pairing returned an invalid disclosure; no code will be shown.");
    return { ...offer, code };
  });

export const revokeDevicePairing = createServerFn({ method: "POST" })
  .inputValidator(z.object({ pairingId: z.string().uuid() }).strict())
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { adminClient } = await import("@/lib/server-supabase");
    const { data: revoked, error } = await adminClient().rpc("revoke_device_pairing", {
      _actor: context.userId, _pairing_id: data.pairingId,
    });
    if (error || revoked !== true) throw new Error("The pairing code could not be revoked.");
    return { revoked: true };
  });

export const revokeManagedDeviceAccess = createServerFn({ method: "POST" })
  .inputValidator(z.object({ deviceId: z.string().uuid() }).strict())
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { adminClient } = await import("@/lib/server-supabase");
    const { data: revoked, error } = await adminClient().rpc("revoke_managed_device_access", {
      _actor: context.userId, _device_id: data.deviceId,
    });
    if (error || revoked !== true) throw new Error("Access could not be revoked. Verify your organization permissions.");
    return { revoked: true };
  });
