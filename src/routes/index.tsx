import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Monitor,
  MousePointerClick,
  Activity,
  LifeBuoy,
  Video,
  Lock,
  Receipt,
  Users,
  ShieldCheck,
  Download,
  CheckCircle2,
} from "lucide-react";
import videoAsset from "@/assets/connectlive.mp4.asset.json";
import bannerAsset from "@/assets/connectlive-banner.jpg.asset.json";
import { Footer } from "@/components/Footer";

const AGENT_DOWNLOAD_URL = "/downloads/ConnectLiveAgent.zip";

type Dept = "all" | "it" | "helpdesk" | "finance" | "hr" | "sales";

type Tool = {
  id: string;
  title: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  depts: Exclude<Dept, "all">[];
  action: "download" | "checkout";
};

const TOOLS: Tool[] = [
  { id: "screen-share", title: "Live Screen Share", desc: "Consent-based screen viewing with a persistent on-screen indicator.", icon: Monitor, depts: ["it", "helpdesk"], action: "download" },
  { id: "remote-access", title: "Remote Access", desc: "Take control of an endpoint after the user approves the session.", icon: MousePointerClick, depts: ["it", "helpdesk"], action: "download" },
  { id: "diagnostics", title: "Device Diagnostics", desc: "Inspect device health, uptime, and network status in real time.", icon: Activity, depts: ["it"], action: "download" },
  { id: "ticketing", title: "Help Desk Ticketing", desc: "Attach live sessions to tickets and keep a full audit trail.", icon: LifeBuoy, depts: ["helpdesk", "hr", "sales"], action: "download" },
  { id: "recording", title: "Session Recording", desc: "Optional recording with consent for training and compliance.", icon: Video, depts: ["it", "helpdesk"], action: "download" },
  { id: "team", title: "Team Directory", desc: "Route sessions to the right department in one click.", icon: Users, depts: ["it", "helpdesk", "hr", "sales"], action: "download" },
  { id: "checkout", title: "Secure Checkout", desc: "Purchase or renew a ConnectLive license.", icon: Lock, depts: ["finance"], action: "checkout" },
  { id: "billing", title: "Account Billing", desc: "Review invoices and subscription status.", icon: Receipt, depts: ["finance"], action: "checkout" },
];

const DEPTS: { id: Dept; label: string }[] = [
  { id: "all", label: "All departments" },
  { id: "it", label: "IT Admin" },
  { id: "helpdesk", label: "Help Desk" },
  { id: "finance", label: "Finance" },
  { id: "hr", label: "HR" },
  { id: "sales", label: "Sales" },
];

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { title: "ConnectLive — Remote Support Platform for IT, Help Desk & Finance" },
      {
        name: "description",
        content:
          "ConnectLive is a modular remote-support platform. Consent-based screen sharing, remote access, ticketing, and secure billing in one workspace.",
      },
      { property: "og:title", content: "ConnectLive — Remote Support Platform" },
      {
        property: "og:description",
        content:
          "Modular remote-support workspace for IT, Help Desk, HR, Finance, and Sales teams.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

function Home() {
  const [installOpen, setInstallOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [userCount, setUserCount] = useState<number | null>(null);
  const [dept, setDept] = useState<Dept>("all");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/public/stats/orders");
        if (!res.ok) return;
        const j = (await res.json()) as { paid: number };
        if (alive) setUserCount(j.paid);
      } catch {
        /* silent */
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const startDownload = () => {
    if (installOpen) return;
    setInstallOpen(true);
    setProgress(0);
    const started = Date.now();
    const iv = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - started) / 5000) * 100);
      setProgress(pct);
      if (pct >= 100) {
        clearInterval(iv);
        window.location.href = AGENT_DOWNLOAD_URL;
        setTimeout(() => setInstallOpen(false), 800);
      }
    }, 60);
  };

  const filteredTools = useMemo(
    () => (dept === "all" ? TOOLS : TOOLS.filter((t) => t.depts.includes(dept))),
    [dept],
  );

  return (
    <div className="min-h-screen bg-[#F7F8FC] font-sans text-[#1F2A44] antialiased">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-[#E6E9F2] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-[#4F7CFF] text-white">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <span className="text-[15px] font-semibold tracking-tight">ConnectLive</span>
            <span className="ml-3 hidden items-center gap-1.5 rounded-full bg-[#EAF7EF] px-2 py-0.5 text-[11px] font-medium text-[#227A44] sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-[#22C55E]" />
              All systems operational
            </span>
          </div>
          <Link
            to="/admin"
            rel="nofollow"
            className="rounded-md border border-[#E6E9F2] bg-white px-3 py-1.5 text-[13px] font-medium text-[#1F2A44] hover:border-[#4F7CFF] hover:text-[#4F7CFF]"
          >
            Sign in
          </Link>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Sidebar */}
        <aside className="lg:sticky lg:top-20 lg:h-fit">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8792A6]">
            Departments
          </div>
          <nav className="mt-3 flex flex-wrap gap-2 lg:flex-col">
            {DEPTS.map((d) => {
              const active = dept === d.id;
              return (
                <button
                  key={d.id}
                  onClick={() => setDept(d.id)}
                  className={`rounded-lg px-3 py-2 text-left text-[13px] font-medium transition ${
                    active
                      ? "bg-[#4F7CFF] text-white shadow-sm"
                      : "bg-white text-[#1F2A44] hover:bg-[#EEF3FF] hover:text-[#4F7CFF]"
                  } border border-transparent`}
                >
                  {d.label}
                </button>
              );
            })}
          </nav>

          <div className="mt-6 hidden rounded-xl border border-[#E6E9F2] bg-white p-4 lg:block">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8792A6]">
              Trust
            </div>
            <ul className="mt-2 space-y-1.5 text-[12px] text-[#4B5568]">
              <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-[#22C55E]" />Consent-based</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-[#22C55E]" />Encrypted transport</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-[#22C55E]" />No background install</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-[#22C55E]" />Full audit trail</li>
            </ul>
          </div>
        </aside>

        {/* Main */}
        <main className="min-w-0">
          {/* Hero */}
          <section className="grid grid-cols-1 gap-6 rounded-2xl border border-[#E6E9F2] bg-white p-6 sm:p-8 md:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              {userCount !== null && (
                <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-[#EEF3FF] px-3 py-1 text-[11px] font-medium text-[#4F7CFF]">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-[#4F7CFF]" />
                  Trusted by {userCount.toLocaleString()} {userCount === 1 ? "user" : "users"}
                </div>
              )}
              <h1 className="text-[26px] font-bold leading-tight tracking-tight text-[#1F2A44] sm:text-[32px]">
                One workspace for remote support,
                <br className="hidden sm:block" /> across every department.
              </h1>
              <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-[#4B5568]">
                ConnectLive brings live screen sharing, remote access, ticketing, and secure
                billing into a single, consent-based platform your team can trust.
              </p>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  onClick={startDownload}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#4F7CFF] px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-[#3E67E0]"
                >
                  <Download className="h-4 w-4" />
                  Download for Windows
                  <span className="ml-1 rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-normal">64-bit</span>
                </button>
                <button
                  disabled
                  className="inline-flex cursor-not-allowed items-center gap-2 rounded-lg border border-[#E6E9F2] bg-[#F3F5FA] px-4 py-2.5 text-[13px] font-semibold text-[#8792A6]"
                >
                  <Download className="h-4 w-4" />
                  Download for macOS
                  <span className="ml-1 rounded bg-[#E6E9F2] px-1.5 py-0.5 text-[10px] font-normal">Coming soon</span>
                </button>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#8792A6]">
                <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-[#22C55E]" />Consent-based</span>
                <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-[#22C55E]" />Encrypted transport</span>
                <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-[#22C55E]" />No background install</span>
              </div>
            </div>

            <div className="flex items-center justify-center md:pl-6">
              <video
                src={videoAsset.url}
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
                className="w-full max-w-[220px] rounded-2xl shadow-[0_10px_30px_rgba(31,42,68,0.12)]"
              />
            </div>
          </section>

          {/* Tool grid */}
          <section className="mt-8">
            <div className="mb-3 flex items-end justify-between">
              <div>
                <h2 className="text-[16px] font-semibold text-[#1F2A44]">Tools</h2>
                <p className="text-[12px] text-[#8792A6]">
                  {dept === "all" ? "All available modules" : `Prioritised for ${DEPTS.find((d) => d.id === dept)?.label}`}
                </p>
              </div>
              <span className="text-[12px] text-[#8792A6]">{filteredTools.length} modules</span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTools.map((tool) => (
                <ToolCard
                  key={tool.id}
                  tool={tool}
                  onDownload={startDownload}
                />
              ))}
            </div>
          </section>

          {/* Banner */}
          <section className="mt-8 overflow-hidden rounded-2xl border border-[#E6E9F2] bg-white p-2">
            <img
              src={bannerAsset.url}
              alt="ConnectLive session preview"
              className="mx-auto block w-full rounded-xl"
              loading="lazy"
            />
          </section>

          {/* Quick setup */}
          <section className="mt-6 rounded-xl border border-[#E6E9F2] bg-white p-5 text-[13px] leading-relaxed text-[#4B5568]">
            <strong className="text-[#1F2A44]">Quick setup:</strong> download ConnectLive, open the
            application, and enter your 6-digit meeting ID to join. Your technician sees only what
            you approve.
          </section>
        </main>
      </div>

      <Footer />

      {installOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#050B1F]/60 backdrop-blur-sm">
          <div className="w-[320px] rounded-2xl bg-white p-6 text-center shadow-2xl">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-[#4F7CFF]/10">
              <span className="inline-block h-4 w-4 animate-pulse rounded-full bg-[#4F7CFF]" />
            </div>
            <div className="text-[15px] font-semibold text-[#1F2A44]">Preparing ConnectLive</div>
            <div className="mt-1 text-[12px] text-[#8792A6]">Your download will start automatically…</div>
            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-[#EEF0F6]">
              <div
                className="h-full rounded-full bg-[#4F7CFF] transition-[width] duration-100 ease-linear"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] text-[#8792A6]">{Math.round(progress)}%</div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCard({ tool, onDownload }: { tool: Tool; onDownload: () => void }) {
  const Icon = tool.icon;
  const isCheckout = tool.action === "checkout";

  const body = (
    <div className="group relative flex h-full flex-col rounded-xl border border-[#E6E9F2] bg-white p-4 text-left transition hover:-translate-y-0.5 hover:border-[#4F7CFF]/40 hover:shadow-[0_8px_24px_rgba(31,42,68,0.08)]">
      <div className="flex items-start justify-between">
        <div className={`grid h-10 w-10 place-items-center rounded-lg ${isCheckout ? "bg-[#EAF7EF] text-[#227A44]" : "bg-[#EEF3FF] text-[#4F7CFF]"}`}>
          <Icon className="h-5 w-5" />
        </div>
        <span className="rounded-full border border-[#E6E9F2] px-2 py-0.5 text-[10px] font-medium text-[#8792A6]">
          {isCheckout ? "Billing" : "Module"}
        </span>
      </div>
      <div className="mt-3 text-[14px] font-semibold text-[#1F2A44]">{tool.title}</div>
      <div className="mt-1 text-[12px] leading-relaxed text-[#4B5568]">{tool.desc}</div>
      <div className="mt-4 inline-flex items-center gap-1 text-[12px] font-medium text-[#4F7CFF] group-hover:gap-1.5">
        {isCheckout ? "Open" : "Requires ConnectLive agent"} <span aria-hidden>→</span>
      </div>
    </div>
  );

  if (isCheckout) {
    return (
      <Link to="/order" className="block h-full">
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onDownload} className="block h-full w-full">
      {body}
    </button>
  );
}
