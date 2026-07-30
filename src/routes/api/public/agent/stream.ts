import { createFileRoute } from "@tanstack/react-router";
import { verifyDevice } from "@/lib/agent-auth.server";

// -----------------------------------------------------------------------------
// Server-Sent Events channel: sub-second wake dispatch to the Watcher.
//
// The Watcher opens ONE long-lived GET against this route (device-token gated).
// The server polls power_commands for queued `wake_agent` rows targeted at
// this device every 1s and pushes them as `data:` frames. A keepalive comment
// every 15s prevents idle connection drops.
//
// The Watcher still runs its REST heartbeat (relaxed to 60s when SSE is
// healthy), so a stream failure never blocks command delivery — SSE is a
// latency accelerator, not the source of truth.
// -----------------------------------------------------------------------------
export const Route = createFileRoute("/api/public/agent/stream")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ctx = await verifyDevice(request);
        if (!ctx) return new Response("unauthorized", { status: 401 });

        const deviceRowId = ctx.device.id;
        const admin = ctx.admin;
        const seen = new Set<string>();

        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(
                  enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                );
              } catch { /* controller closed */ }
            };
            send("ready", { ok: true, at: new Date().toISOString() });

            const abort = request.signal;
            let closed = false;
            const close = () => {
              if (closed) return;
              closed = true;
              try { controller.close(); } catch { /* already closed */ }
            };
            abort.addEventListener("abort", close);

            let ticks = 0;
            while (!closed && !abort.aborted) {
              try {
                const { data } = await admin
                  .from("power_commands")
                  .select("id, kind, payload, created_at")
                  .eq("device_id", deviceRowId)
                  .eq("kind", "wake_agent")
                  .eq("state", "queued")
                  .gt("expires_at", new Date().toISOString())
                  .order("created_at", { ascending: true })
                  .limit(5);
                for (const cmd of data ?? []) {
                  if (seen.has(cmd.id)) continue;
                  seen.add(cmd.id);
                  send("wake", cmd);
                }
              } catch (e) {
                send("error", { message: e instanceof Error ? e.message : "poll_failed" });
              }
              // Keepalive comment every 15 ticks (~15s) so proxies don't reap us.
              if (++ticks % 15 === 0) {
                try { controller.enqueue(enc.encode(`: keepalive ${Date.now()}\n\n`)); }
                catch { close(); break; }
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
            close();
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "connection": "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
