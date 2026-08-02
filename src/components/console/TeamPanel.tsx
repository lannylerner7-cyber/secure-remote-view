import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  listAdmins,
  createAdmin,
  updateAdminRole,
  deleteAdmin,
  type AppRole,
  type AdminRow,
} from "@/lib/admins.functions";
import {
  broadcastNotification,
  sendNotification,
  type NotificationSeverity,
} from "@/lib/notifications.functions";
import { DirectNotifyModal } from "./DirectNotifyModal";

export function TeamPanel() {
  const list = useServerFn(listAdmins);
  const create = useServerFn(createAdmin);
  const updateRole = useServerFn(updateAdminRole);
  const removeAdmin = useServerFn(deleteAdmin);
  const broadcast = useServerFn(broadcastNotification);
  const sendDirect = useServerFn(sendNotification);

  const [allRows, setAllRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    email: "",
    password: "",
    display_name: "",
    role: "admin" as AppRole,
  });
  const [busy, setBusy] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 50;

  // Broadcast panel
  const [bcTitle, setBcTitle] = useState("");
  const [bcBody, setBcBody] = useState("");
  const [bcSeverity, setBcSeverity] = useState<NotificationSeverity>("info");
  const [bcSending, setBcSending] = useState<null | "sending" | "sent" | "error">(null);

  // Direct notification
  const [dmTarget, setDmTarget] = useState<AdminRow | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setAllRows(await list());
      setErr(null);
      setSelected(new Set());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id ?? null));
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return allRows;
    return allRows.filter(
      (r) =>
        (r.email ?? "").toLowerCase().includes(needle) ||
        (r.display_name ?? "").toLowerCase().includes(needle) ||
        (r.role ?? "").toLowerCase().includes(needle),
    );
  }, [allRows, q]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  useEffect(() => {
    if (page >= pageCount) setPage(0);
  }, [pageCount, page]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await create({ data: form });
      setForm({ email: "", password: "", display_name: "", role: "admin" });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(user_id: string, role: AppRole) {
    try {
      await updateRole({ data: { user_id, role } });
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const isProtected = (r: AdminRow) =>
    r.user_id === meId || (r.email ?? "").startsWith("tech-197200@");

  async function remove(r: AdminRow) {
    if (isProtected(r)) return;
    if (!confirm(`Remove ${r.email ?? "this admin"}? This cannot be undone.`)) return;
    try {
      await removeAdmin({ data: { user_id: r.user_id } });
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = pageRows.every((r) => next.has(r.user_id) || isProtected(r));
      if (allSelected) pageRows.forEach((r) => next.delete(r.user_id));
      else
        pageRows.forEach((r) => {
          if (!isProtected(r)) next.add(r.user_id);
        });
      return next;
    });
  }

  async function bulkRemove() {
    const targets = allRows.filter((r) => selected.has(r.user_id) && !isProtected(r));
    if (targets.length === 0) return;
    if (
      !confirm(
        `Remove ${targets.length} admin${targets.length === 1 ? "" : "s"}? This cannot be undone.`,
      )
    )
      return;
    for (const t of targets) {
      try {
        await removeAdmin({ data: { user_id: t.user_id } });
      } catch (e) {
        console.error(e);
      }
    }
    await refresh();
  }

  async function sendBroadcast(e: React.FormEvent) {
    e.preventDefault();
    if (!bcTitle.trim()) return;
    setBcSending("sending");
    try {
      await broadcast({ data: { title: bcTitle, body: bcBody, severity: bcSeverity } });
      setBcTitle("");
      setBcBody("");
      setBcSeverity("info");
      setBcSending("sent");
      setTimeout(() => setBcSending(null), 2500);
    } catch (e) {
      console.error(e);
      setBcSending("error");
      setTimeout(() => setBcSending(null), 3000);
    }
  }

  async function sendDm(title: string, body: string, severity: NotificationSeverity) {
    if (!dmTarget) return;
    try {
      await sendDirect({ data: { recipient_id: dmTarget.user_id, title, body, severity } });
      setDmTarget(null);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      {/* Add admin */}
      <div className="rounded-xl border border-white/10 bg-[#0F172A] p-5">
        <h2 className="mb-1 text-sm font-semibold">Add team member</h2>
        <p className="mb-4 text-xs text-white/50">
          Create a new admin account with a role. Passwords must be at least 8 characters. The panel
          supports 20,000+ team members.
        </p>
        <form onSubmit={submit} className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <input
            required
            placeholder="Display name"
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]"
          />
          <input
            required
            type="email"
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]"
          />
          <input
            required
            type="password"
            minLength={8}
            placeholder="Password (min 8)"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]"
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as AppRole })}
            className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm"
          >
            <option value="viewer">Viewer (read-only)</option>
            <option value="admin">Admin (live control)</option>
            <option value="super_admin">Super admin</option>
          </select>
          <button
            disabled={busy}
            className="rounded bg-[#4F7CFF] px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Creating…" : "Add"}
          </button>
        </form>
        {err && (
          <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {err}
          </div>
        )}
      </div>

      {/* Broadcast */}
      <div className="rounded-xl border border-white/10 bg-[#0F172A] p-5">
        <h2 className="mb-1 text-sm font-semibold">Push notification to all admins</h2>
        <p className="mb-4 text-xs text-white/50">
          Sends to every admin&apos;s in-app bell instantly. Recipients with the browser
          Notification API enabled also get an OS-level toast when their tab is in the background.
        </p>
        <form onSubmit={sendBroadcast} className="grid grid-cols-1 gap-3 md:grid-cols-6">
          <input
            required
            placeholder="Title"
            value={bcTitle}
            onChange={(e) => setBcTitle(e.target.value)}
            maxLength={200}
            className="md:col-span-2 rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]"
          />
          <input
            placeholder="Body (optional)"
            value={bcBody}
            onChange={(e) => setBcBody(e.target.value)}
            maxLength={2000}
            className="md:col-span-2 rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]"
          />
          <select
            value={bcSeverity}
            onChange={(e) => setBcSeverity(e.target.value as NotificationSeverity)}
            className="rounded border border-white/10 bg-black/30 px-3 py-2 text-sm"
          >
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <button
            disabled={bcSending === "sending"}
            className="rounded bg-[#4F7CFF] px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {bcSending === "sending"
              ? "Sending…"
              : bcSending === "sent"
                ? "Sent ✓"
                : bcSending === "error"
                  ? "Failed"
                  : "Broadcast"}
          </button>
        </form>
      </div>

      {/* Team list */}
      <div className="rounded-xl border border-white/10 bg-[#0F172A]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">Team members</h2>
            <span className="text-xs text-white/40">{filtered.length.toLocaleString()} total</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              placeholder="Search name, email, role…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              className="w-64 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-[#4F7CFF]"
            />
            {selected.size > 0 && (
              <button onClick={bulkRemove} className="rounded bg-red-500/80 px-2 py-1 text-xs">
                Remove {selected.size}
              </button>
            )}
            <button
              onClick={refresh}
              className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5"
            >
              Refresh
            </button>
          </div>
        </div>
        {loading ? (
          <div className="p-5 text-sm text-white/50">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-5 text-sm text-white/50">No team members match.</div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-white/40">
                <tr>
                  <th className="px-4 py-2 text-left">
                    <input
                      type="checkbox"
                      checked={
                        pageRows.length > 0 &&
                        pageRows.every((r) => selected.has(r.user_id) || isProtected(r))
                      }
                      onChange={toggleAllVisible}
                    />
                  </th>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Email</th>
                  <th className="px-4 py-2 text-left">Role</th>
                  <th className="px-4 py-2 text-left">Created</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.user_id} className="border-t border-white/5">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        disabled={isProtected(r)}
                        checked={selected.has(r.user_id)}
                        onChange={() => toggleRow(r.user_id)}
                      />
                    </td>
                    <td className="px-4 py-3">{r.display_name ?? "—"}</td>
                    <td className="px-4 py-3 text-white/70">{r.email ?? "—"}</td>
                    <td className="px-4 py-3">
                      <select
                        value={r.role ?? ""}
                        disabled={isProtected(r)}
                        onChange={(e) => changeRole(r.user_id, e.target.value as AppRole)}
                        className="rounded border border-white/10 bg-black/30 px-2 py-1 text-xs disabled:opacity-50"
                      >
                        <option value="" disabled>
                          — none —
                        </option>
                        <option value="viewer">Viewer</option>
                        <option value="admin">Admin</option>
                        <option value="super_admin">Super admin</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-xs text-white/50">
                      {r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right space-x-2">
                      <button
                        onClick={() => setDmTarget(r)}
                        className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-white/5"
                      >
                        Notify
                      </button>
                      <button
                        onClick={() => remove(r)}
                        disabled={isProtected(r)}
                        title={isProtected(r) ? "Protected account" : "Remove"}
                        className="rounded border border-white/15 px-2 py-1 text-xs hover:bg-red-500/20 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between border-t border-white/5 px-4 py-3 text-xs text-white/50">
              <span>
                Page {page + 1} of {pageCount}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="rounded border border-white/15 px-2 py-1 disabled:opacity-40"
                >
                  Prev
                </button>
                <button
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded border border-white/15 px-2 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {dmTarget && (
        <DirectNotifyModal target={dmTarget} onClose={() => setDmTarget(null)} onSend={sendDm} />
      )}
    </div>
  );
}
