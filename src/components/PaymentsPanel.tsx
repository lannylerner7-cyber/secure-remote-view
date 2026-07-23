import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listOrdersAdmin, getOrderTotals, setOrderAccessLink, markOrderPaid } from "@/lib/orders.functions";

type OrderRow = {
  id: string;
  email: string;
  full_name: string;
  plan_code: string;
  amount_usd: number;
  coin: string;
  amount_coin: number;
  status: string;
  tx_hash: string | null;
  confirmations: number;
  access_link: string | null;
  created_at: string;
};

type Totals = {
  total_deposited_usd: number;
  total_pending_usd: number;
  total_failed_usd: number;
  count_paid: number;
  count_pending: number;
  count_failed: number;
  by_coin: Record<string, { paid: number; pending: number }>;
};

const STATUSES = ["", "pending", "detected", "paid", "expired", "refunded", "cancelled"] as const;

export function PaymentsPanel({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const loadOrders = useServerFn(listOrdersAdmin);
  const loadTotals = useServerFn(getOrderTotals);
  const setLink = useServerFn(setOrderAccessLink);
  const markPaid = useServerFn(markOrderPaid);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [filter, setFilter] = useState<(typeof STATUSES)[number]>("");
  const [editingLink, setEditingLink] = useState<string | null>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      const [os, t] = await Promise.all([
        loadOrders({ data: { status: filter || undefined, limit: 200 } }),
        loadTotals(),
      ]);
      setOrders(os as OrderRow[]);
      setTotals(t as Totals);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    reload();
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const saveLink = async (id: string) => {
    if (!linkDraft) return;
    setBusy(true);
    try {
      await setLink({ data: { id, access_link: linkDraft } });
      setEditingLink(null);
      setLinkDraft("");
      await reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const markManual = async (id: string) => {
    const note = prompt("Reason for manual paid mark (audit-logged):");
    if (note === null) return;
    setBusy(true);
    try {
      await markPaid({ data: { id, note } });
      await reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Totals ticker */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Total deposited" value={`$${totals?.total_deposited_usd.toFixed(2) ?? "0.00"}`} tone="green" />
        <Card label="Pending" value={`$${totals?.total_pending_usd.toFixed(2) ?? "0.00"}`} tone="amber" />
        <Card label="Failed / expired" value={`$${totals?.total_failed_usd.toFixed(2) ?? "0.00"}`} tone="red" />
        <Card label="Paid orders" value={String(totals?.count_paid ?? 0)} tone="blue" />
      </section>

      {totals && Object.keys(totals.by_coin).length > 0 && (
        <section className="rounded-lg border border-white/10 bg-[#1F2A44] p-4 text-xs">
          <div className="mb-2 text-white/60">Balance by coin (paid − refunded)</div>
          <div className="grid gap-2 md:grid-cols-3">
            {Object.entries(totals.by_coin).map(([coin, v]) => (
              <div key={coin} className="rounded bg-white/5 p-3">
                <div className="text-white/50">{coin}</div>
                <div className="font-mono text-lg">{v.paid.toFixed(8)}</div>
                <div className="text-[10px] text-white/40">pending: {v.pending.toFixed(8)}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-white/50">Filter:</span>
        {STATUSES.map((s) => (
          <button
            key={s || "all"}
            onClick={() => setFilter(s)}
            className={`rounded px-2 py-1 ${filter === s ? "bg-[#4F7CFF] text-white" : "bg-white/5 text-white/60 hover:bg-white/10"}`}
          >
            {s || "all"}
          </button>
        ))}
        <button onClick={reload} className="ml-auto rounded bg-white/5 px-2 py-1 text-white/60 hover:bg-white/10">
          Refresh
        </button>
      </div>

      {/* Orders table */}
      <div className="overflow-x-auto rounded-lg border border-white/10 bg-[#1F2A44]">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead className="bg-white/5 text-white/60">
            <tr>
              <th className="p-2">Created</th>
              <th className="p-2">Buyer</th>
              <th className="p-2">Plan</th>
              <th className="p-2">Coin</th>
              <th className="p-2 text-right">USD</th>
              <th className="p-2 text-right">Coin amt</th>
              <th className="p-2">Status</th>
              <th className="p-2">Access link</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-white/5 align-top">
                <td className="p-2 text-white/60">{new Date(o.created_at).toLocaleString()}</td>
                <td className="p-2">
                  <div>{o.full_name}</div>
                  <div className="text-[10px] text-white/40">{o.email}</div>
                </td>
                <td className="p-2">{o.plan_code}</td>
                <td className="p-2 font-mono text-[10px]">{o.coin}</td>
                <td className="p-2 text-right font-mono">${Number(o.amount_usd).toFixed(2)}</td>
                <td className="p-2 text-right font-mono">{o.amount_coin}</td>
                <td className="p-2">
                  <StatusPill s={o.status} />
                  {o.confirmations > 0 && <div className="text-[10px] text-white/40">{o.confirmations} conf</div>}
                </td>
                <td className="p-2">
                  {editingLink === o.id ? (
                    <div className="flex gap-1">
                      <input
                        value={linkDraft}
                        onChange={(e) => setLinkDraft(e.target.value)}
                        placeholder="https://…"
                        className="w-40 rounded bg-black/40 px-1.5 py-1 text-[11px]"
                      />
                      <button disabled={busy} onClick={() => saveLink(o.id)} className="rounded bg-[#4F7CFF] px-2 py-0.5">
                        Save
                      </button>
                      <button onClick={() => setEditingLink(null)} className="rounded bg-white/10 px-2 py-0.5">
                        ×
                      </button>
                    </div>
                  ) : o.access_link ? (
                    <div className="flex items-center gap-1">
                      <a href={o.access_link} target="_blank" rel="noreferrer" className="truncate text-[10px] text-[#4F7CFF] hover:underline" style={{ maxWidth: 160 }}>
                        {o.access_link}
                      </a>
                      <button
                        onClick={() => {
                          setEditingLink(o.id);
                          setLinkDraft(o.access_link ?? "");
                        }}
                        className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] hover:bg-white/10"
                      >
                        edit
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setEditingLink(o.id);
                        setLinkDraft("");
                      }}
                      className="rounded bg-white/5 px-2 py-1 text-[10px] hover:bg-white/10"
                    >
                      + set link
                    </button>
                  )}
                </td>
                <td className="p-2">
                  {isSuperAdmin && o.status !== "paid" && (
                    <button
                      disabled={busy}
                      onClick={() => markManual(o.id)}
                      className="rounded bg-white/5 px-2 py-1 text-[10px] hover:bg-white/10"
                    >
                      Mark paid
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={9} className="p-8 text-center text-white/40">
                  No orders yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone: "green" | "amber" | "red" | "blue" }) {
  const tones = {
    green: "border-green-500/30 bg-green-500/5",
    amber: "border-amber-500/30 bg-amber-500/5",
    red: "border-red-500/30 bg-red-500/5",
    blue: "border-[#4F7CFF]/30 bg-[#4F7CFF]/5",
  } as const;
  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`}>
      <div className="text-[10px] uppercase tracking-wider text-white/50">{label}</div>
      <div className="mt-1 font-mono text-xl text-white">{value}</div>
    </div>
  );
}

function StatusPill({ s }: { s: string }) {
  const map: Record<string, string> = {
    pending: "bg-white/10 text-white/70",
    detected: "bg-amber-500/20 text-amber-200",
    paid: "bg-green-500/20 text-green-200",
    expired: "bg-red-500/20 text-red-200",
    refunded: "bg-purple-500/20 text-purple-200",
    cancelled: "bg-white/5 text-white/40",
  };
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] uppercase ${map[s] ?? "bg-white/10"}`}>{s}</span>;
}
