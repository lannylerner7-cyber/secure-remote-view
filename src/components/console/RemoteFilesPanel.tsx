import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Download, File, Folder, HardDrive, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileTransferEvent, WebRtcLive } from "@/lib/webrtc-live";
import {
  EMPTY_SESSION_TOOLS, type RemoteEntry, type RemoteRoot, type SessionToolsClient, type SessionToolsState,
} from "@/shared/session-tools";

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function errorText(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

type Location = { root: RemoteRoot; path: string };
type Job = { entry: RemoteEntry; status: "queued" | "active" | "done" | "failed" | "cancelled"; message?: string };

/**
 * Browse the Agent's approved roots and pull selected files. Nothing is
 * listed until the technician opens a root; downloads run one at a time and
 * only report done when tools.download resolves with a verified file.
 */
export function RemoteFilesPanel({ tools, live, allowed }: {
  tools: SessionToolsClient | null; live: WebRtcLive | null; allowed: boolean;
}) {
  const [state, setState] = useState<SessionToolsState>(EMPTY_SESSION_TOOLS);
  const [history, setHistory] = useState<Location[]>([]);
  const [loc, setLoc] = useState<Location | null>(null);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, RemoteEntry>>({});
  const [jobs, setJobs] = useState<Job[]>([]);
  const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const listAbort = useRef<AbortController | null>(null);
  const dlAbort = useRef<AbortController | null>(null);
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  const activeName = useRef<string | null>(null);

  // Reset everything when the tools client (device/session) changes.
  useEffect(() => {
    setHistory([]); setLoc(null); setEntries([]); setNext(null); setListError(null);
    setSelected({}); setJobs([]); setProgress(null); setDownloading(false); setListing(false);
    if (!tools) { setState(EMPTY_SESSION_TOOLS); return; }
    setState(tools.state());
    const off = tools.onState(setState);
    return () => {
      off();
      listAbort.current?.abort(); listAbort.current = null;
      if (dlAbort.current) { dlAbort.current.abort(); dlAbort.current = null; tools.cancelDownload(); }
    };
  }, [tools]);

  useEffect(() => {
    if (!live) return;
    return live.onFile((ev: FileTransferEvent) => {
      if (!activeName.current || ev.name !== activeName.current) return;
      if (ev.kind === "begin") setProgress({ name: ev.name, pct: 0 });
      else if (ev.kind === "progress") setProgress({ name: ev.name, pct: ev.size ? Math.min(100, (ev.sent / ev.size) * 100) : 0 });
      else if (ev.kind === "complete") setProgress({ name: ev.name, pct: 100 });
      else if (ev.kind === "error") setProgress(null);
    });
  }, [live]);

  const open = useCallback(async (target: Location, cursor: string | null, push: boolean) => {
    const t = toolsRef.current;
    if (!t) return;
    listAbort.current?.abort();
    const ac = new AbortController();
    listAbort.current = ac;
    setListing(true); setListError(null);
    try {
      const dir = await t.list(target.root.id, target.path, cursor, ac.signal);
      if (ac.signal.aborted || toolsRef.current !== t) return;
      if (dir.rootId !== target.root.id) throw new Error("The Agent returned a listing for a different root.");
      if (cursor) setEntries((prev) => [...prev, ...dir.entries]);
      else {
        if (push && loc) setHistory((h) => [...h, loc]);
        setLoc({ root: target.root, path: dir.path });
        setEntries(dir.entries); setSelected({});
      }
      setNext(dir.next);
    } catch (e) {
      if (ac.signal.aborted || isAbort(e) || toolsRef.current !== t) return;
      setListError(errorText(e, "The Agent did not return this folder."));
    } finally {
      if (listAbort.current === ac) { listAbort.current = null; setListing(false); }
    }
  }, [loc]);

  function cancelListing() {
    listAbort.current?.abort(); listAbort.current = null; setListing(false);
    setListError("Listing cancelled.");
  }

  function back() {
    const prev = history[history.length - 1];
    if (!prev) { listAbort.current?.abort(); setLoc(null); setEntries([]); setNext(null); setSelected({}); return; }
    setHistory((h) => h.slice(0, -1));
    void open(prev, null, false);
  }

  function up() {
    if (!loc) return;
    const trimmed = loc.path.replace(/[\\/]+$/, "");
    const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    if (cut < 0 || !trimmed) { listAbort.current?.abort(); setLoc(null); setEntries([]); setNext(null); setSelected({}); setHistory([]); return; }
    void open({ root: loc.root, path: trimmed.slice(0, cut) }, null, true);
  }

  async function downloadSelected() {
    const t = toolsRef.current;
    if (!t || !loc || downloading) return;
    const list = Object.values(selected);
    if (!list.length) return;
    const rootId = loc.root.id;
    setDownloading(true);
    setJobs(list.map((entry) => ({ entry, status: "queued" })));
    const mark = (i: number, patch: Partial<Job>) =>
      setJobs((js) => js.map((j, k) => (k === i ? { ...j, ...patch } : j)));
    try {
      for (let i = 0; i < list.length; i++) {
        if (toolsRef.current !== t) return;
        const ac = new AbortController();
        dlAbort.current = ac;
        activeName.current = list[i].name;
        setProgress({ name: list[i].name, pct: 0 });
        mark(i, { status: "active" });
        try {
          await t.download(rootId, list[i], ac.signal);
          if (toolsRef.current !== t) return;
          mark(i, { status: "done" });
        } catch (e) {
          if (toolsRef.current !== t) return;
          if (ac.signal.aborted || isAbort(e)) {
            setJobs((js) => js.map((j, k) => (k >= i && j.status !== "done" ? { ...j, status: "cancelled" } : j)));
            return;
          }
          mark(i, { status: "failed", message: errorText(e, "Not verified. No retry was made.") });
        } finally {
          if (dlAbort.current === ac) dlAbort.current = null;
          activeName.current = null;
          setProgress(null);
        }
      }
      setSelected({});
    } finally {
      if (toolsRef.current === t) setDownloading(false);
    }
  }

  function cancelDownload() {
    dlAbort.current?.abort();
    toolsRef.current?.cancelDownload();
  }

  let blocker: string | null = null;
  if (!allowed) blocker = "Your account does not have permission to browse files on this device.";
  else if (!tools) blocker = "Remote file browsing needs a live session with the Agent.";
  else if (!state.supported) blocker = state.reason ?? "This Agent does not support remote file browsing.";
  else if (!state.roots.length) blocker = "The Agent has not shared any folders for this session.";

  const selCount = Object.keys(selected).length;

  return (
    <section aria-label="Remote files" data-testid="panel-remote-files" className="space-y-3 border-t border-white/10 bg-[#0B1220] px-5 py-4 text-sm text-white">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/60">
          <HardDrive className="h-3.5 w-3.5" /> Remote files
          {loc && <span data-testid="text-remote-path" className="max-w-[40ch] truncate font-normal normal-case tracking-normal text-white/40">{loc.root.name}{loc.path ? ` / ${loc.path}` : ""}</span>}
        </span>
        <div className="flex flex-wrap gap-2">
          {loc && <>
            <Button type="button" size="sm" variant="outline" data-testid="button-remote-back" onClick={back} disabled={downloading}
              className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" /> Back</Button>
            <Button type="button" size="sm" variant="outline" data-testid="button-remote-up" onClick={up} disabled={downloading || listing}
              className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"><ArrowUp className="h-3.5 w-3.5" /> Up</Button>
          </>}
          {downloading ? (
            <Button type="button" size="sm" variant="outline" data-testid="button-cancel-download" onClick={cancelDownload}
              className="border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white"><X className="h-3.5 w-3.5" /> Cancel download</Button>
          ) : (
            <Button type="button" size="sm" data-testid="button-download-selected" disabled={!!blocker || !selCount}
              onClick={() => void downloadSelected()} className="bg-[#4F7CFF] text-white hover:bg-[#4F7CFF]/90">
              <Download className="h-3.5 w-3.5" /> Download ({selCount})
            </Button>
          )}
        </div>
      </div>

      {blocker ? (
        <p role="status" data-testid="status-remote-files" className="text-xs text-white/50">{blocker}</p>
      ) : !loc ? (
        <div className="space-y-1">
          <p className="text-[11px] text-white/45">Choose a shared folder. Nothing is listed until you open one.</p>
          <ul className="space-y-1">
            {state.roots.map((r) => (
              <li key={r.id}>
                <button type="button" data-testid={`button-root-${r.id}`} disabled={listing}
                  onClick={() => { setHistory([]); void open({ root: r, path: "" }, null, false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-white/80 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4F7CFF] disabled:opacity-50">
                  <HardDrive className="h-3.5 w-3.5 text-[#4F7CFF]" /> {r.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded border border-white/10">
          {entries.length === 0 && !listing && !listError ? (
            <p className="p-3 text-center text-xs text-white/40">This folder is empty.</p>
          ) : (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto p-1" data-testid="list-remote-entries">
              {entries.map((e) => (
                <li key={e.path} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-white/80 hover:bg-white/5">
                  {e.directory ? (
                    <button type="button" data-testid={`button-open-${e.path}`} disabled={listing || downloading}
                      onClick={() => void open({ root: loc.root, path: e.path }, null, true)}
                      className="flex flex-1 items-center gap-2 truncate text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4F7CFF] disabled:opacity-50">
                      <Folder className="h-3.5 w-3.5 shrink-0 text-[#4F7CFF]" /><span className="truncate">{e.name}</span>
                    </button>
                  ) : (
                    <label className="flex flex-1 cursor-pointer items-center gap-2 truncate">
                      <input type="checkbox" data-testid={`checkbox-file-${e.path}`} disabled={downloading}
                        checked={!!selected[e.path]} aria-label={`Select ${e.name}`}
                        onChange={(ev) => setSelected((s) => {
                          const n = { ...s }; if (ev.target.checked) n[e.path] = e; else delete n[e.path]; return n;
                        })}
                        className="h-3.5 w-3.5 accent-[#4F7CFF]" />
                      <File className="h-3.5 w-3.5 shrink-0 text-white/50" /><span className="truncate">{e.name}</span>
                      <span className="ml-auto shrink-0 text-white/40">{fmtBytes(e.size)}</span>
                    </label>
                  )}
                </li>
              ))}
            </ul>
          )}
          {next && !listing && (
            <div className="border-t border-white/10 p-1">
              <Button type="button" size="sm" variant="ghost" data-testid="button-load-more" className="w-full text-white/70 hover:bg-white/5 hover:text-white"
                onClick={() => void open(loc, next, false)}>Load more</Button>
            </div>
          )}
        </div>
      )}

      {listing && (
        <div className="flex items-center justify-between gap-2 text-xs text-white/60" role="status">
          <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking the Agent for this folder…</span>
          <Button type="button" size="sm" variant="ghost" data-testid="button-cancel-listing" onClick={cancelListing}
            className="text-white/70 hover:bg-white/5 hover:text-white">Cancel</Button>
        </div>
      )}
      {listError && <p role="alert" data-testid="text-list-error" className="text-xs text-rose-300">{listError}</p>}

      {progress && (
        <div className="text-xs text-white/70" data-testid="status-download-progress">
          <div className="mb-1 flex justify-between"><span className="truncate">{progress.name}</span><span>{progress.pct.toFixed(0)}%</span></div>
          <div className="h-1 w-full overflow-hidden rounded bg-white/10"><div className="h-full bg-[#4F7CFF]" style={{ width: `${progress.pct}%` }} /></div>
          {progress.pct >= 100 && <p className="mt-1 text-white/45">Received. Waiting for verification…</p>}
        </div>
      )}
      {jobs.length > 0 && (
        <ul className="space-y-0.5 text-[11px]" aria-live="polite" data-testid="list-download-jobs">
          {jobs.map((j, i) => (
            <li key={`${j.entry.path}-${i}`} className="flex justify-between gap-2">
              <span className="truncate text-white/60">{j.entry.name}</span>
              <span className={j.status === "done" ? "text-emerald-300" : j.status === "failed" ? "text-rose-300" : "text-white/45"}>
                {j.status === "done" ? "Verified and saved" : j.status === "failed" ? j.message
                  : j.status === "active" ? "Transferring" : j.status === "cancelled" ? "Cancelled" : "Queued"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
