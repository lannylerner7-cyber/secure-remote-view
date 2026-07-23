import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Footer } from "@/components/Footer";
import heroFloat1 from "@/assets/hero-float-1.png";
import heroFloat2 from "@/assets/hero-float-2.png";
import heroFloat3 from "@/assets/hero-float-3.png";

type PlanCard = {
  code: string;
  name: string;
  devices: string;
  blurb: string;
  cta: string;
  href: string;
  featured?: boolean;
};

const PLAN_CARDS: PlanCard[] = [
  {
    code: "starter",
    name: "Starter",
    devices: "10 devices",
    blurb: "Small teams getting remote support off the ground.",
    cta: "Order Starter",
    href: "/order",
  },
  {
    code: "team",
    name: "Team",
    devices: "20 devices",
    blurb: "Growing help desks with multi-department coverage.",
    cta: "Order Team",
    href: "/order",
    featured: true,
  },
  {
    code: "business",
    name: "Business",
    devices: "50 devices",
    blurb: "SMB fleets with priority response and full audit trail.",
    cta: "Order Business",
    href: "/order",
  },
  {
    code: "custom",
    name: "Custom",
    devices: "Unlimited devices",
    blurb: "Enterprise fleets — manual order handled by our team.",
    cta: "Request Custom",
    href: "/contact",
  },
];

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { title: "ConnectLive — Cinematic Remote Support Platform" },
      {
        name: "description",
        content:
          "ConnectLive is a consent-based remote-support platform for IT, help desks, and enterprise fleets. Order a license or track your order.",
      },
      { property: "og:title", content: "ConnectLive — Remote Support Platform" },
      {
        property: "og:description",
        content:
          "Consent-based remote support for 10 to unlimited devices. Cinematic, secure, minimal.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
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

      {/* Floating generated images */}
      <FloatingArt />

      {/* Top bar (no sign in button) */}
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
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-7xl px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
        <div className="mx-auto max-w-3xl text-center">
          {userCount !== null && (
            <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1 text-[11px] font-medium text-white/70 ring-1 ring-white/10 backdrop-blur">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#8FB4FF]" />
              Trusted by {userCount.toLocaleString()} {userCount === 1 ? "user" : "users"}
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
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-white/70">
            A consent-based platform for IT, help desks, and enterprise fleets. Pick a license,
            we deliver access within 24 hours.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
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
          </div>

          {/* Order tracker */}
          <form
            onSubmit={trackOrder}
            className="mx-auto mt-8 flex max-w-md items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-1.5 backdrop-blur"
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
      </section>

      {/* Plan cards — dynamic marketing surface */}
      <section id="plans" className="relative z-10 mx-auto max-w-7xl px-4 pb-16 sm:px-6">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h2 className="text-[22px] font-semibold tracking-tight">Choose your surface area</h2>
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

      <Footer />
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
      {/* Card ambient art */}
      <div aria-hidden className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 opacity-40 transition group-hover:opacity-60">
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

      <div className="relative z-10 mt-3 text-2xl font-semibold tracking-tight">{plan.devices}</div>
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
        className="absolute -left-24 top-24 h-[340px] w-[340px] opacity-70 blur-[0.5px] [animation:float1_16s_ease-in-out_infinite]"
      />
      <img
        src={heroFloat3}
        alt=""
        className="absolute right-[-60px] top-40 h-[380px] w-[380px] opacity-80 [animation:float2_20s_ease-in-out_infinite]"
      />
      <img
        src={heroFloat1}
        alt=""
        className="absolute left-1/2 top-[52%] hidden h-[280px] w-[520px] -translate-x-1/2 opacity-50 md:block [animation:float3_22s_ease-in-out_infinite]"
      />
      <style>{`
        @keyframes float1 { 0%,100%{transform:translateY(0) rotate(0)} 50%{transform:translateY(-18px) rotate(2deg)} }
        @keyframes float2 { 0%,100%{transform:translateY(0) rotate(0)} 50%{transform:translateY(22px) rotate(-2deg)} }
        @keyframes float3 { 0%,100%{transform:translate(-50%,0)} 50%{transform:translate(-50%,-16px)} }
      `}</style>
    </div>
  );
}
