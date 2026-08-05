import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  getMyPortal,
  removeMyDevice,
  changeMyPassword,
  getMyAlertSettings,
  saveMyAlertSettings,
  sendMyTelegramTest,
  listMyBookings,
  requestSupportSession,
  type PortalOverview,
  type PortalAlertSettings,
  type SupportBooking,
} from "@/lib/portal.functions";


export const Route = createFileRoute("/public/agent/portal")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/public/agent/login" });
    return { user: data.user };
  },
  component: PortalPage,
  head: () => ({
    meta: [
      { title: "Your ConnectLive licence — customer portal" },
      {
        name: "description",
        content:
          "Your ConnectLive Meeting ID, seat usage, enrolled devices, downloads and renewal.",
      },
      { property: "og:title", content: "Your ConnectLive licence" },
      {
        property: "og:description",
        content: "Meeting ID, seats, devices and renewal for your ConnectLive subscription.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

const card = "rounded-xl border border-white/10 bg-[#1F2A44] p-5";
const btn = "rounded-md bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/20";

function PortalPage() {
  const navigate = useNavigate();
  const load = useServerFn(getMyPortal);
  const remove = useServerFn(removeMyDevice);
  const changePw = useServerFn(changeMyPassword);

  const [data, setData] = useState<PortalOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setData((await load()) as PortalOverview);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load your licence");
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/public/agent/login" });
  };

  const lic = data?.license ?? null;
  const expiringSoon = lic ? lic.days_left <= 7 : false;

  return (
    <div className="min-h-screen bg-[#0F1626] text-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div>
          <h1 className="text-base font-semibold">ConnectLive customer portal</h1>
          <p className="text-xs text-white/50">{lic?.contact_email ?? ""}</p>
        </div>
        <button onClick={signOut} className={btn}>
          Sign out
        </button>
      </header>

      <main className="mx-auto grid max-w-4xl gap-5 p-5">
        {err && (
          <div className="rounded-md border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-200">
            {err}
          </div>
        )}

        {!lic && !err && (
          <div className={card}>
            <p className="text-sm text-white/70">
              No licence is attached to this account yet. If you have just paid, our team will
              activate it shortly —{" "}
              <Link to="/contact" className="text-[#4F7CFF] hover:underline">
                contact support
              </Link>{" "}
              if it has been more than an hour.
            </p>
          </div>
        )}

        {lic && (
          <>
            {expiringSoon && (
              <div className="rounded-md border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                {lic.days_left > 0
                  ? `Your subscription renews in ${lic.days_left} day${lic.days_left === 1 ? "" : "s"}. Renew to keep your devices connected.`
                  : "Your subscription has expired — devices are dormant until you renew."}
              </div>
            )}

            <section className={card}>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-white/50">
                Your Meeting ID
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <code className="rounded-md bg-black/30 px-3 py-2 font-mono text-lg tracking-widest">
                  {lic.meeting_id}
                </code>
                <button
                  className={btn}
                  onClick={async () => {
                    await navigator.clipboard.writeText(lic.meeting_id);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-xs text-white/50">
                The agent asks for this once, the first time it runs on each machine.
              </p>
            </section>

            <section className={`${card} grid gap-4 sm:grid-cols-4`}>
              <Stat label="Plan" value={lic.plan_code ?? "Custom"} />
              <Stat label="Seats used" value={`${lic.seats_used} / ${lic.seat_limit}`} />
              <Stat label="Status" value={lic.status} />
              <Stat
                label="Renews"
                value={new Date(lic.expires_at).toLocaleDateString()}
                sub={`${Math.max(lic.days_left, 0)} days left`}
              />
            </section>

            <section className={card}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Devices</h2>
                <button className={btn} onClick={refresh}>
                  Refresh
                </button>
              </div>
              {data?.devices.length === 0 ? (
                <p className="text-xs text-white/50">
                  No devices yet. Install the agent and enter your Meeting ID.
                </p>
              ) : (
                <ul className="space-y-2">
                  {data?.devices.map((d) => (
                    <li
                      key={d.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/20 px-3 py-2 text-xs"
                    >
                      <div>
                        <div className="font-medium">
                          {d.display_name ?? d.hostname ?? d.device_id}
                        </div>
                        <div className="text-white/40">
                          {d.os ?? "Windows"} ·{" "}
                          {d.last_seen_at
                            ? `seen ${new Date(d.last_seen_at).toLocaleString()}`
                            : "never seen"}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={
                            d.license_state === "blocked" || d.license_state === "expired"
                              ? "text-amber-200"
                              : d.status === "online"
                                ? "text-green-300"
                                : "text-white/40"
                          }
                        >
                          {d.license_state === "blocked"
                            ? "needs a seat"
                            : d.license_state === "expired"
                              ? "subscription expired"
                              : d.status}
                        </span>
                        <button
                          className={btn}
                          disabled={busy}
                          onClick={async () => {
                            if (!confirm("Remove this device and free its seat?")) return;
                            setBusy(true);
                            try {
                              await remove({ data: { device_id: d.id } });
                              await refresh();
                            } catch (e) {
                              setErr(e instanceof Error ? e.message : "Remove failed");
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={card}>
              <h2 className="mb-2 text-sm font-semibold">Renew or add seats</h2>
              <p className="mb-3 text-xs text-white/50">
                Payment is confirmed on-chain and applied to this same Meeting ID — your devices
                stay enrolled.
              </p>
              <Link
                to="/order"
                className="inline-block rounded-md bg-[#4F7CFF] px-4 py-2 text-xs font-semibold text-white"
              >
                Start a renewal order
              </Link>
            </section>

            <section className={card}>
              <h2 className="mb-2 text-sm font-semibold">Change password</h2>
              <div className="flex flex-wrap gap-2">
                <input
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="New password (min 8 characters)"
                  className="min-w-[220px] flex-1 rounded-md border border-white/10 bg-[#0F1626] px-3 py-2 text-sm outline-none focus:border-[#4F7CFF]"
                />
                <button
                  className={btn}
                  disabled={busy || pw.length < 8}
                  onClick={async () => {
                    setBusy(true);
                    setMsg(null);
                    try {
                      await changePw({ data: { password: pw } });
                      setPw("");
                      setMsg("Password updated.");
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : "Update failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Update
                </button>
              </div>
              {msg && <p className="mt-2 text-xs text-green-300">{msg}</p>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-white/50">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
      {sub && <div className="text-[11px] text-white/40">{sub}</div>}
    </div>
  );
}
