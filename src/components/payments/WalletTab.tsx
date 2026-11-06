import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw } from "lucide-react";
import { listWalletsAdmin, upsertWalletAdmin } from "@/lib/orders.functions";
import { isBitcoinAddress, normalizeBitcoinAddress } from "@/shared/bitcoin";
import { BitcoinQr } from "./BitcoinQr";
import { Notice, Skeleton, btnPrimary, btnSecondary, errMsg, input, panel, when, type WalletRow } from "./shared";

export function WalletTab({ onSaved }: { onSaved: () => void }) {
  const load = useServerFn(listWalletsAdmin);
  const saveFn = useServerFn(upsertWalletAdmin);

  const [saved, setSaved] = useState<WalletRow | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState<string | null>(null); // saved address the draft was started from
  const [conflict, setConflict] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const savedAddr = saved?.cdp_wallet_id ?? null;
  const dirty = draft.trim() !== (base ?? "");
  const st = useRef({ dirty, base, load });
  st.current = { dirty, base, load };

  const reload = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const rows = (await st.current.load()) as WalletRow[];
      const btc = rows.find((r) => r.coin === "BTC") ?? null;
      const addr = btc?.cdp_wallet_id ?? null;
      setSaved(btc);
      setStatus("ready");
      setLoadErr(null);
      if (force || !st.current.dirty) {
        setDraft(addr ?? "");
        setBase(addr);
        setConflict(null);
      } else if (addr !== st.current.base) {
        setConflict(addr);
      }
    } catch (e) {
      setLoadErr(errMsg(e, "Wallet could not be loaded"));
      setStatus((s) => (s === "loading" ? "error" : s));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    reload(true);
    const t = setInterval(() => reload(), 45_000);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [reload]);

  const trimmed = draft.trim();
  const valid = trimmed !== "" && isBitcoinAddress(trimmed);
  let normalized: string | null = null;
  try { normalized = valid ? normalizeBitcoinAddress(trimmed) : null; } catch { normalized = null; }
  const sameAsSaved = normalized !== null && normalized === savedAddr;

  const doSave = async () => {
    if (!normalized) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await saveFn({ data: { coin: "BTC", address: normalized, expected_address: base } });
      setConfirming(false);
      setResult(r?.warning ? { tone: "warn", text: `Saved. ${r.warning}` } : { tone: "ok", text: "Receiving address saved. New invoices will use it." });
      await reload(true);
      onSaved();
    } catch (e) {
      setConfirming(false);
      setResult({ tone: "error", text: errMsg(e, "Save failed") });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const requestSave = () => (savedAddr ? setConfirming(true) : doSave());

  if (status === "loading")
    return <div className="grid gap-4 md:grid-cols-[1fr_240px]"><Skeleton className="h-48" /><Skeleton className="h-60" /></div>;
  if (status === "error")
    return (
      <Notice tone="error" testId="error-wallet-load" action={<button className={btnSecondary} onClick={() => reload(true)} data-testid="button-retry-wallet">Retry</button>}>
        {loadErr}
      </Notice>
    );

  return (
    <div className="space-y-4">
      <Notice tone="info">
        Enter a <strong>public</strong> Bitcoin mainnet receiving address you control. Never paste a private key or seed phrase.
        New BTC checkout uses this address; existing invoices keep the address and asset they were issued with. No new USDT/USDC invoices are issued.
      </Notice>

      {loadErr && <Notice tone="warn" testId="error-wallet-refresh">Could not refresh: {loadErr}</Notice>}
      {conflict !== null && (
        <Notice
          tone="warn"
          testId="status-wallet-conflict"
          action={<button className={btnSecondary} onClick={() => reload(true)} data-testid="button-load-latest-wallet">Discard draft and load latest</button>}
        >
          Another admin changed the saved address to <span className="break-all font-mono">{conflict || "(none)"}</span> while you were editing. Saving now will be rejected.
        </Notice>
      )}
      {result && <Notice tone={result.tone} testId="status-wallet-result">{result.text}</Notice>}

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_260px]">
        <section className={`${panel} p-4`}>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-[#1c1917]">Bitcoin receiving address</h2>
            <button className={`${btnSecondary} px-2 py-1`} onClick={() => reload()} disabled={refreshing} data-testid="button-refresh-wallet">
              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} aria-hidden /> Refresh
            </button>
          </div>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <div className="sm:col-span-3">
              <dt className="text-[10px] uppercase tracking-wider text-[#6b645d]">Saved address</dt>
              <dd className="mt-0.5 break-all font-mono text-[#1c1917]" data-testid="text-wallet-saved-address">{savedAddr ?? "None saved"}</dd>
            </div>
            {saved && (
              <>
                <div><dt className="text-[10px] uppercase tracking-wider text-[#6b645d]">Network</dt><dd>{saved.chain || "bitcoin-mainnet"}</dd></div>
                <div><dt className="text-[10px] uppercase tracking-wider text-[#6b645d]">Updated</dt><dd>{when(saved.updated_at)}</dd></div>
              </>
            )}
          </dl>

          <label htmlFor="wallet-address" className="mt-4 block text-xs font-medium text-[#292524]">{savedAddr ? "Replace with" : "Address"}</label>
          <input
            id="wallet-address"
            data-testid="input-wallet-address"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setConfirming(false); setResult(null); }}
            placeholder="bc1q... / 1... / 3..."
            spellCheck={false}
            autoComplete="off"
            aria-invalid={trimmed !== "" && !valid}
            aria-describedby="wallet-address-help"
            className={`${input} mt-1 font-mono text-xs`}
          />
          <p id="wallet-address-help" className={`mt-1 text-[11px] ${trimmed !== "" && !valid ? "text-[#7a1d14]" : "text-[#6b645d]"}`} data-testid="text-wallet-validation">
            {trimmed === "" ? "Mainnet only. Checksum is verified before saving."
              : !valid ? "Not a valid Bitcoin mainnet address (checksum or network mismatch)."
              : sameAsSaved ? "Matches the saved address." : "Valid mainnet address. Preview the QR before saving."}
          </p>

          {confirming ? (
            <div className="mt-3 rounded-md border border-[#e2cfa3] bg-[#fbf6ea] p-3 text-xs text-[#5c4210]" data-testid="panel-wallet-confirm">
              <p className="font-semibold">Replace the receiving address?</p>
              <p className="mt-1">Only <strong>new</strong> invoices will use the new address. Existing invoices keep their original address and QR.</p>
              <div className="mt-1 grid gap-0.5 font-mono text-[11px]">
                <span className="break-all">From: {savedAddr}</span>
                <span className="break-all">To: {normalized}</span>
              </div>
              <div className="mt-3 flex gap-2">
                <button className={btnPrimary} onClick={doSave} disabled={busy || conflict !== null} data-testid="button-confirm-wallet-replace">{busy ? "Saving..." : "Confirm replacement"}</button>
                <button className={btnSecondary} onClick={() => setConfirming(false)} disabled={busy} data-testid="button-cancel-wallet-replace">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={btnPrimary} onClick={requestSave} disabled={!valid || sameAsSaved || busy || conflict !== null} data-testid="button-save-wallet">
                {busy ? "Saving..." : savedAddr ? "Replace address" : "Save address"}
              </button>
              {dirty && (
                <button className={btnSecondary} onClick={() => { setDraft(base ?? ""); setResult(null); }} data-testid="button-reset-wallet">Discard changes</button>
              )}
            </div>
          )}
        </section>

        <aside className={`${panel} flex flex-col items-center gap-3 p-4`}>
          <div className="self-stretch text-[10px] uppercase tracking-wider text-[#6b645d]">
            {normalized && !sameAsSaved ? "Draft preview (unsaved)" : "Saved wallet QR"}
          </div>
          {normalized && !sameAsSaved ? (
            <div className="rounded-md border border-dashed border-[#a8a29e] p-2" data-testid="qr-wallet-draft"><BitcoinQr address={normalized} size={200} /></div>
          ) : savedAddr ? (
            <div className="rounded-md border border-[#e2dfdb] p-2" data-testid="qr-wallet-saved"><BitcoinQr address={savedAddr} size={200} /></div>
          ) : (
            <div className="grid h-[200px] w-[200px] place-items-center rounded-md border border-dashed border-[#d6d3d1] px-4 text-center text-[11px] text-[#6b645d]" data-testid="empty-wallet-qr">
              QR appears once a valid address is entered.
            </div>
          )}
          <p className="text-center text-[11px] leading-relaxed text-[#6b645d]">Generated locally from the address, so the code and text can never disagree.</p>
        </aside>
      </div>
    </div>
  );
}
