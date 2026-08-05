import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Footer } from "@/components/Footer";
import heroFloat1 from "@/assets/hero-float-1.png";
import heroFloat2 from "@/assets/hero-float-2.png";
import heroFloat3 from "@/assets/hero-float-3.png";
import videoAsset from "@/assets/connectlive.mp4.asset.json";
import bannerAsset from "@/assets/connectlive-banner.jpg.asset.json";

type PlanCard = {
  code: string;
  name: string;
  devices: string;
  price: string;
  period?: string;
  blurb: string;
  cta: string;
  href: string;
  featured?: boolean;
};

const PLAN_CARDS: PlanCard[] = [
  {
    code: "starter",
    name: "Starter",
    devices: "10 desktop devices",
    price: "$250",
    period: "/month",
    blurb: "Small teams getting remote support off the ground.",
    cta: "Order Starter",
    href: "/order",
  },
  {
    code: "team",
    name: "Team",
    devices: "20 desktop devices",
    price: "$570",
    period: "/month",
    blurb: "Growing help desks with multi-department coverage.",
    cta: "Order Team",
    href: "/order",
    featured: true,
  },
  {
    code: "business",
    name: "Business",
    devices: "50 desktop devices",
    price: "$840",
    period: "/month",
    blurb: "SMB fleets with priority response and full audit trail.",
    cta: "Order Business",
    href: "/order",
  },
  {
    code: "custom",
    name: "Custom",
    devices: "Unlimited devices",
    price: "Talk to us",
    blurb: "Enterprise fleets — manual order handled by our team.",
    cta: "Request Custom",
    href: "/contact",
  },
];


const FEATURE_STRIP = [
  "Consent-based",
  "Curtain mode",
  "Sub-50ms WebRTC",
  "Multi-monitor precision",
  "SYSTEM service",
  "Encrypted transport",
  "Full audit trail",
];

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { title: "ConnectLive — Cinematic Remote Support Platform" },
      {
        name: "description",
        content:
          "ConnectLive is a consent-based remote-support platform for IT, help desks, and enterprise fleets. Sub-50ms sessions, curtain mode, and a full audit trail.",
      },
      { property: "og:title", content: "ConnectLive — Remote Support Platform" },
      {
        property: "og:description",
        content:
          "Consent-based remote support for 10 to unlimited devices. Cinematic, secure, minimal.",
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: bannerAsset.url },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: bannerAsset.url },
    ],
  }),
});

function Home() {
  const navigate = useNavigate();
  const [userCount, setUserCount] = useState<number | null>(null);
  const [orderId, setOrderId] = useState("");

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

  const trackOrder = (e: React.FormEvent) => {
    e.preventDefault();
    const v = orderId.trim();
    if (!v) return;
    navigate({ to: "/order/$id", params: { id: v } });
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0B1024] font-sans text-white antialiased">
      {/* Cinematic moonstone background */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_20%_-10%,rgba(160,190,240,0.28),transparent_60%),radial-gradient(900px_500px_at_90%_10%,rgba(120,150,220,0.22),transparent_60%),radial-gradient(700px_500px_at_50%_110%,rgba(190,210,255,0.18),transparent_60%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,#0B1024_0%,#0E1734_45%,#0B1024_100%)]" />
        <div className="absolute inset-0 opacity-[0.06] [background-image:radial-gradient(#ffffff_1px,transparent_1px)] [background-size:22px_22px]" />
      </div>

      <FloatingArt />

      {/* Top bar */}
      <header className="relative z-10 mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/15">
            <img src={heroFloat2} alt="" className="h-9 w-9 object-cover" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight">ConnectLive</span>
          <span className="ml-3 hidden items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-white/10 sm:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            All systems operational
          </span>
        </div>
        {userCount !== null && (
          <div className="hidden items-center gap-2 rounded-full bg-white/5 px-3 py-1 text-[11px] font-medium text-white/70 ring-1 ring-white/10 sm:inline-flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#8FB4FF]" />
            {userCount.toLocaleString()} {userCount === 1 ? "session" : "sessions"} delivered
          </div>
        )}
      </header>

      {/* Hero — split: copy + device mockup */}
      <section className="relative z-10 mx-auto grid max-w-7xl gap-10 px-4 pt-8 pb-14 sm:px-6 sm:pt-14 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
        <div className="flex flex-col justify-center">
          {userCount !== null && (
            <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-full bg-[#4F7CFF]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.15em] text-[#8FB4FF] ring-1 ring-[#4F7CFF]/30 backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Trusted by {userCount.toLocaleString()} operators
            </div>
          )}
          <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            <span className="bg-gradient-to-b from-white via-[#DCE7FF] to-[#8FB4FF] bg-clip-text text-transparent">
              Remote support,
            </span>
            <br />
            <span className="bg-gradient-to-b from-[#B8CCFF] via-[#7FA1E8] to-[#4F7CFF] bg-clip-text text-transparent">
              rendered in moonlight.
            </span>
          </h1>
          <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-white/70">
            A consent-based platform for IT, help desks, and enterprise fleets. Sub-50ms sessions,
            curtain mode, and a full audit trail — delivered within 24 hours.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to="/order"
              className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-[13px] font-semibold text-[#0B1024] shadow-[0_10px_40px_-10px_rgba(143,180,255,0.6)] transition hover:bg-[#EAF0FF]"
            >
              Order a license →
            </Link>
            <a
              href="#plans"
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-[13px] font-semibold text-white/90 backdrop-blur transition hover:bg-white/10"
            >
              See plans
            </a>
            <Link
              to="/license"
              className="inline-flex items-center gap-2 rounded-xl px-3 py-3 text-[13px] font-medium text-white/60 transition hover:text-white"
            >
              Have a license? Look it up →
            </Link>
          </div>

          {/* Order tracker */}
          <form
            onSubmit={trackOrder}
            className="mt-8 flex max-w-md items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-1.5 backdrop-blur"
          >
            <input
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              placeholder="Track order — paste your order ID"
              className="flex-1 rounded-xl bg-transparent px-3 py-2 text-[13px] text-white placeholder:text-white/40 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-xl bg-[#4F7CFF] px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-[#3E67E0]"
            >
              Track
            </button>
          </form>
        </div>

        {/* Product device mockup with looping video */}
        <DeviceMockup />
      </section>

      {/* Feature marquee */}
      <div className="relative z-10 border-y border-white/5 bg-white/[0.02] py-4 backdrop-blur">
        <div className="marquee-wrap flex overflow-hidden">
          <div className="marquee flex shrink-0 items-center gap-10 whitespace-nowrap px-6">
            {[...FEATURE_STRIP, ...FEATURE_STRIP].map((f, i) => (
              <span
                key={i}
                className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40"
              >
                <span className="h-1 w-1 rounded-full bg-[#4F7CFF]" />
                {f}
              </span>
            ))}
          </div>
        </div>
        <style>{`
          @keyframes cl-marquee { from{transform:translateX(0)} to{transform:translateX(-50%)} }
          .marquee-wrap { mask-image: linear-gradient(to right, transparent, black 8%, black 92%, transparent); }
          .marquee { animation: cl-marquee 32s linear infinite; }
        `}</style>
      </div>

      {/* Deployment tracker band */}
      <section className="relative z-10 mx-auto max-w-7xl px-4 pt-14 sm:px-6">
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur sm:p-8">
          <div className="mb-6 flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#8FB4FF]">
              Instance deployment
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#4F7CFF]/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-[#8FB4FF] ring-1 ring-[#4F7CFF]/30">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#4F7CFF]" />
              Live
            </span>
          </div>
          <div className="relative">
            <div className="absolute left-0 right-0 top-3 h-px bg-white/10" />
            <div className="absolute left-0 top-3 h-px w-2/3 bg-[#4F7CFF] shadow-[0_0_10px_#4F7CFF]" />
            <div className="relative z-10 grid grid-cols-3 gap-2">
              {[
                { label: "Order", done: true },
                { label: "Provision", active: true },
                { label: "Activate", done: false },
              ].map((s) => (
                <div key={s.label} className="flex flex-col items-center gap-2">
                  <div
                    className={`grid h-6 w-6 place-items-center rounded-full border-4 border-[#0B1024] ${
                      s.done
                        ? "bg-[#4F7CFF]"
                        : s.active
                          ? "bg-[#4F7CFF] animate-pulse"
                          : "bg-slate-700"
                    }`}
                  >
                    {s.done && (
                      <svg
                        className="h-2.5 w-2.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="white"
                        strokeWidth="3"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <span
                    className={`text-[11px] font-semibold ${s.done || s.active ? "text-white" : "text-white/40"}`}
                  >
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Plan cards */}
      <section id="plans" className="relative z-10 mx-auto max-w-7xl px-4 pt-14 pb-16 sm:px-6">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h2 className="text-[22px] font-semibold tracking-tight sm:text-3xl">
              Choose your surface area
            </h2>
            <p className="mt-1 text-[13px] text-white/60">
              From ten devices to unlimited fleets. Custom is handled by our team directly.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_CARDS.map((p, i) => (
            <PlanCardView key={p.code} plan={p} index={i} />
          ))}
        </div>
      </section>

      {/* Ambient banner */}
      <section className="relative z-10 mx-auto max-w-7xl px-4 pb-20 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] shadow-[0_30px_80px_-30px_rgba(79,124,255,0.35)]">
          <img
            src={bannerAsset.url}
            alt="ConnectLive multi-participant collaboration surface"
            className="h-56 w-full object-cover opacity-90 sm:h-80"
            loading="lazy"
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0B1024] via-[#0B1024]/40 to-transparent" />
          <div className="absolute bottom-0 left-0 p-6 sm:p-8">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8FB4FF]">
              Enterprise ready
            </div>
            <div className="mt-1 max-w-xl text-lg font-semibold sm:text-2xl">
              One surface for every department — IT, help desk, finance, HR.
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

function DeviceMockup() {
  return (
    <div className="relative flex items-center justify-center">
      {/* Ambient glow */}
      <div
        aria-hidden
        className="absolute -inset-6 rounded-[36px] bg-gradient-to-tr from-[#4F7CFF]/25 via-[#8FB4FF]/15 to-transparent blur-2xl"
      />
      <div className="relative w-full max-w-md rounded-[28px] border border-white/10 bg-[#0D1430]/80 p-2 shadow-[0_40px_80px_-30px_rgba(79,124,255,0.5)] backdrop-blur">
        <div className="overflow-hidden rounded-[22px] border border-white/5 bg-[#050814]">
          {/* window chrome */}
          <div className="flex items-center justify-between border-b border-white/5 bg-white/5 px-4 py-2">
            <div className="flex gap-1.5">
              <span className="h-2 w-2 rounded-full bg-red-400/60" />
              <span className="h-2 w-2 rounded-full bg-yellow-400/60" />
              <span className="h-2 w-2 rounded-full bg-emerald-400/60" />
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-white/40">
              Live session · 882-CL
            </div>
            <div className="rounded bg-[#4F7CFF]/20 px-2 py-0.5 text-[9px] font-bold text-[#B8CCFF] ring-1 ring-[#4F7CFF]/40">
              CURTAIN
            </div>
          </div>

          {/* video with cursor telemetry overlay */}
          <div className="relative aspect-video bg-black">
            <img
              src={orbAsset.url}
              alt="ConnectLive live session orb animation"
              loading="lazy"
              decoding="async"
              className="h-full w-full object-contain opacity-95"
            />

            {/* Cursor telemetry */}
            <div className="absolute left-[38%] top-[42%] text-[#8FB4FF] drop-shadow-[0_0_6px_rgba(143,180,255,0.9)]">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M5.23 3l15.43 12.83-6.5 1.15 3.53 7.02-2.5 1.25-3.53-7.02-6.43 5.4V3z" />
              </svg>
            </div>
            {/* HUD */}
            <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between">
              <div className="rounded-lg border border-white/10 bg-black/50 px-2.5 py-1.5 backdrop-blur">
                <div className="text-[9px] uppercase tracking-widest text-white/50">Latency</div>
                <div className="font-mono text-sm text-white">42 ms</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/50 px-2.5 py-1.5 backdrop-blur">
                <div className="text-[9px] uppercase tracking-widest text-white/50">Encoder</div>
                <div className="font-mono text-sm text-white">H.264 · HW</div>
              </div>
            </div>
          </div>
        </div>
        {/* Under-panel telemetry */}
        <div className="grid grid-cols-3 gap-2 p-3">
          {[
            { k: "FPS", v: "60" },
            { k: "Uplink", v: "3.4 Mb/s" },
            { k: "P2P", v: "WebRTC" },
          ].map((m) => (
            <div key={m.k} className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2">
              <div className="text-[9px] uppercase tracking-widest text-white/40">{m.k}</div>
              <div className="mt-0.5 font-mono text-[12px] text-white/90">{m.v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlanCardView({ plan, index }: { plan: PlanCard; index: number }) {
  const art = [heroFloat2, heroFloat3, heroFloat1, heroFloat2][index % 4];
  return (
    <Link
      to={plan.href}
      className={`group relative flex h-full flex-col overflow-hidden rounded-2xl border p-5 backdrop-blur transition hover:-translate-y-0.5 ${
        plan.featured
          ? "border-[#8FB4FF]/40 bg-gradient-to-b from-white/[0.08] to-white/[0.02] shadow-[0_20px_60px_-20px_rgba(143,180,255,0.35)]"
          : "border-white/10 bg-white/[0.04] hover:border-white/25"
      }`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 opacity-40 transition group-hover:opacity-60"
      >
        <img src={art} alt="" className="h-full w-full object-contain" />
      </div>

      <div className="relative z-10 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-white/60">
          {plan.name}
        </span>
        {plan.featured && (
          <span className="rounded-full bg-[#4F7CFF]/20 px-2 py-0.5 text-[10px] font-semibold text-[#B8CCFF] ring-1 ring-[#4F7CFF]/40">
            Popular
          </span>
        )}
      </div>

      <div className="relative z-10 mt-3 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight">{plan.price}</span>
        {plan.period && <span className="text-[13px] text-white/50">{plan.period}</span>}
      </div>
      <div className="relative z-10 mt-1 text-[13px] font-medium text-[#B8CCFF]">
        {plan.devices}
      </div>

      <p className="relative z-10 mt-2 text-[13px] leading-relaxed text-white/70">{plan.blurb}</p>

      <div className="relative z-10 mt-6 inline-flex items-center gap-1 text-[13px] font-semibold text-white group-hover:gap-2">
        {plan.cta} <span aria-hidden>→</span>
      </div>
    </Link>
  );
}

function FloatingArt() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-0 overflow-hidden">
      <img
        src={heroFloat2}
        alt=""
        className="absolute -left-24 top-24 h-[340px] w-[340px] opacity-60 blur-[0.5px] [animation:float1_16s_ease-in-out_infinite]"
      />
      <img
        src={heroFloat3}
        alt=""
        className="absolute right-[-60px] top-40 hidden h-[380px] w-[380px] opacity-60 md:block [animation:float2_20s_ease-in-out_infinite]"
      />
      <img
        src={heroFloat1}
        alt=""
        className="absolute left-1/2 top-[62%] hidden h-[280px] w-[520px] -translate-x-1/2 opacity-40 md:block [animation:float3_22s_ease-in-out_infinite]"
      />
      <style>{`
        @keyframes float1 { 0%,100%{transform:translateY(0) rotate(0)} 50%{transform:translateY(-18px) rotate(2deg)} }
        @keyframes float2 { 0%,100%{transform:translateY(0) rotate(0)} 50%{transform:translateY(22px) rotate(-2deg)} }
        @keyframes float3 { 0%,100%{transform:translate(-50%,0)} 50%{transform:translate(-50%,-16px)} }
      `}</style>
    </div>
  );
}
