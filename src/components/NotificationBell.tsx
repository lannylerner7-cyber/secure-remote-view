import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { NotificationRow } from "@/lib/notifications.functions";

// Broadcast notifications (recipient_id=null) can't be UPDATEd by non-super-admins
// under RLS, so we track "seen" state client-side for those rows.
const BROADCAST_SEEN_KEY = "cl:broadcast-seen-v1";
function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(BROADCAST_SEEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveSeen(s: Set<string>) {
  try {
    localStorage.setItem(BROADCAST_SEEN_KEY, JSON.stringify([...s].slice(-500)));
  } catch {
    /* ignore quota */
  }
}

const severityRing: Record<NotificationRow["severity"], string> = {
  info: "border-l-[#4F7CFF]",
  success: "border-l-emerald-400",
  warning: "border-l-amber-400",
  critical: "border-l-red-500",
};

export function NotificationBell({ userId }: { userId: string | null }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [seen, setSeen] = useState<Set<string>>(() => loadSeen());

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(30);
      if (!cancelled && data) setRows(data as NotificationRow[]);
    }
    void load();

    // Ask for OS-level notification permission once.
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    const ch = supabase
      .channel("notifications-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications" },
        (payload) => {
          const row = payload.new as NotificationRow;
          setRows((prev) => [row, ...prev].slice(0, 30));
          if (
            "Notification" in window &&
            Notification.permission === "granted" &&
            document.visibilityState !== "visible"
          ) {
            try {
              new Notification(row.title, { body: row.body });
            } catch {
              /* ignore */
            }
          }
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [userId]);

  const unread = useMemo(
    () =>
      rows.filter((r) => {
        if (r.recipient_id === null) return !seen.has(r.id);
        return r.read_at === null;
      }).length,
    [rows, seen],
  );

  async function markAll() {
    const directUnread = rows.filter((r) => r.recipient_id === userId && !r.read_at);
    if (directUnread.length) {
      const nowIso = new Date().toISOString();
      await supabase
        .from("notifications")
        .update({ read_at: nowIso })
        .in("id", directUnread.map((r) => r.id));
      setRows((prev) =>
        prev.map((r) => (directUnread.find((d) => d.id === r.id) ? { ...r, read_at: nowIso } : r)),
      );
    }
    const broadcastIds = rows.filter((r) => r.recipient_id === null).map((r) => r.id);
    if (broadcastIds.length) {
      const next = new Set(seen);
      broadcastIds.forEach((id) => next.add(id));
      setSeen(next);
      saveSeen(next);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void markAll();
        }}
        aria-label="Notifications"
        className="relative rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-white/80 hover:bg-white/10"
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-white/10 bg-[#0F172A] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs uppercase tracking-widest text-white/50">
              <span>Notifications</span>
              <span>{rows.length}</span>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {rows.length === 0 ? (
                <div className="p-4 text-sm text-white/50">You’re all caught up.</div>
              ) : (
                rows.map((r) => (
                  <div
                    key={r.id}
                    className={`border-b border-white/5 border-l-4 px-4 py-3 last:border-b-0 ${severityRing[r.severity]}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-medium text-white">{r.title}</div>
                      <div className="whitespace-nowrap text-[10px] text-white/40">
                        {new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                    {r.body && <div className="mt-1 whitespace-pre-wrap text-xs text-white/70">{r.body}</div>}
                    {r.recipient_id === null && (
                      <div className="mt-1 inline-block rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase text-white/40">
                        Broadcast
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
