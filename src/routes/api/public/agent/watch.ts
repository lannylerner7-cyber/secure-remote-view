import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { deviceAuthFailure, verifyDevice } from "@/lib/agent-auth.server";

const reportSchema = z.object({
  instance: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  authorization_id: z.string().uuid(),
  agent_instance: z.string().uuid().nullable(),
  startup_enabled: z.boolean(),
  state: z.enum(["running", "stopped", "starting", "failed", "disabled", "uninstalling"]),
  detail_code: z.string().regex(/^[a-z_]{1,64}$/).nullable().optional(),
  command_id: z.string().uuid().nullable().optional(),
  command_state: z.enum(["starting", "healthy", "already_running", "failed", "rejected"]).nullable().optional(),
}).strict();

export const Route = createFileRoute("/api/public/agent/watch")({
  server: { handlers: { POST: async ({ request }) => {
    const ctx = await verifyDevice(request);
    if (ctx.kind !== "verified") return deviceAuthFailure(ctx);
    const raw = await request.text();
    if (raw.length > 4096) return new Response("report_too_large", { status: 413 });
    const parsed = reportSchema.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
    if (!parsed.success) return new Response("invalid_watch_report", { status: 400 });
    const { data, error } = await ctx.admin.rpc("report_agent_watch", {
      _device: ctx.device.id, _report: parsed.data,
    });
    if (error) return new Response("watch_reporting_unavailable", { status: 503 });
    return Response.json(data, { headers: { "cache-control": "no-store" } });
  } } },
});
