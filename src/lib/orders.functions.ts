import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { getUsdToCoinRates, usdToCoin } from "./pricing.server";

export type Coin = "BTC" | "USDT_ERC20" | "USDC_ERC20";

const COINS = ["BTC", "USDT_ERC20", "USDC_ERC20"] as const;

const CreateInput = z.object({
  full_name: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().max(60).optional().nullable(),
  company: z.string().max(160).optional().nullable(),
  plan_code: z.string().min(1).max(64),
  coin: z.enum(COINS),
});

export type CreateOrderInput = z.infer<typeof CreateInput>;

const PRICE_LOCK_MINUTES = 15;

/** Public: create an order and lock the price. Anon-callable. */
export const createOrderPublic = createServerFn({ method: "POST" })
  .inputValidator((raw: CreateOrderInput) => CreateInput.parse(raw))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { issueReceiveAddress } = await import("./cdp.server");

    // Look up plan
    const { data: plan, error: planErr } = await supabaseAdmin
      .from("plans")
      .select("code, name, amount_usd, active")
      .eq("code", data.plan_code)
      .eq("active", true)
      .maybeSingle();
    if (planErr) throw new Error(planErr.message);
    if (!plan) throw new Error("Plan not available");

    // Price lock
    const rates = await getUsdToCoinRates();
    const amountCoin = usdToCoin(Number(plan.amount_usd), data.coin, rates);
    const now = new Date();
    const expires = new Date(now.getTime() + PRICE_LOCK_MINUTES * 60_000);

    // Address (may be null if operator hasn't configured this coin yet)
    const address = await issueReceiveAddress(data.coin);

    const { data: inserted, error } = await supabaseAdmin
      .from("orders")
      .insert({
        email: data.email.trim().toLowerCase(),
        full_name: data.full_name.trim(),
        phone: data.phone?.trim() || null,
        company: data.company?.trim() || null,
        plan_code: plan.code,
        amount_usd: plan.amount_usd,
        coin: data.coin,
        amount_coin: amountCoin,
        price_locked_at: now.toISOString(),
        price_expires_at: expires.toISOString(),
        receive_address: address,
        status: "pending",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    // TODO: enqueue "order created" email once email domain is verified.

    return { id: inserted.id };
  });

/** Public: read the invoice for an order (no PII beyond what the buyer submitted). */
export const getOrderPublic = createServerFn({ method: "GET" })
  .inputValidator((raw: { id: string }) => z.object({ id: z.string().uuid() }).parse(raw))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("orders")
      .select(
        "id, email, full_name, plan_code, amount_usd, coin, amount_coin, price_locked_at, price_expires_at, receive_address, status, tx_hash, confirmations, access_link, created_at",
      )
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Order not found");
    return row;
  });

/** Admin: list orders with filters. */
export const listOrdersAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { status?: string; limit?: number }) =>
    z
      .object({
        status: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("orders")
      .select(
        "id, email, full_name, plan_code, amount_usd, coin, amount_coin, status, tx_hash, confirmations, access_link, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 100);
    if (data.status) q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/** Admin: totals ticker. */
export const getOrderTotals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("orders")
      .select("status, amount_usd, coin, amount_coin");
    if (error) throw new Error(error.message);
    const totals = {
      total_deposited_usd: 0,
      total_pending_usd: 0,
      total_failed_usd: 0,
      count_paid: 0,
      count_pending: 0,
      count_failed: 0,
      by_coin: {} as Record<string, { paid: number; pending: number }>,
    };
    for (const r of rows ?? []) {
      const usd = Number(r.amount_usd) || 0;
      const coin = String(r.coin);
      const bin = (totals.by_coin[coin] ??= { paid: 0, pending: 0 });
      if (r.status === "paid") {
        totals.total_deposited_usd += usd;
        totals.count_paid += 1;
        bin.paid += Number(r.amount_coin) || 0;
      } else if (r.status === "pending" || r.status === "detected") {
        totals.total_pending_usd += usd;
        totals.count_pending += 1;
        bin.pending += Number(r.amount_coin) || 0;
      } else if (r.status === "expired" || r.status === "cancelled") {
        totals.total_failed_usd += usd;
        totals.count_failed += 1;
      }
    }
    return totals;
  });

/** Admin: set (or update) the access link on a paid order. */
export const setOrderAccessLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { id: string; access_link: string }) =>
    z
      .object({
        id: z.string().uuid(),
        access_link: z.string().url().max(2048),
      })
      .parse(raw),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("orders")
      .update({ access_link: data.access_link, access_link_sent_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    // TODO: fire "access ready" email once domain configured.
    return { ok: true };
  });

/** Super-admin: manually mark an order paid (audit-logged). */
export const markOrderPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { id: string; note?: string }) =>
    z.object({ id: z.string().uuid(), note: z.string().max(500).optional() }).parse(raw),
  )
  .handler(async ({ data, context }) => {
    const { data: rr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "super_admin")
      .maybeSingle();
    if (!rr) throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("orders")
      .update({ status: "paid", notes: data.note ?? null })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("payment_events").insert({
      order_id: data.id,
      source: "admin",
      event_type: "manual_paid",
      raw: { by: context.userId, note: data.note ?? null },
    });
    await supabaseAdmin.from("audit_logs").insert({
      actor: context.userId,
      event: "order.manual_paid",
      detail: { order_id: data.id, note: data.note ?? null },
    });
    return { ok: true };
  });

/** Admin: list active plans (also public via getActivePlansPublic). */
export const getActivePlansPublic = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("plans")
    .select("code, name, description, amount_usd, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
});

const COIN_CHAIN: Record<string, string> = {
  BTC: "bitcoin",
  USDT_ERC20: "ethereum",
  USDC_ERC20: "ethereum",
};

async function assertSuperAdmin(
  supabase: {
    from: (t: string) => {
      select: (c: string) => {
        eq: (a: string, b: string) => {
          eq: (a: string, b: string) => { maybeSingle: () => Promise<{ data: unknown }> };
        };
      };
    };
  },
  userId: string,
) {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "super_admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
}

/** Super-admin: list configured payout wallets. */
export const listWalletsAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("admin_wallets")
      .select("id, coin, chain, cdp_wallet_id, addresses_issued, updated_at")
      .order("coin");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/** Super-admin: create or replace the payout address for a coin. */
export const upsertWalletAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { coin: Coin; address: string }) =>
    z
      .object({
        coin: z.enum(COINS),
        address: z.string().trim().min(20).max(120),
      })
      .parse(raw),
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.supabase as never, context.userId);
    const chain = COIN_CHAIN[data.coin] ?? "bitcoin";
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing } = await supabaseAdmin
      .from("admin_wallets")
      .select("id")
      .eq("coin", data.coin)
      .eq("chain", chain)
      .maybeSingle();
    if (existing) {
      const { error } = await supabaseAdmin
        .from("admin_wallets")
        .update({ cdp_wallet_id: data.address, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin
        .from("admin_wallets")
        .insert({ coin: data.coin, chain, cdp_wallet_id: data.address });
      if (error) throw new Error(error.message);
    }
    await supabaseAdmin.from("audit_logs").insert({
      actor: context.userId,
      event: "wallet.upserted",
      detail: { coin: data.coin, chain },
    });
    return { ok: true };
  });

/** Admin: payments-panel health status (wallets/webhook/cron). */
export const getPaymentsHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: wallets } = await supabaseAdmin
      .from("admin_wallets")
      .select("coin")
      .not("cdp_wallet_id", "is", null);
    const configured = new Set((wallets ?? []).map((w) => w.coin));
    return {
      wallets: {
        BTC: configured.has("BTC"),
        USDT_ERC20: configured.has("USDT_ERC20"),
        USDC_ERC20: configured.has("USDC_ERC20"),
      },
      webhook_secret_set: !!process.env.CDP_WEBHOOK_SECRET,
    };
  });

/**
 * Public: buyer license lookup by email. Returns the most recent PAID order
 * for the email, with access link. Rate-limited to 5 lookups per email per hour.
 */
export const lookupLicenseByEmail = createServerFn({ method: "POST" })
  .inputValidator((raw: { email: string }) =>
    z.object({ email: z.string().email().max(200) }).parse(raw),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const email = data.email.trim().toLowerCase();

    const { count } = await supabaseAdmin
      .from("license_lookups")
      .select("*", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    if ((count ?? 0) >= 5) {
      throw new Error("Too many lookups — try again in an hour.");
    }
    await supabaseAdmin.from("license_lookups").insert({ email });

    const { data: rows } = await supabaseAdmin
      .from("orders")
      .select("id, plan_code, amount_usd, access_link, created_at, status")
      .eq("email", email)
      .eq("status", "paid")
      .order("created_at", { ascending: false })
      .limit(5);
    return rows ?? [];
  });
