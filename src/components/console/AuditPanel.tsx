import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, RefreshCw, X } from "lucide-react";
import { auditData, type AuditExportProgress } from "@/lib/audit-data";
import {
  AUDIT_PAGE_SIZE, DEFAULT_AUDIT_FILTERS, auditDetailText, auditEventLabel,
  validateAuditFilters, type AuditFilters, type AuditRecord,
} from "@/lib/audit-report";

type DeviceLite = { id: string; display_name?: string | null; hostname?: string | null };

function deviceLabel(d: DeviceLite) {
  return d.display_name || d.hostname || d.id.slice(0, 8);
}

function sameFilters(a: AuditFilters, b: AuditFilters) {
  return a.event.trim() === b.event.trim() && a.deviceId === b.deviceId && a.from === b.from && a.to === b.to && a.order === b.order;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 19) + " UTC" : iso;
}

function eventTone(event: string) {
  if (/reap|fail|error|denied|revok|delete/i.test(event)) return "text-[#F5A524] border-[#F5A524]/30 bg-[#F5A524]/10";
  return "text-[#4F7CFF] border-[#4F7CFF]/30 bg-[#4F7CFF]/10";
}

const inputCls = "h-9 w-full rounded-md border border-white/10 bg-[#141C30] px-2 text-xs text-white placeholder:text-white/30 focus:border-[#4F7CFF] focus:outline-none";
const btnCls = "inline-flex h-9 items-center gap-1.5 rounded-md border border-white/10 px-3 text-xs text-white/80 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40";

export function AuditPanel({ userId, devices }: { userId: string | null; devices: DeviceLite[] }) {
  const [draft, setDraft] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  const [snapshot, setSnapshot] = useState(() => new Date().toISOString());
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AuditRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<AuditExportProgress | null>(null);
  const [exportMsg, setExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const exportAbort = useRef<AbortController | null>(null);

  const deviceNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of devices) m[d.id] = deviceLabel(d);
    return m;
  }, [devices]);

  // Reset all user-scoped state when identity changes.
  useEffect(() => {
    exportAbort.current?.abort();
    exportAbort.current = null;
    setRows([]); setTotal(0); setPage(0); setOpenId(null); setExporting(null); setExportMsg(null);
    setDraft(DEFAULT_AUDIT_FILTERS); setApplied(DEFAULT_AUDIT_FILTERS); setFilterError(null);
    setSnapshot(new Date().toISOString());
  }, [userId]);

  useEffect(() => () => exportAbort.current?.abort(), []);

  useEffect(() => {
    if (!userId) { setLoading(false); return; }
    const ctrl = new AbortController();
    setLoading(true); setError(null);
    auditData.fetchPage({ filters: applied, snapshot, page, signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setRows(res.rows); setTotal(res.total);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setRows([]);
        setError(e instanceof Error ? e.message : "Audit records could not be loaded.");
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [userId, applied, snapshot, page, reloadKey]);

  const dirty = !sameFilters(draft, applied);
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  const apply = useCallback(() => {
    try {
      const v = validateAuditFilters(draft);
      setFilterError(null);
      exportAbort.current?.abort();
      setApplied(v); setDraft(v); setPage(0); setOpenId(null);
      setSnapshot(new Date().toISOString());
    } catch (e) {
      setFilterError(e instanceof Error ? e.message : "Check the filters.");
    }
  }, [draft]);

  const refresh = () => {
    exportAbort.current?.abort();
    setSnapshot(new Date().toISOString()); setPage(0); setReloadKey((k) => k + 1);
  };

  const reset = () => {
    setDraft(DEFAULT_AUDIT_FILTERS); setFilterError(null);
    if (!sameFilters(applied, DEFAULT_AUDIT_FILTERS)) {
      setApplied(DEFAULT_AUDIT_FILTERS); setPage(0); setSnapshot(new Date().toISOString());
    }
  };

  const startExport = async () => {
    if (exportAbort.current) return;
    const ctrl = new AbortController();
    exportAbort.current = ctrl;
    setExportMsg(null);
    setExporting({ completed: 0, total: 0 });
    try {
      const res = await auditData.exportCsv({
        filters: applied, snapshot, deviceNames, signal: ctrl.signal,
        onProgress: (p) => { if (!ctrl.signal.aborted) setExporting(p); },
      });
      if (ctrl.signal.aborted) return;
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = res.filename; a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportMsg({ kind: "ok", text: `Exported ${res.rowCount.toLocaleString()} records to ${res.filename}.` });
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        setExportMsg({ kind: "err", text: "Export cancelled. No file was downloaded." });
      } else {
        setExportMsg({ kind: "err", text: e instanceof Error ? e.message : "Export failed. No file was downloaded." });
      }
    } finally {
      if (exportAbort.current === ctrl) exportAbort.current = null;
      setExporting(null);
    }
  };

  const cancelExport = () => exportAbort.current?.abort();

  const pct = exporting && exporting.total > 0 ? Math.round((exporting.completed / exporting.total) * 100) : 0;
  const first = total === 0 ? 0 : page * AUDIT_PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * AUDIT_PAGE_SIZE);

  return (
    <section className="min-w-0 rounded-lg border border-white/10 bg-[#1F2A44] text-xs" data-testid="panel-audit-report">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white">Audit report</h2>
          <p className="text-white/40" data-testid="text-audit-snapshot">
            Records up to {fmtTime(snapshot)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnCls} onClick={refresh} disabled={loading || !userId} data-testid="button-audit-refresh">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          {exporting ? (
            <button type="button" className={btnCls} onClick={cancelExport} data-testid="button-audit-export-cancel">
              <X className="h-3.5 w-3.5" /> Cancel export
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#4F7CFF] px-3 text-xs font-medium text-white hover:bg-[#4F7CFF]/90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={startExport}
              disabled={!userId || loading || !!error || total === 0}
              title={dirty ? "Exports the applied filters, not the unapplied edits" : "Export all matching records as CSV"}
              data-testid="button-audit-export"
            >
              <Download className="h-3.5 w-3.5" /> Export CSV
            </button>
          )}
        </div>
      </header>

      {exporting && (
        <div className="border-b border-white/10 px-4 py-3" data-testid="status-audit-export-progress" aria-live="polite">
          <div className="mb-1 flex justify-between text-white/60">
            <span>Preparing complete CSV. The file downloads only when every record is collected.</span>
            <span className="font-mono">{exporting.completed.toLocaleString()} / {exporting.total ? exporting.total.toLocaleString() : "..."}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-white/10">
            <div className="h-full origin-left bg-[#4F7CFF] transition-transform" style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
        </div>
      )}
      {exportMsg && !exporting && (
        <p
          className={`border-b border-white/10 px-4 py-2 ${exportMsg.kind === "ok" ? "text-emerald-300" : "text-[#F5A524]"}`}
          data-testid={exportMsg.kind === "ok" ? "status-audit-export-done" : "status-audit-export-error"}
          role="status"
        >
          {exportMsg.text}
        </p>
      )}

      <form
        className="grid grid-cols-1 gap-2 border-b border-white/10 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_1fr_1fr_1fr_auto]"
        onSubmit={(e) => { e.preventDefault(); apply(); }}
        data-testid="form-audit-filters"
      >
        <label className="min-w-0 space-y-1">
          <span className="text-white/50">Event name contains</span>
          <input className={inputCls} value={draft.event} maxLength={160} placeholder="e.g. session.reaped"
            onChange={(e) => setDraft({ ...draft, event: e.target.value })} data-testid="input-audit-event" />
        </label>
        <label className="min-w-0 space-y-1">
          <span className="text-white/50">Device</span>
          <select className={inputCls} value={draft.deviceId}
            onChange={(e) => setDraft({ ...draft, deviceId: e.target.value })} data-testid="select-audit-device">
            <option value="">All devices</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{deviceLabel(d)}</option>)}
          </select>
        </label>
        <label className="min-w-0 space-y-1">
          <span className="text-white/50">From (UTC)</span>
          <input type="date" className={inputCls} value={draft.from} max={draft.to || undefined}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })} data-testid="input-audit-from" />
        </label>
        <label className="min-w-0 space-y-1">
          <span className="text-white/50">To (UTC)</span>
          <input type="date" className={inputCls} value={draft.to} min={draft.from || undefined}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })} data-testid="input-audit-to" />
        </label>
        <label className="min-w-0 space-y-1">
          <span className="text-white/50">Order</span>
          <select className={inputCls} value={draft.order}
            onChange={(e) => setDraft({ ...draft, order: e.target.value as AuditFilters["order"] })} data-testid="select-audit-order">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button type="submit" className="h-9 rounded-md bg-white/10 px-3 text-white hover:bg-white/15" data-testid="button-audit-apply">Apply</button>
          <button type="button" className={btnCls} onClick={reset} data-testid="button-audit-reset">Reset</button>
        </div>
        {(filterError || dirty) && (
          <p className={`col-span-full ${filterError ? "text-[#F5A524]" : "text-white/50"}`}
            data-testid={filterError ? "error-audit-filters" : "status-audit-unapplied"} role="status">
            {filterError ?? "Filter changes are not applied yet. The report and CSV export still use the applied filters."}
          </p>
        )}
      </form>

      <div className="min-w-0 overflow-x-auto">
        <div role="table" aria-label="Audit records" className="min-w-[720px]">
          <div role="row" className="grid grid-cols-[170px_1.2fr_1fr_1fr_1fr_70px] gap-3 border-b border-white/10 px-4 py-2 text-[11px] uppercase tracking-wide text-white/40">
            <span role="columnheader">Time (UTC)</span>
            <span role="columnheader">Report</span>
            <span role="columnheader">Device</span>
            <span role="columnheader">Actor</span>
            <span role="columnheader">Session</span>
            <span role="columnheader" className="text-right">Detail</span>
          </div>

          {loading && rows.length === 0 && !error && Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="grid grid-cols-[170px_1.2fr_1fr_1fr_1fr_70px] gap-3 border-b border-white/5 px-4 py-3" data-testid="skeleton-audit-row">
              {Array.from({ length: 6 }).map((__, j) => <div key={j} className="h-3 animate-pulse rounded bg-white/10" />)}
            </div>
          ))}

          {error && (
            <div className="flex flex-wrap items-center gap-3 px-4 py-6 text-[#F5A524]" data-testid="error-audit-load" role="alert">
              <span>{error}</span>
              <button type="button" className={btnCls} onClick={() => setReloadKey((k) => k + 1)} data-testid="button-audit-retry">Retry</button>
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="px-4 py-10 text-center" data-testid="empty-audit">
              <p className="text-white/70">{userId ? "No audit records match these filters." : "Sign in to view audit records."}</p>
              {!sameFilters(applied, DEFAULT_AUDIT_FILTERS) && (
                <button type="button" className="mt-2 text-[#4F7CFF] hover:underline" onClick={reset} data-testid="button-audit-clear-empty">Clear filters</button>
              )}
            </div>
          )}

          {!error && rows.map((r) => {
            const open = openId === r.id;
            const dev = r.device_id ? deviceNames[r.device_id] : null;
            return (
              <div key={r.id} role="rowgroup" className={`border-b border-white/5 last:border-0 ${loading ? "opacity-60" : ""}`} data-testid={`row-audit-${r.id}`}>
                <div role="row" className="grid grid-cols-[170px_1.2fr_1fr_1fr_1fr_70px] items-center gap-3 px-4 py-2.5 hover:bg-white/[0.03]">
                  <span role="cell" className="font-mono text-white/60">{fmtTime(r.created_at)}</span>
                  <span role="cell" className="min-w-0">
                    <span className={`inline-block max-w-full truncate rounded border px-1.5 py-0.5 ${eventTone(r.event)}`} title={r.event}>
                      {auditEventLabel(r.event)}
                    </span>
                  </span>
                  <span role="cell" className="min-w-0 truncate text-white/80" title={r.device_id ?? ""}>
                    {r.device_id ? (dev ?? <span className="font-mono text-white/50">{r.device_id.slice(0, 8)}</span>) : <span className="text-white/30">None</span>}
                  </span>
                  <span role="cell" className="min-w-0 truncate font-mono text-white/50" title={r.actor ?? ""}>
                    {r.actor ? r.actor.slice(0, 8) : <span className="font-sans text-white/30">System</span>}
                  </span>
                  <span role="cell" className="min-w-0 truncate font-mono text-white/50" title={r.session_id ?? ""}>
                    {r.session_id ? r.session_id.slice(0, 8) : <span className="font-sans text-white/30">None</span>}
                  </span>
                  <span role="cell" className="text-right">
                    <button type="button" className="text-[#4F7CFF] hover:underline" aria-expanded={open}
                      onClick={() => setOpenId(open ? null : r.id)} data-testid={`button-audit-detail-${r.id}`}>
                      {open ? "Hide" : "View"}
                    </button>
                  </span>
                </div>
                {open && (
                  <div className="grid gap-3 bg-[#141C30] px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]" data-testid={`detail-audit-${r.id}`}>
                    <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono text-[11px]">
                      <dt className="font-sans text-white/40">Event</dt><dd className="break-all text-white/80">{r.event}</dd>
                      <dt className="font-sans text-white/40">Audit ID</dt><dd className="break-all text-white/80">{r.id}</dd>
                      <dt className="font-sans text-white/40">Timestamp</dt><dd className="break-all text-white/80">{r.created_at}</dd>
                      <dt className="font-sans text-white/40">Actor ID</dt><dd className="break-all text-white/80">{r.actor ?? "None"}</dd>
                      <dt className="font-sans text-white/40">Device ID</dt><dd className="break-all text-white/80">{r.device_id ?? "None"}</dd>
                      <dt className="font-sans text-white/40">Session ID</dt><dd className="break-all text-white/80">{r.session_id ?? "None"}</dd>
                    </dl>
                    <div className="min-w-0">
                      <p className="mb-1 text-white/40">Details (credentials redacted)</p>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-white/10 p-2 font-mono text-[11px] text-white/70">
                        {auditDetailText(r.detail, true)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 px-4 py-3 text-white/50">
        <span data-testid="text-audit-range">
          {total === 0 ? "0 records" : `${first.toLocaleString()}-${last.toLocaleString()} of ${total.toLocaleString()} records`}
        </span>
        <div className="flex items-center gap-2">
          <button type="button" className={btnCls} disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)} data-testid="button-audit-prev" aria-label="Previous page">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="font-mono" data-testid="text-audit-page">{page + 1} / {pages}</span>
          <button type="button" className={btnCls} disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)} data-testid="button-audit-next" aria-label="Next page">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </footer>
    </section>
  );
}
