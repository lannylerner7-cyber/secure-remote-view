import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw } from "lucide-react";
import { orderReference } from "@/shared/payment-identity";
import { getOrderTotals, listOrdersAdmin, markOrderPaid, setOrderAccessLink } from "@/lib/orders.functions";
import { AccessLinkCell } from "./AccessLinkCell";
import { MarkPaidDialog } from "./MarkPaidDialog";
import {
  MANUAL_PAYABLE, Notice, Skeleton, StatusPill, btnSecondary, errMsg, panel, usd, when,
  type OrderRow, type Totals,
} from "./shared";

const STATUSES = ["", "pending", "detected", "paid", "expired", "refunded", "cancelled"] as const;

export function OrdersTab({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const loadOrders = useServerFn(listOrdersAdmin);
  const loadTotals = useServerFn(getOrderTotals);
  const setLink = useServerFn(setOrderAccessLink);
  const markPaid = useServerFn(markOrderPaid);

  const [filter, setFilter] = useState<(typeof STATUSES)[number]>("");
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [ordersErr, setOrdersErr] = useState<string | null>(null);
  const [totalsErr, setTotalsErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [marking, setMarking] = useState<OrderRow | null>(null);
  const [markBusy, setMarkBusy] = useState(false);
  const [markErr, setMarkErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const fns = useRef({ loadOrders, loadTotals });
  fns.current = { loadOrders, loadTotals };
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const reload = useCallback(async () => {
    setRefreshing(true);
    const f = filterRef.current;
    await Promise.all([
      fns.current
        .loadOrders({ data: { status: f || undefined, limit: 200 } })
        .then((r) => { if (filterRef.current === f) { setOrders(r as OrderRow[]); setOrdersErr(null); } })
        .catch((e) => setOrdersErr(errMsg(e, "Orders could not be loaded"))),
      fns.current
        .loadTotals()
        .then((t) => { setTotals(t as Totals); setTotalsErr(null); })
        .catch((e) => setTotalsErr(errMsg(e, "Totals could not be loaded"))),
    ]);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    setOrders(null);
    reload();
  }, [filter, reload]);

  useEffect(() => {
    const t = setInterval(reload, 60_000);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [reload]);

  const confirmMark = async (note: string) => {
    if (!marking) return;
    setMarkBusy(true);
    setMarkErr(null);
    try {
      await markPaid({ data: { id: marking.id, note } });
      setFlash(`${orderReference(marking.id)} marked paid.`);
      setMarking(null);
      await reload();
    } catch (e) {
      setMarkErr(errMsg(e, "Could not mark paid"));
    } finally {
      setMarkBusy(false);
    }
  };

  const coins = totals ? Object.entries(totals.by_coin) : [];

  return (
    <div className="min-w-0 max-w-full space-y-5">
      <section aria-label="Order totals">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[#44403c]">Invoice totals</h2>
          <span className="text-[11px] text-[#6b645d]">Sum of order amounts, not wallet balances</span>
        </div>
        {totalsErr && !totals ? (
          <Notice tone="error" testId="error-totals" action={<button className={btnSecondary} onClick={reload}>Retry</button>}>
            {totalsErr}
          </Notice>
        ) : (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#e2dfdb] bg-[#e2dfdb] md:grid-cols-4">
            <Stat label="Paid orders total" value={totals && usd(totals.total_deposited_usd)} sub={totals && `${totals.count_paid} orders`} testId="text-total-paid" />
            <Stat label="Awaiting payment" value={totals && usd(totals.total_pending_usd)} sub={totals && `${totals.count_pending} orders`} testId="text-total-pending" />
            <Stat label="Failed / expired" value={totals && usd(totals.total_failed_usd)} sub={totals && `${totals.count_failed} orders`} testId="text-total-failed" />
            <Stat label="Paid order count" value={totals && String(totals.count_paid)} testId="text-count-paid" />
          </div>
        )}
        {totalsErr && totals && <p className="mt-1 text-[11px] text-[#7a1d14]" role="alert" data-testid="error-totals-stale">Showing last loaded totals. {totalsErr}</p>}
        {coins.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]" data-testid="list-totals-by-coin">
            {coins.map(([coin, v]) => (
              <span key={coin} className="min-w-0 max-w-full break-words rounded border border-[#e2dfdb] bg-[#fdfcfb] px-2 py-1 font-mono text-[#44403c] [overflow-wrap:anywhere]">
                {coin}{coin !== "BTC" && <span className="ml-1 font-sans text-[#8a837c]">(history)</span>}: {v.paid} paid · {v.pending} pending
              </span>
            ))}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-1.5">
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
          {STATUSES.map((s) => (
            <button
              key={s || "all"}
              onClick={() => setFilter(s)}
              aria-pressed={filter === s}
              data-testid={`filter-status-${s || "all"}`}
              className={`rounded-md border px-2.5 py-1 text-xs capitalize transition-colors ${
                filter === s ? "border-[#1c1917] bg-[#1c1917] text-[#fafaf9]" : "border-[#e2dfdb] bg-[#fdfcfb] text-[#44403c] hover:bg-[#f0eeeb]"
              }`}
            >
              {s || "all"}
            </button>
          ))}
        </div>
        <button onClick={reload} disabled={refreshing} className={`${btnSecondary} ml-auto`} data-testid="button-refresh-orders">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
      </div>

      {flash && <Notice tone="ok" testId="status-orders-flash" action={<button className="text-xs underline" onClick={() => setFlash(null)}>Dismiss</button>}>{flash}</Notice>}
      {ordersErr && (
        <Notice tone="error" testId="error-orders" action={<button className={btnSecondary} onClick={reload} data-testid="button-retry-orders">Retry</button>}>
          {orders ? `Showing last loaded orders. ${ordersErr}` : ordersErr}
        </Notice>
      )}

      <div className={`${panel} w-full min-w-0 max-w-full overflow-x-auto`} style={{ contain: "layout paint" }} data-testid="orders-table-scroll" role="region" aria-label="Orders table, scroll horizontally for more columns" tabIndex={0}>
        <table className="w-full min-w-[920px] text-left text-xs">
          <thead className="border-b border-[#e2dfdb] bg-[#f5f4f2] text-[10px] uppercase tracking-wider text-[#57534e]">
            <tr>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Buyer / reference</th>
              <th className="px-3 py-2 font-medium">Plan</th>
              <th className="px-3 py-2 font-medium">Asset</th>
              <th className="px-3 py-2 text-right font-medium">USD</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Access link</th>
              <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#efece8]">
            {orders === null && !ordersErr &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}><td colSpan={9} className="px-3 py-3"><Skeleton className="h-5 w-full" /></td></tr>
              ))}
            {orders?.map((o) => (
              <tr key={o.id} className="align-top hover:bg-[#f8f7f5]" data-testid={`row-order-${o.id}`}>
                <td className="whitespace-nowrap px-3 py-2.5 text-[#57534e]">{when(o.created_at)}</td>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-[#1c1917]">{o.full_name}</div>
                  <div className="text-[11px] text-[#57534e]">{o.email}</div>
                  <div className="mt-0.5 max-w-64 break-all font-mono text-[10px] text-[#6b645d]">{orderReference(o.id)}</div>
                </td>
                <td className="px-3 py-2.5 text-[#292524]">{o.plan_code}</td>
                <td className="px-3 py-2.5">
                  <span className="font-mono text-[11px] text-[#292524]">{o.coin}</span>
                  {o.coin !== "BTC" && <div className="text-[10px] text-[#8a837c]">legacy history</div>}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#1c1917]">{usd(o.amount_usd)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[#292524]">{o.amount_coin}</td>
                <td className="px-3 py-2.5">
                  <StatusPill s={o.status} />
                  {o.confirmations > 0 && <div className="mt-0.5 text-[10px] text-[#6b645d]">{o.confirmations} conf</div>}
                  {o.tx_hash && <div className="mt-0.5 max-w-[120px] truncate font-mono text-[10px] text-[#6b645d]" title={o.tx_hash}>{o.tx_hash}</div>}
                </td>
                <td className="px-3 py-2.5">
                  <AccessLinkCell order={o} save={(id, link) => setLink({ data: { id, access_link: link } })} reload={reload} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  {isSuperAdmin && MANUAL_PAYABLE.includes(o.status) && (
                    <button className={btnSecondary} onClick={() => { setMarkErr(null); setMarking(o); }} data-testid={`button-mark-paid-${o.id}`}>
                      Mark paid
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {orders?.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-12 text-center" data-testid="empty-orders">
                  <div className="text-sm font-medium text-[#292524]">No {filter ? `${filter} ` : ""}orders</div>
                  <div className="mt-1 text-xs text-[#6b645d]">New invoices appear here as buyers check out.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {marking && <MarkPaidDialog order={marking} busy={markBusy} error={markErr} onCancel={() => setMarking(null)} onConfirm={confirmMark} />}
    </div>
  );
}

function Stat({ label, value, sub, testId }: { label: string; value: string | null; sub?: string | null; testId: string }) {
  return (
    <div className="min-w-0 bg-[#fdfcfb] px-4 py-3 [overflow-wrap:anywhere]">
      <div className="text-[10px] uppercase tracking-wider text-[#6b645d]">{label}</div>
      {value === null ? <Skeleton className="mt-1.5 h-6 w-24" /> : <div className="mt-1 font-mono text-lg tabular-nums text-[#1c1917]" data-testid={testId}>{value}</div>}
      {sub && <div className="text-[11px] text-[#6b645d]">{sub}</div>}
    </div>
  );
}
