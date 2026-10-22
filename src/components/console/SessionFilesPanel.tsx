import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  FileArchive,
  Download,
  Trash2,
  Upload,
  Lock,
  LockOpen,
  Loader2,
  ArrowDownToLine,
  ArrowUpFromLine,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { WebRtcLive, FileTransferEvent } from "@/lib/webrtc-live";
import {
  listSessionFiles,
  prepareSessionUpload,
  registerSessionFile,
  deleteSessionFile,
  getSessionFileUrl,
  cacheSessionPassword,
  clearSessionPassword,
  packageSessionFiles,
} from "@/lib/session-files.functions";

async function fileProxyFetch(url: string, init: RequestInit = {}) {
  const target = new URL(url, window.location.origin);
  if (target.origin !== window.location.origin ||
      !/^\/api\/public\/admin\/session\/[^/]+\/files\/bytes$/.test(target.pathname))
    throw new Error("invalid_file_proxy_url");
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("authentication_required");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${data.session.access_token}`);
  const response = await fetch(target, {
    ...init, cache: "no-store", redirect: "error",
    headers,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `file_request_failed_${response.status}`);
  }
  return response;
}

async function downloadFile(url: string, name: string) {
  // window.open cannot attach the JWT. Fetch authenticated bytes, then offer a
  // local object URL; neither the server URL nor that object URL contains a JWT.
  const response = await fileProxyFetch(url);
  const blob = await response.blob();
  const local = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = local;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(local), 1000);
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function sha256Hex(blob: Blob): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

/**
 * Step 8 — in-session Files panel.
 *
 * Transfers ride the `files` WebRTC DataChannel when it is open; every payload
 * is also archived in the private bucket so the transcript survives the
 * session. "Download as encrypted .zip" locks the selection with the
 * customer's verified account password (AES-256), which is held server-side
 * for two hours and never leaves the backend in plaintext.
 */
export function SessionFilesPanel({
  sessionId,
  getRtc,
}: {
  sessionId: string;
  getRtc: () => WebRtcLive | null;
}) {
  const qc = useQueryClient();
  const list = useServerFn(listSessionFiles);
  const prepare = useServerFn(prepareSessionUpload);
  const register = useServerFn(registerSessionFile);
  const remove = useServerFn(deleteSessionFile);
  const linkFor = useServerFn(getSessionFileUrl);
  const cachePw = useServerFn(cacheSessionPassword);
  const clearPw = useServerFn(clearSessionPassword);
  const packageZip = useServerFn(packageSessionFiles);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [showLock, setShowLock] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { data } = useQuery({
    queryKey: ["session-files", sessionId],
    queryFn: () => list({ data: { sessionId } }),
    refetchInterval: 15_000,
  });
  const files = data?.ok ? data.files : [];
  const hasPassword = !!(data?.ok && data.hasPassword);
  const bytesUsed = data?.ok ? data.bytesUsed : 0;

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["session-files", sessionId] });
  }, [qc, sessionId]);

  /** Archive a blob into the private bucket and write its manifest row. */
  const archive = useCallback(
    async (
      blob: Blob,
      name: string,
      direction: "from_agent" | "from_admin",
      transport: "datachannel" | "http",
    ) => {
      const prep = await prepare({ data: { sessionId, name, size: blob.size } });
      if (!prep.ok) {
        toast.error(
          prep.error === "file_too_large"
            ? "That file is over the 500 MB per-file limit."
            : prep.error === "session_quota_exceeded"
              ? "This session has reached its 5 GB transfer limit."
              : "Could not start the upload.",
        );
        return false;
      }
      try {
        await fileProxyFetch(prep.url, { method: "PUT", body: blob });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Upload failed.");
        return false;
      }
      const res = await register({
        data: {
          sessionId,
          path: prep.path,
          name,
          size: blob.size,
          mime: blob.type || "application/octet-stream",
          sha256: await sha256Hex(blob),
          direction,
          transport,
        },
      });
      if (!res.ok) toast.error(res.error || "Could not register the uploaded file.");
      return res.ok;
    },
    [prepare, register, sessionId],
  );

  // Inbound transfers pushed by the agent over the `files` channel.
  useEffect(() => {
    const rtc = getRtc();
    if (!rtc?.onFile) return;
    const off = rtc.onFile((ev: FileTransferEvent) => {
      if (ev.kind === "progress") {
        setProgress({ name: ev.name, pct: ev.size ? Math.min(100, (ev.sent / ev.size) * 100) : 0 });
      } else if (ev.kind === "complete") {
        setProgress(null);
        void (async () => {
          const ok = await archive(ev.blob, ev.name, "from_agent", "datachannel");
          if (ok) {
            toast.success(`Received ${ev.name}`);
            refresh();
          }
        })();
      } else if (ev.kind === "sent") {
        setProgress(null);
      } else if (ev.kind === "error") {
        setProgress(null);
        toast.error(ev.message);
      }
    });
    return off;
  }, [archive, getRtc, refresh]);

  const pushFiles = useCallback(
    async (picked: FileList | File[]) => {
      const rtc = getRtc();
      setBusy(true);
      try {
        for (const file of Array.from(picked)) {
          setProgress({ name: file.name, pct: 0 });
          const viaChannel = rtc?.filesReady?.() ? await rtc.sendFile(file) : false;
          const ok = await archive(
            file,
            file.name,
            "from_admin",
            viaChannel ? "datachannel" : "http",
          );
          if (ok) {
            toast.success(
              viaChannel
                ? `Sent ${file.name} to the remote PC`
                : `Stored ${file.name} — it will deliver when the live channel reconnects`,
            );
          }
        }
        refresh();
      } finally {
        setProgress(null);
        setBusy(false);
      }
    },
    [archive, getRtc, refresh],
  );

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  return (
    <div className="border-t border-white/10 bg-[#0B1220] px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/60">
          <FileArchive className="h-3.5 w-3.5" /> Session files
          <span className="font-normal normal-case tracking-normal text-white/35">
            {fmtBytes(bytesUsed)} of 5 GB · {getRtc()?.filesReady?.() ? "live channel" : "store & forward"}
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded bg-[#4F7CFF] px-3 py-1.5 text-xs font-medium hover:opacity-90 disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" /> Send files
          </button>
          <button
            onClick={() => (hasPassword ? void clearPw({ data: { sessionId } }).then(refresh) : setShowLock((v) => !v))}
            className="flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5"
          >
            {hasPassword ? <Lock className="h-3.5 w-3.5 text-[#4ADE80]" /> : <LockOpen className="h-3.5 w-3.5" />}
            {hasPassword ? "Password held" : "Unlock zip"}
          </button>
          <button
            disabled={!hasPassword || selectedIds.length === 0 || zipping}
            onClick={async () => {
              setZipping(true);
              try {
                const res = await packageZip({ data: { sessionId, fileIds: selectedIds } });
                if (!res.ok) {
                  toast.error(
                    res.error === "no_password"
                      ? "Verify the customer password first."
                      : "Could not build the archive.",
                  );
                  return;
                }
                await downloadFile(res.url, "connectlive-files.zip");
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Archive download failed.");
              } finally {
                setZipping(false);
              }
            }}
            className="flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5 disabled:opacity-40"
          >
            {zipping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileArchive className="h-3.5 w-3.5" />}
            Encrypted .zip ({selectedIds.length})
          </button>
        </div>
      </div>

      {showLock && !hasPassword && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-white/10 bg-[#0F172A] p-3">
          <p className="w-full text-[11px] text-white/50">
            Verify the customer&apos;s ConnectLive account password. It is checked against their
            account, encrypted, and used only to lock archives for the next two hours.
          </p>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="customer@company.com"
            autoComplete="off"
            className="flex-1 min-w-[180px] rounded border border-white/10 bg-[#0B1220] px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:border-[#4F7CFF] focus:outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Account password"
            autoComplete="new-password"
            className="flex-1 min-w-[160px] rounded border border-white/10 bg-[#0B1220] px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:border-[#4F7CFF] focus:outline-none"
          />
          <button
            onClick={async () => {
              const res = await cachePw({ data: { sessionId, email, password } });
              setPassword("");
              if (!res.ok) {
                toast.error(res.error === "bad_credentials" ? "That password did not match." : "Could not verify.");
                return;
              }
              toast.success("Password verified for this session.");
              setShowLock(false);
              refresh();
            }}
            className="rounded bg-[#4F7CFF] px-3 py-1.5 text-xs font-medium hover:opacity-90"
          >
            Verify
          </button>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void pushFiles(e.dataTransfer.files);
        }}
        className={`mt-3 rounded border border-dashed p-3 transition-colors ${
          dragOver ? "border-[#4F7CFF] bg-[#4F7CFF]/10" : "border-white/15"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void pushFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {progress ? (
          <div className="text-xs text-white/70">
            <div className="mb-1 flex justify-between">
              <span className="truncate">{progress.name}</span>
              <span>{progress.pct.toFixed(0)}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded bg-white/10">
              <div className="h-full bg-[#4F7CFF]" style={{ width: `${progress.pct}%` }} />
            </div>
          </div>
        ) : files.length === 0 ? (
          <p className="text-center text-xs text-white/40">
            Drop files here to send them to the remote PC. Files the technician pulls back appear in
            this list.
          </p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-white/80 hover:bg-white/5"
              >
                <input
                  type="checkbox"
                  checked={!!selected[f.id]}
                  onChange={(e) => setSelected((prev) => ({ ...prev, [f.id]: e.target.checked }))}
                  className="h-3.5 w-3.5 accent-[#4F7CFF]"
                />
                {f.direction === "from_agent" ? (
                  <ArrowDownToLine className="h-3.5 w-3.5 shrink-0 text-[#4ADE80]" />
                ) : (
                  <ArrowUpFromLine className="h-3.5 w-3.5 shrink-0 text-[#4F7CFF]" />
                )}
                <span className="flex-1 truncate">{f.name}</span>
                <span className="shrink-0 text-white/40">{fmtBytes(Number(f.size_bytes ?? 0))}</span>
                <button
                  title="Download"
                  onClick={async () => {
                    const res = await linkFor({ data: { sessionId, fileId: f.id } });
                    if (!res.ok) { toast.error("Download unavailable."); return; }
                    try { await downloadFile(res.url, f.name); }
                    catch (error) { toast.error(error instanceof Error ? error.message : "Download failed."); }
                  }}
                  className="rounded p-1 hover:bg-white/10"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button
                  title="Delete"
                  onClick={async () => {
                    const res = await remove({ data: { sessionId, fileId: f.id } });
                    if (res.ok) refresh();
                  }}
                  className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-[#F87171]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
