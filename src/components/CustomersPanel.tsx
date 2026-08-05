import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  listLicenses,
  listLicenseDevices,
  createLicense,
  updateLicense,
  resetCustomerPassword,
  type LicenseListRow,
} from "@/lib/licenses.functions";

type DeviceRow = {
  id: string;
  device_id: string;
  display_name: string | null;
  hostname: string | null;
  os: string | null;
  status: string;
  license_state: string;
  last_seen_at: string | null;
};

const field =
  "w-full rounded-md border border-white/10 bg-[#0F1626] px-3 py-2 text-sm text-white outline-none focus:border-[#4F7CFF]";
const label = "mb-1 block text-[11px] uppercase tracking-wide text-white/50";

const genPassword = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 54])
    .join("");

/** Super-admin: customer licenses (Meeting ID, seats, term, portal account). */
export function CustomersPanel({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const load = useServerFn(listLicenses);
  const loadDevices = useServerFn(listLicenseDevices);
  const create = useServerFn(createLicense);
  const update = useServerFn(updateLicense);
  const resetPw = useServerFn(resetCustomerPassword);

  const [rows, setRows] = useState<LicenseListRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({
    contact_email: "",
    contact_name: "",
    company: "",
    seat_limit: 10,
    months: 1,
    password: "",
  });

  const refresh = async () => {
    try {
      setRows((await load()) as LicenseListRow[]);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to load licenses");
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    setDevices((await loadDevices({ data: { license_id: id } })) as DeviceRow[]);
  };

  const onCreate = async () => {
    if (!form.contact_email) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = (await create({
        data: {
          contact_email: form.contact_email,
          contact_name: form.contact_name || undefined,
          company: form.company || undefined,
          seat_limit: Number(form.seat_limit),
          months: Number(form.months),
          password: form.password || undefined,
        },
      })) as { meeting_id: string; account_created: boolean };
      setMsg(
        `License ${r.meeting_id} created${
          r.account_created ? ` — portal password: ${form.password} (copy it now)` : ""
        }`,
      );
      setForm({ ...form, contact_email: "", contact_name: "", company: "", password: "" });
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, data: Record<string, unknown>) => {
    setBusy(true);
    try {
      await update({ data: { id, ...data } as never });
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  if (!isSuperAdmin) return <div className="text-xs text-white/50">Super-admin only.</div>;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-white/10 bg-[#1F2A44] p-4">
        <h3 className="mb-1 text-sm font-semibold text-white">Provision a customer</h3>
        <p className="mb-4 text-[11px] text-white/50">
          Mints a permanent Meeting ID, the seat allowance and the subscription window. Add a
          password to create their portal account at the same time.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="md:col-span-2">
            <span className={label}>Customer email</span>
            <input
              className={field}
              value={form.contact_email}
              onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
              placeholder="ops@customer.com"
            />
          </div>
          <div>
            <span className={label}>Contact name</span>
            <input
              className={field}
              value={form.contact_name}
              onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
            />
          </div>
          <div>
            <span className={label}>Company</span>
            <input
              className={field}
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
            />
          </div>
          <div>
            <span className={label}>Seats</span>
            <select
              className={field}
              value={form.seat_limit}
              onChange={(e) => setForm({ ...form, seat_limit: Number(e.target.value) })}
            >
              <option value={10}>10 devices</option>
              <option value={20}>20 devices</option>
              <option value={50}>50 devices</option>
            </select>
          </div>
          <div>
            <span className={label}>Term (months)</span>
            <input
              className={field}
              type="number"
              min={1}
              value={form.months}
              onChange={(e) => setForm({ ...form, months: Number(e.target.value) })}
            />
          </div>
          <div className="md:col-span-3">
            <span className={label}>Portal password (optional)</span>
            <div className="flex gap-2">
              <input
                className={field}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="leave blank to create the license without an account"
              />
              <button
                onClick={() => setForm({ ...form, password: genPassword() })}
                className="whitespace-nowrap rounded-md bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/20"
              >
                Generate
              </button>
            </div>
          </div>
        </div>
        <button
          onClick={onCreate}
          disabled={busy || !form.contact_email}
          className="mt-4 rounded-md bg-[#4F7CFF] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          Create license
        </button>
        {msg && (
          <div className="mt-3 rounded-md bg-white/5 px-3 py-2 text-xs text-white/80">{msg}</div>
        )}
      </section>

      <section className="rounded-lg border border-white/10 bg-[#1F2A44] p-4">
        <h3 className="mb-3 text-sm font-semibold text-white">Licenses</h3>
        {rows.length === 0 ? (
          <p className="text-xs text-white/50">No licenses yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="text-white/40">
                <tr>
                  <th className="py-2">Meeting ID</th>
                  <th>Customer</th>
                  <th>Seats</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody className="text-white/80">
                {rows.map((l) => {
                  const expired = new Date(l.expires_at).getTime() < Date.now();
                  return (
                    <tr key={l.id} className="border-t border-white/5 align-top">
                      <td className="py-2 font-mono">{l.meeting_id}</td>
                      <td>
                        <div>{l.contact_email}</div>
                        <div className="text-white/40">{l.company ?? l.contact_name ?? "—"}</div>
                        {!l.user_id && <div className="text-amber-200">no portal account</div>}
                      </td>
                      <td className={l.seats_used > l.seat_limit ? "text-red-300" : ""}>
                        {l.seats_used}/{l.seat_limit}
                      </td>
                      <td className={expired ? "text-red-300" : "text-white/70"}>
                        {new Date(l.expires_at).toLocaleDateString()}
                      </td>
                      <td>{l.status}</td>
                      <td className="space-x-1 text-right whitespace-nowrap">
                        <button
                          onClick={() => toggle(l.id)}
                          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20"
                        >
                          Devices
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => patch(l.id, { extend_months: 1 })}
                          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-50"
                        >
                          +1 month
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => {
                            const n = prompt("New seat limit", String(l.seat_limit));
                            if (n) patch(l.id, { seat_limit: Number(n) });
                          }}
                          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-50"
                        >
                          Seats
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            patch(l.id, {
                              status: l.status === "active" ? "suspended" : "active",
                            })
                          }
                          className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-50"
                        >
                          {l.status === "active" ? "Suspend" : "Restore"}
                        </button>
                        {l.user_id && (
                          <button
                            disabled={busy}
                            onClick={async () => {
                              const pw = genPassword();
                              if (!confirm(`Set new portal password to:\n\n${pw}\n\nProceed?`)) return;
                              await resetPw({ data: { license_id: l.id, password: pw } });
                              setMsg(`New password for ${l.contact_email}: ${pw}`);
                            }}
                            className="rounded bg-white/10 px-2 py-1 hover:bg-white/20 disabled:opacity-50"
                          >
                            Reset pw
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {open && (
          <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-white/50">
              Devices on this license
            </div>
            {devices.length === 0 ? (
              <p className="text-xs text-white/50">No devices enrolled yet.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {devices.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.display_name ?? d.hostname ?? d.device_id}</span>
                    <span className="text-white/40">{d.os ?? ""}</span>
                    <span
                      className={
                        d.license_state === "active"
                          ? "text-green-300"
                          : d.license_state === "unlicensed"
                            ? "text-white/40"
                            : "text-amber-200"
                      }
                    >
                      {d.license_state}
                    </span>
                    <span className="text-white/40">
                      {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never seen"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
