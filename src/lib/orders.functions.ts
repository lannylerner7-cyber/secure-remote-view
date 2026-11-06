import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { getUsdToCoinRates, usdToCoin } from "./pricing.server";
import { BITCOIN_CONFIRMATIONS, isBitcoinAddress, normalizeBitcoinAddress, type PaymentsHealth } from "@/shared/bitcoin";

export type Coin = "BTC" | "USDT_ERC20" | "USDC_ERC20";

const CreateInput = z.object({
  full_name: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().max(60).optional().nullable(),
  company: z.string().max(160).optional().nullable(),
  plan_code: z.string().min(1).max(64),
  coin: z.literal("BTC"),
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

    // Fail quickly before rate-provider calls if checkout has no usable wallet.
    const address = await issueReceiveAddress(data.coin);
    if (!address) throw new Error("Bitcoin receiving wallet is not configured. Please contact support.");

    // Price lock
    const rates = await getUsdToCoinRates();
    const amountCoin = usdToCoin(Number(plan.amount_usd), data.coin, rates);
    const now = new Date();
    const expires = new Date(now.getTime() + PRICE_LOCK_MINUTES * 60_000);

    // The RPC atomically reserves the amount and creates the invoice. Never
    // fall back to a shared, non-unique amount if the migration is missing.
    const { data: quoted, error } = await supabaseAdmin.rpc(
      "create_unique_payment_order" as never,
      {
        _base_amount: String(amountCoin),
        _order: {
        email: data.email.trim().toLowerCase(),
        full_name: data.full_name.trim(),
        phone: data.phone?.trim() || null,
        company: data.company?.trim() || null,
        plan_code: plan.code,
        amount_usd: plan.amount_usd,
        coin: data.coin,
        price_locked_at: now.toISOString(),
        price_expires_at: expires.toISOString(),
        receive_address: address,
        },
      } as never,
    );
    if (error) throw new Error(error.message);
    const rows = quoted as unknown as Array<{ order_id: string; quoted_amount: string | number }>;
    const inserted = rows?.[0] ? { id: rows[0].order_id } : null;
    if (!inserted) throw new Error("Quote creation returned no order.");

    // Order received email (never blocks or fails the order).
    try {
      const { sendOrderEmailById } = await import("./order-emails.server");
      await sendOrderEmailById("order_received", inserted.id);
    } catch {
      /* logged in order_emails */
    }

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
    await assertPaymentAdmin(context.supabase as never, context.userId);
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
    await assertPaymentAdmin(context.supabase as never, context.userId);
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
        access_link: z.string().url().max(2048).refine((value) => {
          const u = new URL(value);
          return u.protocol === "https:" && !u.username && !u.password;
        }, "Use an HTTPS access link without embedded credentials."),
      })
      .parse(raw),
  )
  .handler(async ({ data, context }) => {
    await assertPaymentAdmin(context.supabase as never, context.userId);
    const { data: updated, error } = await context.supabase
      .from("orders")
      .update({ access_link: data.access_link, access_link_sent_at: null })
      .eq("id", data.id).eq("status", "paid").select("id");
    if (error) throw new Error(error.message);
    if (!updated?.length) throw new Error("A paid order is required.");
    // Delivery email. Never throws — SMTP being down must not fail the update.
    const { sendOrderEmailById } = await import("./order-emails.server");
    const delivery = await sendOrderEmailById("access_ready", data.id);
    if (!delivery.ok) throw new Error(`Access link saved, but email was not confirmed: ${delivery.reason}. Retry from the email log.`);
    if (delivery.warning) throw new Error("Email accepted, but delivery tracking could not be saved. Do not resend automatically.");
    return { ok: true };
  });

/** Super-admin: manually mark an order paid (audit-logged). */
export const markOrderPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { id: string; note: string }) =>
    z.object({ id: z.string().uuid(), note: z.string().trim().min(10, "Explain why this payment is being confirmed (at least 10 characters).").max(500) }).parse(raw),
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
    const { data: updated, error } = await supabaseAdmin
      .from("orders")
      .update({ status: "paid", notes: data.note })
      .eq("id", data.id)
      .in("status", ["pending", "detected", "expired"])
      .select("id");
    if (error) throw new Error(error.message);
    if (!updated?.length) throw new Error("This order cannot be marked paid. Refresh its current status.");
    const { error: eventError } = await supabaseAdmin.from("payment_events").insert({
      order_id: data.id,
      source: "admin",
      event_type: "manual_paid",
      raw: { by: context.userId, note: data.note ?? null },
    });
    const { error: auditError } = await supabaseAdmin.from("audit_logs").insert({
      actor: context.userId,
      event: "order.manual_paid",
      detail: { order_id: data.id, note: data.note ?? null },
    });
    if (eventError || auditError) {
      throw new Error("Order marked paid, but audit tracking failed. Refresh the order and contact support; do not repeat the payment confirmation.");
    }
    try {
      const { sendOrderEmailById } = await import("./order-emails.server");
      await sendOrderEmailById("order_confirmed", data.id);
    } catch {
      /* logged in order_emails */
    }
    return { ok: true };
  });

/** Admin: list active plans (also public via getActivePlansPublic). */
export const getActivePlansPublic = createServerFn({ method: "GET" }).handler(async () => {
  const { readPublicPlanCatalog } = await import("./public-plan-catalog.server");
  return readPublicPlanCatalog();
});

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

async function assertPaymentAdmin(
  supabase: { from: (table: string) => { select: (columns: string) => { eq: (column: string, value: string) => { in: (column: string, values: string[]) => { limit: (count: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> } } } } },
  userId: string,
) {
  const { data, error } = await supabase.from("user_roles").select("role")
    .eq("user_id", userId).in("role", ["admin", "super_admin"]).limit(1);
  if (error || !data?.length) throw new Error("Forbidden");
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
      .eq("coin", "BTC")
      .eq("chain", "bitcoin")
      .order("coin");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/** Super-admin: replace the Bitcoin address for NEW invoices only. */
export const upsertWalletAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { coin: "BTC"; address: string; expected_address: string | null }) =>
    z
      .object({
        coin: z.literal("BTC"),
        address: z.string().trim().max(90).transform(normalizeBitcoinAddress),
        expected_address: z.string().max(120).nullable(),
      })
      .parse(raw),
  )
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.supabase as never, context.userId);
    const chain = "bitcoin";
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing, error: readError } = await supabaseAdmin
      .from("admin_wallets")
      .select("id")
      .eq("coin", data.coin)
      .eq("chain", chain)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (existing) {
      let update = supabaseAdmin
        .from("admin_wallets")
        .update({ cdp_wallet_id: data.address, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      update = data.expected_address === null
        ? update.is("cdp_wallet_id", null)
        : update.eq("cdp_wallet_id", data.expected_address);
      const { data: saved, error } = await update.select("id");
      if (error) throw new Error(error.message);
      if (!saved?.length) throw new Error("Another administrator changed the wallet. Reload it before saving.");
    } else {
      if (data.expected_address !== null) throw new Error("The wallet changed. Reload it before saving.");
      const { error } = await supabaseAdmin
        .from("admin_wallets")
        .insert({ coin: data.coin, chain, cdp_wallet_id: data.address });
      if (error) throw new Error(error.message);
    }
    const { error: auditError } = await supabaseAdmin.from("audit_logs").insert({
      actor: context.userId,
      event: "wallet.upserted",
      detail: { coin: data.coin, chain },
    });
    return { ok: true, ...(auditError ? { warning: "Wallet saved, but audit tracking failed. Contact support; do not repeat the change." } : {}) };
  });

/** Admin: BTC configuration, not a claim of a running scheduler or payment receipt. */
export const getPaymentsHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PaymentsHealth> => {
    await assertPaymentAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: wallet, error } = await supabaseAdmin
      .from("admin_wallets")
      .select("cdp_wallet_id")
      .eq("coin", "BTC").eq("chain", "bitcoin").maybeSingle();
    if (error) throw new Error("Could not read Bitcoin wallet configuration.");
    const { data: cron, error: cronError } = await supabaseAdmin.from("cron_tokens")
      .select("name").eq("name", "reconcile-orders").maybeSingle();
    if (cronError) throw new Error("Could not read payment-monitor authorization.");
    const ready = !!wallet?.cdp_wallet_id && isBitcoinAddress(wallet.cdp_wallet_id);
    return {
      wallets: { BTC: ready },
      wallet_issue: ready ? null : wallet?.cdp_wallet_id ? "Saved address is not a valid Bitcoin mainnet address." : "No Bitcoin receiving address has been saved.",
      network: "bitcoin-mainnet",
      confirmations_required: BITCOIN_CONFIRMATIONS,
      cron_secret_configured: !!cron,
      monitoring_note: "Configuration only. Scheduled reconciliation and a real on-chain payment must be verified on the deployed host. No Coinbase account or API key is required for BTC.",
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
