import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import videoAsset from "@/assets/connectlive.mp4.asset.json";
import bannerAsset from "@/assets/connectlive-banner.jpg.asset.json";
import { Footer } from "@/components/Footer";

const AGENT_DOWNLOAD_URL = "/downloads/ConnectLiveAgent.zip";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { title: "ConnectLive — Remote Support for Windows" },
      {
        name: "description",
        content:
          "Download ConnectLive for Windows and join your support session with a 6-digit meeting ID. Consent-based, transparent remote support.",
      },
      { property: "og:title", content: "ConnectLive — Remote Support for Windows" },
      {
        property: "og:description",
        content:
          "Download ConnectLive for Windows and join your support session with a 6-digit meeting ID.",
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

  // Live counter: paid orders → users on the platform.
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
        // trigger the real download
        window.location.href = AGENT_DOWNLOAD_URL;
        setTimeout(() => setInstallOpen(false), 800);
      }
    }, 60);
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#050B1F] text-[#1F2A44]">
      {/* Ambient space backdrop */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-30 bg-[radial-gradient(ellipse_at_top,#0B1740_0%,#050B1F_55%,#02040E_100%)]" />
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-20 opacity-70 [background-image:radial-gradient(1px_1px_at_20%_30%,#ffffff_50%,transparent_100%),radial-gradient(1px_1px_at_70%_80%,#c7d2fe_50%,transparent_100%),radial-gradient(1.5px_1.5px_at_40%_60%,#ffffff_50%,transparent_100%),radial-gradient(1px_1px_at_85%_20%,#a5b4fc_50%,transparent_100%),radial-gradient(1px_1px_at_10%_85%,#ffffff_50%,transparent_100%),radial-gradient(1px_1px_at_55%_15%,#e0e7ff_50%,transparent_100%)] [background-size:600px_600px] animate-[twinkle_6s_ease-in-out_infinite]" />
      <div aria-hidden className="pointer-events-none fixed -z-10 -left-40 top-1/4 h-[520px] w-[520px] rounded-full bg-[radial-gradient(circle,#4F7CFF_0%,transparent_65%)] opacity-40 blur-3xl animate-[drift_18s_ease-in-out_infinite]" />
      <div aria-hidden className="pointer-events-none fixed -z-10 -right-32 bottom-0 h-[600px] w-[600px] rounded-full bg-[radial-gradient(circle,#8B5CF6_0%,transparent_60%)] opacity-35 blur-3xl animate-[drift2_22s_ease-in-out_infinite]" />
      <div aria-hidden className="pointer-events-none fixed -z-10 left-1/3 -top-40 h-[420px] w-[420px] rounded-full bg-[radial-gradient(circle,#22D3EE_0%,transparent_60%)] opacity-25 blur-3xl animate-[drift_26s_ease-in-out_infinite_reverse]" />
      <div aria-hidden className="pointer-events-none fixed left-1/2 top-1/2 -z-10 h-[820px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#4F7CFF]/15 [box-shadow:inset_0_0_120px_rgba(79,124,255,0.15)] animate-[spin_60s_linear_infinite]" />
      <div aria-hidden className="pointer-events-none fixed left-1/2 top-1/2 -z-10 h-[640px] w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#8B5CF6]/10 animate-[spin_90s_linear_infinite_reverse]" />

      <style>{`
        @keyframes twinkle { 0%,100%{opacity:.55} 50%{opacity:.9} }
        @keyframes drift { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(60px,-40px) scale(1.08); } }
        @keyframes drift2 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-80px,30px) scale(1.12); } }
      `}</style>

      <main className="flex min-h-screen items-center justify-center px-4 py-16">
        <section className="w-full max-w-[560px] rounded-2xl bg-white p-10 text-center shadow-[0_4px_30px_rgba(31,42,68,0.08)]">
          <h1 className="text-[28px] font-semibold leading-tight text-[#1F2A44]">
            Join your session on
            <br />
            <span className="text-[#4F7CFF]">ConnectLive</span>
          </h1>

          <video
            src={videoAsset.url}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            className="mx-auto mt-8 w-full max-w-[220px] rounded-2xl shadow-[0_10px_30px_rgba(31,42,68,0.15)]"
          />

          {/* Live user counter */}
          {userCount !== null && (
            <div className="mt-6 inline-flex items-center gap-2 rounded-full bg-[#EEF3FF] px-3 py-1 text-[12px] font-medium text-[#4F7CFF]">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#4F7CFF]" />
              Currently trusted by {userCount.toLocaleString()} {userCount === 1 ? "user" : "users"}
            </div>
          )}

          <p className="mt-6 text-[15px] text-[#4B5568]">
            First, download the ConnectLive app.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              onClick={startDownload}
              className="rounded-lg bg-[#4F7CFF] px-4 py-3 text-[14px] font-semibold text-white shadow-sm transition-colors hover:bg-[#3E67E0]"
            >
              Download for Windows
              <div className="mt-0.5 text-[10px] font-normal opacity-80">64-bit installer</div>
            </button>
            <button
              disabled
              className="cursor-not-allowed rounded-lg border border-[#EEF0F6] bg-[#F7F8FC] px-4 py-3 text-[14px] font-semibold text-[#8792A6]"
            >
              Download for macOS
              <div className="mt-0.5 text-[10px] font-normal opacity-70">Coming soon</div>
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-[#8792A6]">
            <span>✓ Consent-based</span>
            <span>✓ Encrypted transport</span>
            <span>✓ No background install</span>
          </div>

          <div className="mt-6 rounded-lg bg-[#F3F5FA] p-4 text-left text-[13px] leading-relaxed text-[#4B5568]">
            <strong className="text-[#1F2A44]">Quick setup:</strong> open the downloaded application and enter your 6-digit meeting ID to join your session instantly. Your technician sees only what you approve.
          </div>

          <div className="mt-6">
            <img
              src={bannerAsset.url}
              alt="ConnectLive session preview"
              className="mx-auto block w-full rounded-xl"
            />
          </div>

          <div className="mt-6 flex items-center justify-center gap-3 text-[12px]">
            <Link
              to="/order"
              className="rounded-full border border-[#4F7CFF] px-4 py-1.5 font-semibold text-[#4F7CFF] hover:bg-[#4F7CFF]/5"
            >
              Buy a license
            </Link>
            <Link to="/admin" className="text-[#8792A6] hover:text-[#4F7CFF]" rel="nofollow">
              Technician sign-in
            </Link>
          </div>
        </section>
      </main>

      <Footer />

      {/* Download progress overlay */}
      {installOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#050B1F]/85 backdrop-blur-sm">
          <div className="w-[320px] rounded-2xl bg-white p-6 text-center shadow-2xl">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#4F7CFF]/10">
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
