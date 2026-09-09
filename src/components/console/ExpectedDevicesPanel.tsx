import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  addExpectedDevices,
  listExpectedDevices,
  removeExpectedDevice,
  type ExpectedRow,
} from "@/lib/expected-devices.functions";

/**
 * Expected-devices roster. Admin pastes hostnames; the panel shows which are
 * already enrolled (agent installed) vs still missing. The install-link
 * button copies the download URL to the clipboard so it can be sent to the
 * user of the missing machine.
 */
const INSTALLER_URL = "https://www.connectliveagent.com/#download";

export function ExpectedDevicesPanel() {
  const list = useServerFn(listExpectedDevices);
  const add = useServerFn(addExpectedDevices);
  const remove = useServerFn(removeExpectedDevice);

  const [rows, setRows] = useState<ExpectedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await list());
    } finally {
      setLoading(false);
    }
  }, [list]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onAdd() {
    const hostnames = input
      .split(/[\s,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (hostnames.length === 0) return;
    setBusy(true);
    try {
      await add({ data: { hostnames, note: note.trim() || null } });
      setInput("");
      setNote("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onCsv(file: File) {
    const text = await file.text();
    setInput((prev) => (prev ? prev + "\n" : "") + text);
  }

  const installed = rows.filter((r) => r.status === "installed").length;
  const missing = rows.length - installed;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatBox label="Expected" value={rows.length} />
        <StatBox label="Installed" value={installed} tone="ok" />
        <StatBox label="Not installed" value={missing} tone={missing > 0 ? "warn" : "muted"} />
      </div>

      <section className="rounded-lg border border-white/10 bg-[#1F2A44] p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-widest text-white/60">
          Add expected hostnames
        </h3>
        <p className="mb-2 text-xs text-white/50">
          One hostname per line (or comma-separated). Matching is case-insensitive and ignores
          domain suffixes, so <code className="text-white/70">PC-42</code> matches{" "}
          <code className="text-white/70">pc-42.corp.local</code>.
        </p>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={4}
          placeholder="PC-42&#10;LOBBY-KIOSK&#10;ACCOUNTING-01"
          className="w-full rounded border border-white/10 bg-black/30 p-2 font-mono text-xs text-white outline-none focus:border-[#4F7CFF]"
        />
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (e.g. Accounting floor)"
            className="rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-white outline-none focus:border-[#4F7CFF]"
          />
          <label className="cursor-pointer rounded border border-white/15 px-3 py-1.5 text-center text-xs text-white/70 hover:bg-white/5">
            Import CSV
            <input
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onCsv(f);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <button
            onClick={onAdd}
            disabled={busy || !input.trim()}
            className="rounded bg-[#4F7CFF] px-4 py-1.5 text-xs font-medium disabled:opacity-40"
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-white/10 bg-[#1F2A44]">
        <table className="w-full text-left text-sm">
          <thead className="bg-black/20 text-xs uppercase tracking-widest text-white/50">
            <tr>
              <th className="px-4 py-2">Hostname</th>
              <th className="px-4 py-2">Note</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Last seen</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-white/50">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-white/50">
                  No expected devices yet. Add hostnames above to start tracking.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/5">
                <td className="px-4 py-2 font-medium">{r.hostname}</td>
                <td className="px-4 py-2 text-white/60">{r.note ?? "—"}</td>
                <td className="px-4 py-2">
                  {r.status === "installed" ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                      installed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                      not installed
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-white/60">
                  {r.last_seen_at ? new Date(r.last_seen_at).toLocaleString() : "—"}
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="inline-flex items-center gap-2">
                    {r.status === "not_installed" && (
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(INSTALLER_URL);
                            alert("Installer link copied to clipboard.");
                          } catch {
                            prompt("Copy this link:", INSTALLER_URL);
                          }
                        }}
                        className="rounded border border-[#4F7CFF]/40 bg-[#4F7CFF]/10 px-3 py-1 text-xs text-[#B9CCFF] hover:bg-[#4F7CFF]/20"
                      >
                        Copy install link
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        if (!confirm(`Remove ${r.hostname} from the expected list?`)) return;
                        await remove({ data: { id: r.id } });
                        await refresh();
                      }}
                      className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs text-red-300 hover:bg-red-500/20"
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function StatBox({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "muted";
}) {
  const color =
    tone === "ok" ? "text-green-300" : tone === "warn" ? "text-amber-300" : "text-white/80";
  return (
    <div className="rounded-lg border border-white/10 bg-[#1F2A44] p-4">
      <div className="text-xs uppercase tracking-widest text-white/50">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}
