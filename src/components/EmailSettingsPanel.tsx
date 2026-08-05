import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  getSmtpSettings,
  saveSmtpSettings,
  sendSmtpTest,
  listOrderEmails,
  resendOrderEmail,
} from "@/lib/smtp.functions";

type Settings = {
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  from_name: string;
  from_address: string;
  reply_to: string;
  encryption: "none" | "starttls" | "ssl";
  enabled: boolean;
  updated_at: string | null;
};

type LogRow = {
  id: string;
  order_id: string;
  kind: string;
  recipient: string;
  status: string;
  detail: string | null;
  created_at: string;
};

const field =
  "w-full rounded-md border border-white/10 bg-[#0F1626] px-3 py-2 text-sm text-white outline-none focus:border-[#4F7CFF]";
const label = "mb-1 block text-[11px] uppercase tracking-wide text-white/50";

/** Super-admin SMTP relay settings + order email delivery log. */
export function EmailSettingsPanel() {
  const load = useServerFn(getSmtpSettings);
  const save = useServerFn(saveSmtpSettings);
  const test = useServerFn(sendSmtpTest);
  const loadLogs = useServerFn(listOrderEmails);
  const resend = useServerFn(resendOrderEmail);

  const [s, setS] = useState<Settings | null>(null);
  const [password, setPassword] = useState("");
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const refresh = async () => {
    try {
      const [cfg, rows] = await Promise.all([load(), loadLogs({ data: { limit: 50 } })]);
      setS(cfg as Settings);
      setLogs(rows as LogRow[]);
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "Failed to load" });
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (p: Partial<Settings>) => setS((prev) => (prev ? { ...prev, ...p } : prev));

  const onSave = async () => {
    if (!s) return;
    setBusy(true);
    setMsg(null);
    try {
      await save({
        data: {
          host: s.host,
          port: Number(s.port) || 587,
          username: s.username,
          password: password || undefined,
          from_name: s.from_name,
          from_address: s.from_address,
          reply_to: s.reply_to,
          encryption: s.encryption,
          enabled: s.enabled,
        },
      });
      setPassword("");
      setMsg({ tone: "ok", text: "SMTP settings saved." });
      await refresh();
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    if (!testTo) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = (await test({ data: { to: testTo } })) as { ok: boolean; error?: string };
      setMsg(
        r.ok
          ? { tone: "ok", text: `Test message sent to ${testTo}.` }
          : { tone: "bad", text: r.error ?? "Test failed" },
      );
    } catch (e) {
      setMsg({ tone: "bad", text: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setBusy(false);
    }
  };

  const onResend = async (orderId: string, kind: string) => {
    setBusy(true);
    try {
      await resend({
        data: { order_id: orderId, kind: kind === "order_confirmed" ? "order_confirmed" : "order_received" },
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!s) return <div className="text-xs text-white/50">Loading email settings…</div>;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-white/10 bg-[#1F2A44] p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">SMTP relay</h3>
            <p className="text-[11px] text-white/50">
              Used for order receipts and payment confirmations. Credentials never leave the server.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-white/70">
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
              className="h-4 w-4 accent-[#4F7CFF]"
            />
            Enabled
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <span className={label}>Host</span>
            <input
              className={field}
              value={s.host}
              placeholder="smtp.yourprovider.com"
              onChange={(e) => patch({ host: e.target.value })}
            />
          </div>
          <div>
            <span className={label}>Port</span>
            <input
              className={field}
              type="number"
              value={s.port}
              onChange={(e) => patch({ port: Number(e.target.value) })}
            />
          </div>
          <div>
            <span className={label}>Encryption</span>
            <select
              className={field}
              value={s.encryption}
              onChange={(e) => patch({ encryption: e.target.value as Settings["encryption"] })}
            >
              <option value="starttls">STARTTLS (587)</option>
              <option value="ssl">SSL / TLS (465)</option>
              <option value="none">None (25)</option>
            </select>
          </div>
          <div>
            <span className={label}>Username</span>
            <input
              className={field}
              value={s.username}
              autoComplete="off"
              onChange={(e) => patch({ username: e.target.value })}
            />
          </div>
          <div>
            <span className={label}>
              Password {s.has_password && <span className="text-green-300">(saved)</span>}
            </span>
            <input
              className={field}
              type="password"
              value={password}
              autoComplete="new-password"
              placeholder={s.has_password ? "•••••••• (leave blank to keep)" : ""}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <span className={label}>From name</span>
            <input
              className={field}
              value={s.from_name}
              onChange={(e) => patch({ from_name: e.target.value })}
            />
          </div>
          <div>
            <span className={label}>From address</span>
            <input
              className={field}
              value={s.from_address}
              placeholder="orders@connectliveagent.com"
              onChange={(e) => patch({ from_address: e.target.value })}
            />
          </div>
          <div className="md:col-span-2">
            <span className={label}>Reply-to (optional)</span>
            <input
              className={field}
              value={s.reply_to}
              placeholder="support@connectliveagent.com"
              onChange={(e) => patch({ reply_to: e.target.value })}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={onSave}
            disabled={busy}
            className="rounded-md bg-[#4F7CFF] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            Save settings
          </button>
          <input
            className={`${field} max-w-[240px]`}
            value={testTo}
            placeholder="you@example.com"
            onChange={(e) => setTestTo(e.target.value)}
          />
          <button
            onClick={onTest}
            disabled={busy || !testTo}
            className="rounded-md bg-white/10 px-4 py-2 text-xs text-white hover:bg-white/20 disabled:opacity-50"
          >
            Send test
          </button>
          {s.updated_at && (
            <span className="text-[11px] text-white/40">
              Updated {new Date(s.updated_at).toLocaleString()}
            </span>
          )}
        </div>

        {msg && (
          <div
            className={`mt-3 rounded-md px-3 py-2 text-xs ${
              msg.tone === "ok"
                ? "bg-green-500/10 text-green-200"
                : "bg-red-500/10 text-red-200"
            }`}
          >
            {msg.text}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-white/10 bg-[#1F2A44] p-4">
        <h3 className="mb-3 text-sm font-semibold text-white">Order email log</h3>
        {logs.length === 0 ? (
          <p className="text-xs text-white/50">No order emails yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-white/40">
                <tr>
                  <th className="py-2">When</th>
                  <th>Kind</th>
                  <th>Recipient</th>
                  <th>Status</th>
                  <th>Detail</th>
                  <th />
                </tr>
              </thead>
              <tbody className="text-white/80">
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-white/5">
                    <td className="py-2 whitespace-nowrap text-white/50">
                      {new Date(l.created_at).toLocaleString()}
                    </td>
                    <td>{l.kind.replace("order_", "")}</td>
                    <td className="max-w-[180px] truncate">{l.recipient}</td>
                    <td>
                      <span
                        className={
                          l.status === "sent"
                            ? "text-green-300"
                            : l.status === "skipped"
                              ? "text-amber-200"
                              : "text-red-300"
                        }
                      >
                        {l.status}
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate text-white/40">{l.detail ?? "—"}</td>
                    <td className="text-right">
                      {l.status !== "sent" && (
                        <button
                          onClick={() => onResend(l.order_id, l.kind)}
                          disabled={busy}
                          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-50"
                        >
                          Resend
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
