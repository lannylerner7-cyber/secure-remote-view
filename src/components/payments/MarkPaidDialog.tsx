import { useState } from "react";
import { orderReference } from "@/shared/payment-identity";
import { btnDanger, btnSecondary, input, usd, type OrderRow } from "./shared";

export function MarkPaidDialog({
  order,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  order: OrderRow;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const ref = orderReference(order.id);
  const valid = note.trim().length >= 10 && ack;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#1c1917]/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="mark-paid-title">
      <div className="w-full max-w-md rounded-lg border border-[#d6d3d1] bg-[#fdfcfb] p-5 shadow-[0_20px_50px_-20px_rgba(28,25,23,0.45)]">
        <h2 id="mark-paid-title" className="text-sm font-semibold text-[#1c1917]">Mark order paid manually</h2>
        <p className="mt-1 text-xs leading-relaxed text-[#57534e]">
          Use only after verifying funds outside the monitor. This is audit-logged and cannot be undone from this screen.
        </p>
        <div className="mt-3 rounded-md border border-[#e2dfdb] bg-[#f5f4f2] p-3 text-xs">
          <div className="font-medium text-[#1c1917]">{order.full_name}</div>
          <div className="font-mono text-[11px] text-[#44403c]">{ref}</div>
          <div className="mt-1 text-[#57534e]">{usd(order.amount_usd)} · {order.amount_coin} {order.coin} · {order.status}</div>
        </div>
        <label className="mt-3 block text-xs font-medium text-[#292524]" htmlFor="mark-paid-note">Reason (min. 10 characters)</label>
        <textarea
          id="mark-paid-note"
          data-testid="input-mark-paid-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className={`${input} mt-1 text-xs`}
          placeholder="e.g. Verified tx 4f2a... with 3 confirmations in block explorer"
        />
        <label className="mt-3 flex items-start gap-2 text-xs text-[#292524]">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="checkbox-mark-paid-confirm" className="mt-0.5 accent-[#1c1917]" />
          I verified payment for this exact order and amount.
        </label>
        {error && <p role="alert" data-testid="error-mark-paid" className="mt-3 text-xs text-[#7a1d14]">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className={btnSecondary} onClick={onCancel} disabled={busy} data-testid="button-cancel-mark-paid">Cancel</button>
          <button className={btnDanger} disabled={!valid || busy} onClick={() => onConfirm(note.trim())} data-testid="button-confirm-mark-paid">
            {busy ? "Marking..." : "Mark paid"}
          </button>
        </div>
      </div>
    </div>
  );
}
