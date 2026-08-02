import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchInboundTxs, type CoinKey } from "@/lib/cdp.server";

/**
 * Cron endpoint — invoked every 60s by pg_cron with `apikey` = anon key.
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
        const apiKey =
          request.headers.get("apikey") ??
          request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
        const expected =
          process.env.SUPABASE_PUBLISHABLE_KEY ??
          process.env.SUPABASE_ANON_KEY ??
          process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        if (!expected || apiKey !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const CONF: Record<CoinKey, number> = { BTC: 2, USDT_ERC20: 12, USDC_ERC20: 12 };
        const AMOUNT_EPSILON = 1e-6;

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
              Math.abs(t.amountCoin - Number(o.amount_coin)) <=
              AMOUNT_EPSILON * Number(o.amount_coin) + AMOUNT_EPSILON,
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
          await supabaseAdmin
            .from("orders")
            .update({
              status: nextStatus,
              tx_hash: match.txHash,
              confirmations: match.confirmations,
            })
            .eq("id", o.id);

          await supabaseAdmin.from("payment_events").upsert(
            {
              order_id: o.id,
              source: "poller",
              event_type: nextStatus,
              tx_hash: match.txHash,
              confirmations: match.confirmations,
              raw: { amount_coin: match.amountCoin },
            },
            { onConflict: "order_id,tx_hash,event_type", ignoreDuplicates: true },
          );

          processed += 1;
        }

        return Response.json({ ok: true, checked: orders?.length ?? 0, processed });
      },
    },
  },
});
