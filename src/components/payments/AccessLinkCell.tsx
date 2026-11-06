import { useState } from "react";
import { btnPrimary, btnSecondary, errMsg, input, type OrderRow } from "./shared";

export function AccessLinkCell({
  order,
  save,
  reload,
}: {
  order: OrderRow;
  save: (id: string, link: string) => Promise<unknown>;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const paid = order.status === "paid";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await save(order.id, draft.trim());
      setEditing(false);
      setDraft("");
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      await reload();
    } catch (e) {
      // The link may have persisted before delivery failed; show the real server value.
      setError(errMsg(e, "Could not save access link"));
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  if (editing)
    return (
      <form className="flex min-w-[220px] flex-col gap-1" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input
          autoFocus
          type="url"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://..."
          aria-label="Access link"
          aria-invalid={!!error}
          className={`${input} text-xs`}
          data-testid={`input-access-link-${order.id}`}
        />
        <div className="flex gap-1">
          <button type="submit" className={btnPrimary} disabled={busy || !draft.trim()} data-testid={`button-save-access-link-${order.id}`}>
            {busy ? "Saving..." : "Save & deliver"}
          </button>
          <button type="button" className={btnSecondary} disabled={busy} onClick={() => { setEditing(false); setError(null); }} data-testid={`button-cancel-access-link-${order.id}`}>
            Cancel
          </button>
        </div>
        {error && <p role="alert" className="text-[11px] text-[#7a1d14]" data-testid={`error-access-link-${order.id}`}>{error}</p>}
      </form>
    );

  return (
    <div className="flex flex-col gap-1">
      {order.access_link ? (
        <div className="flex items-center gap-1.5">
          <a href={order.access_link} target="_blank" rel="noopener noreferrer" className="max-w-[170px] truncate text-[11px] text-[#1c1917] underline decoration-[#a8a29e] underline-offset-2 hover:decoration-[#1c1917]" data-testid={`link-access-${order.id}`}>
            {order.access_link}
          </a>
          {paid && (
            <button className={`${btnSecondary} px-2 py-0.5`} onClick={() => { setEditing(true); setDraft(order.access_link ?? ""); }} data-testid={`button-edit-access-link-${order.id}`}>
              Edit
            </button>
          )}
        </div>
      ) : paid ? (
        <button className={`${btnSecondary} self-start`} onClick={() => { setEditing(true); setDraft(""); }} data-testid={`button-set-access-link-${order.id}`}>
          Set link
        </button>
      ) : (
        <span className="text-[11px] text-[#8a837c]">Available once paid</span>
      )}
      {savedFlash && <span role="status" className="text-[11px] text-[#1d4a2c]" data-testid={`status-access-link-saved-${order.id}`}>Saved and delivered</span>}
      {error && <p role="alert" className="text-[11px] text-[#7a1d14]" data-testid={`error-access-link-${order.id}`}>{error}</p>}
    </div>
  );
}
