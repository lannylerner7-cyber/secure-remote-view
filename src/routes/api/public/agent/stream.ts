import { createFileRoute } from "@tanstack/react-router";
import { deviceAuthFailure, verifyDevice } from "@/lib/agent-auth.server";
import { listenForAgentEvents } from "@/lib/agent-events.server";

// -----------------------------------------------------------------------------
// Authenticated SSE hints; sessions/commands remain the durable source of truth.
//
// The Agent opens ONE long-lived GET against this route (device-token gated).
// A shared service-side realtime subscription replaces per-device 1s DB polls.
// "fallback" explicitly tells clients not to relax their reconciliation cadence.
//
// The Agent still runs its REST heartbeat (relaxed to 60s when SSE is
// healthy), so a stream failure never blocks command delivery — SSE is a
// latency accelerator, not the source of truth.
// -----------------------------------------------------------------------------
export const Route = createFileRoute("/api/public/agent/stream")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (ctx.kind !== "verified") return deviceAuthFailure(ctx);

        const component = new URL(request.url).searchParams.get("component") === "watch" ? "watch" : "agent";
        let cleanup = () => {};
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            let closed = false;
            let unsubscribe = () => {};
            let timer: ReturnType<typeof setInterval> | undefined;
            let expiry: ReturnType<typeof setTimeout> | undefined;
            const close = () => {
              if (closed) return;
              closed = true;
              if (timer) clearInterval(timer);
              if (expiry) clearTimeout(expiry);
              unsubscribe();
              request.signal.removeEventListener("abort", close);
              try { controller.close(); } catch { /* Already cancelled. */ }
            };
            cleanup = close;
            const send = (event: string, data: unknown) => {
              if (closed) return;
              // Never accumulate unbounded hints behind a stalled receiver.
              if ((controller.desiredSize ?? 1) < -4) { close(); return; }
              try {
                controller.enqueue(
                  enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                );
              } catch {
                close();
              }
            };
            unsubscribe = listenForAgentEvents(ctx.device.id, component,
              event => send(event, { ok: event !== "fallback" }));
            timer = setInterval(() => send("keepalive", { at: Date.now() }), 15_000);
            // Periodic reconnect rechecks credentials and releases abandoned
            // sockets. Individual commands still perform a fresh grant check.
            expiry = setTimeout(close, 5 * 60_000);
            request.signal.addEventListener("abort", close, { once: true });
            if (request.signal.aborted) close();
          },
          cancel() { cleanup(); },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
