import { adminClient } from "@/lib/server-supabase";

type Listener = (event: "ready" | "fallback" | "wake") => void;
type Component = "agent" | "watch";
const listeners = new Map<string, Set<Listener>>();
let subscription: ReturnType<ReturnType<typeof adminClient>["channel"]> | undefined;
let healthy = false;
let shutdown: ReturnType<typeof setTimeout> | undefined;
let client: ReturnType<typeof adminClient> | undefined;

/** One service-side realtime socket per process, not a DB poll per endpoint.
 * Only notification hints cross SSE. Device credentials + current grants still
 * gate the subsequent heartbeat/command claim. Durable rows survive restarts.
 */
export function listenForAgentEvents(device: string, component: Component, listener: Listener) {
  if (shutdown) { clearTimeout(shutdown); shutdown = undefined; }
  const key = `${component}:${device}`;
  const group = listeners.get(key) ?? new Set<Listener>();
  group.add(listener);
  listeners.set(key, group);
  if (!subscription) {
    client = adminClient();
    const wake = (part: Component, row: Record<string, unknown>) => {
      if (typeof row.device_id !== "string") return;
      for (const callback of listeners.get(`${part}:${row.device_id}`) ?? []) callback("wake");
    };
    subscription = client.channel("connectlive-agent-lifecycle")
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" },
        payload => wake("agent", payload.new as Record<string, unknown>))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "power_commands" },
        payload => { if (payload.new.kind === "wake_agent") wake("agent", payload.new); })
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_lifecycle_commands" },
        payload => { if (payload.new && (payload.new as Record<string, unknown>).state === "queued") wake("watch", payload.new as Record<string, unknown>); })
      .subscribe(status => {
        healthy = status === "SUBSCRIBED";
        for (const callbacks of listeners.values())
          for (const callback of callbacks) callback(healthy ? "ready" : "fallback");
      });
  }
  listener(healthy ? "ready" : "fallback");
  // Reconcile after connection establishment: notifications can be missed while
  // a connection is down. This does not fabricate an application acknowledgement.
  listener("wake");
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(key);
    if (!listeners.size && !shutdown) shutdown = setTimeout(() => {
      if (!listeners.size && subscription && client) {
        const old = subscription;
        subscription = undefined;
        healthy = false;
        void client.removeChannel(old);
      }
      shutdown = undefined;
    }, 30_000);
  };
}
