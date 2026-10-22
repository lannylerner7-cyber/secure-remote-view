import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchInboundTxs, type CoinKey } from "@/lib/cdp.server";
import { exactPaymentAmount, orderReference } from "@/shared/payment-identity";

/**
 * Cron endpoint — invoked every 60s by pg_cron.
 *
 * Auth: pg_cron sends `x-cron-secret`, whose value lives in
 * `public.cron_tokens` (service-role only, no RLS policies, never exposed to
 * anon/authenticated). The secret therefore never leaves the database and is
 * never checked into env or code. The legacy anon-key path is gone: the
 * published anon key is not a credential and let anyone trigger reconciliation.
 *
 * For every pending / detected order that has a receive_address, look up
 * on-chain history and update status when we see the matching amount.
 *
 * Also expires orders whose price lock is older than 15 min AND that have
 * received no on-chain activity.
 */
export const Route = createFileRoute("/api/public/cron/reconcile-orders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const presented =
          request.headers.get("x-cron-secret") ??
          request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ??
          "";
        if (!presented) return new Response("Unauthorized", { status: 401 });

        const { data: tokenRow } = await supabaseAdmin
          .from("cron_tokens")
          .select("token")
          .eq("name", "reconcile-orders")
          .maybeSingle();
        const expected = tokenRow?.token ?? "";
        if (
          !expected ||
          presented.length !== expected.length ||
          !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
        ) {
          return new Response("Unauthorized", { status: 401 });
        }


        const CONF: Record<CoinKey, number> = { BTC: 2, USDT_ERC20: 12, USDC_ERC20: 12 };

        const { data: orders, error } = await supabaseAdmin
          .from("orders")
          .select(
            "id, coin, amount_coin, receive_address, status, price_expires_at, tx_hash, confirmations",
          )
          .in("status", ["pending", "detected"])
          .not("receive_address", "is", null)
          .limit(200);
        if (error) return new Response(error.message, { status: 500 });

        let processed = 0;
        for (const o of orders ?? []) {
          const coin = o.coin as CoinKey;
          const txs = await fetchInboundTxs(coin, o.receive_address!);
          const match = txs.find(
            (t) =>
              exactPaymentAmount(t.amountCoin, o.amount_coin, coin),
          );

          if (!match) {
            if (
              o.status === "pending" &&
              new Date(o.price_expires_at).getTime() < Date.now() - 60_000
            ) {
              await supabaseAdmin.from("orders").update({ status: "expired" }).eq("id", o.id);
            }
            continue;
          }

          const target = CONF[coin];
          const nextStatus = match.confirmations >= target ? "paid" : "detected";
          const { data: updated, error: updateError } = await supabaseAdmin
            .from("orders")
            .update({
              status: nextStatus,
              tx_hash: match.txHash,
              confirmations: match.confirmations,
            })
            .eq("id", o.id)
            .in("status", ["pending", "detected"])
            .select("id");
          if (updateError) return Response.json({ ok: false, reason: "order_update_failed" }, { status: 503 });
          if (!updated?.length) continue;

          await supabaseAdmin.from("payment_events").upsert(
            {
              order_id: o.id,
              source: "poller",
              event_type: nextStatus,
              tx_hash: match.txHash,
              confirmations: match.confirmations,
              raw: { amount_coin: match.amountCoin, order_reference: orderReference(o.id) },
            },
            { onConflict: "order_id,tx_hash,event_type", ignoreDuplicates: true },
          );

          processed += 1;
          if (nextStatus === "paid") {
            const { sendOrderEmailById } = await import("@/lib/order-emails.server");
            await sendOrderEmailById("order_confirmed", o.id);
          }
        }

        return Response.json({ ok: true, checked: orders?.length ?? 0, processed });
      },
    },
  },
});
