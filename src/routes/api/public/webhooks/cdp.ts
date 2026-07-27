import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * CDP webhook — HMAC-verified. Idempotent via payment_events unique index.
 * Payload shape is flexible: we accept `{ order_id, tx_hash, confirmations, status }`
 * from a Coinbase CDP wallet notification or a proxying edge function.
 */
export const Route = createFileRoute("/api/public/webhooks/cdp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.CDP_WEBHOOK_SECRET;
        if (!secret) return new Response("Webhook not configured", { status: 503 });

        const sig = request.headers.get("x-cdp-signature") ?? "";
        const body = await request.text();
        const expected = createHmac("sha256", secret).update(body).digest("hex");
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return new Response("Invalid signature", { status: 401 });
        }

        let payload: {
          order_id?: string;
          tx_hash?: string;
          confirmations?: number;
          status?: "detected" | "paid";
          address?: string;
          amount_coin?: number;
        };
        try {
          payload = JSON.parse(body);
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }

        // If order_id not provided, resolve by receive_address.
        let orderId = payload.order_id;
        if (!orderId && payload.address) {
          const { data } = await supabaseAdmin
            .from("orders")
            .select("id")
            .eq("receive_address", payload.address)
            .in("status", ["pending", "detected"])
            .maybeSingle();
          orderId = data?.id;
        }
        if (!orderId) return Response.json({ ok: true, skipped: "no matching order" });

        const nextStatus = payload.status ?? "detected";
        await supabaseAdmin
          .from("orders")
          .update({
            status: nextStatus,
            tx_hash: payload.tx_hash ?? null,
            confirmations: payload.confirmations ?? 0,
          })
          .eq("id", orderId);
        await supabaseAdmin
          .from("payment_events")
          .upsert(
            {
              order_id: orderId,
              source: "cdp_webhook",
              event_type: nextStatus,
              tx_hash: payload.tx_hash ?? null,
              confirmations: payload.confirmations ?? null,
              raw: payload,
            },
            { onConflict: "order_id,tx_hash,event_type", ignoreDuplicates: true },
          );

        return Response.json({ ok: true });
      },
    },
  },
});
