import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Footer } from "@/components/Footer";
import { Gift, PlayCircle, Sparkles, Tag } from "lucide-react";
import orbAsset from "@/assets/connectlive-orb.gif.asset.json";
import bannerAsset from "@/assets/connectlive-banner.jpg.asset.json";
import logoMark from "@/assets/hero-float-2.png";

type PlanCard = {
  code: string;
  name: string;
  devices: string;
  price: string;
  wasPrice?: string;
  saveLabel?: string;
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
    price: "$150",
    wasPrice: "$250",
    saveLabel: "Save $100",
    period: "/mo",
    blurb: "Small teams getting remote support off the ground.",
    cta: "Order Starter",
    href: "/order",
  },
  {
    code: "team",
    name: "Team",
    devices: "20 desktop devices",
    price: "$310",
    wasPrice: "$570",
    saveLabel: "Save $260",
    period: "/mo",
    blurb: "Growing help desks with multi-department coverage.",
    cta: "Order Team",
    href: "/order",
    featured: true,
  },
  {
    code: "business",
    name: "Business",
    devices: "50 desktop devices",
    price: "$560",
    wasPrice: "$840",
    saveLabel: "Save $280",
    period: "/mo",
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

const PROMO_ITEMS = [
  "PROMO DROP · 10 devices $250 → $150",
  "PROMO DROP · 20 devices $570 → $310",
  "PROMO DROP · 50 devices $840 → $560",
  "Free video setup guides with every completed order",
];

/** Ambient product motion, rendered without card chrome so the edges stay clean. */
const SHOWCASE: { src: string; caption: string }[] = [
  {
    src: "https://www.google.com/chrome/static/videos/whats-new/sidebyside/sidebyside.webm",
    caption: "How live feels",
  },
  {
    src: "https://www.google.com/chrome/static/videos/whats-new/144/pdfannotations.webm",
    caption: "How writing on a document feels",
  },
];



export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { title: "ConnectLive — Enterprise Remote Support Platform" },
      {
        name: "description",
        content:
          "ConnectLive is a consent-based remote-support platform for IT, help desks, and enterprise fleets. Sub-50ms sessions, curtain mode, and a full audit trail.",
      },
      { property: "og:title", content: "ConnectLive — Remote Support Platform" },
      {
        property: "og:description",
        content:
          "Authorised remote support for 10 to unlimited devices. Precise, secure, auditable.",
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
    <div className="relative min-h-screen overflow-x-hidden bg-navy-900 font-sans text-navy-050 antialiased">
      {/* Ambient motion background */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="mesh-pan absolute inset-[-20%] opacity-70" />
        <div className="aurora-a absolute -left-24 top-[-10%] h-[46rem] w-[46rem] rounded-full bg-navy-400/30 blur-[120px]" />
        <div className="aurora-b absolute -right-32 top-[25%] h-[38rem] w-[38rem] rounded-full bg-emerald-400/15 blur-[130px]" />
        <div className="aurora-c absolute bottom-[-15%] left-[30%] h-[34rem] w-[34rem] rounded-full bg-navy-200/15 blur-[140px]" />
        <div className="grid-pan absolute inset-0 opacity-[0.14]" />
        <div className="sheen absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/[0.05] to-transparent" />
      </div>

      {/* Promo marquee */}
      <div className="relative z-10 overflow-hidden border-b border-white/10 bg-gradient-to-r from-navy-700 via-navy-600 to-navy-700">
        <div className="marquee-track whitespace-nowrap py-2">
          {[0, 1].map((dup) => (
            <div key={dup} className="flex shrink-0 items-center">
              {PROMO_ITEMS.map((item, i) => (
                <span
                  key={`${dup}-${i}`}
                  className="mx-5 inline-flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-navy-050"
                >
                  {i % 2 === 0 ? (
                    <Gift className="h-3.5 w-3.5 text-emerald-300" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 text-amber-300" />
                  )}
                  {item}
                  <Tag className="h-3.5 w-3.5 text-navy-400" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Top bar */}
      <header className="relative z-10 border-b border-white/10 backdrop-blur-sm">

        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid h-8 w-8 place-items-center overflow-hidden rounded-md bg-navy-400/20 ring-1 ring-navy-400/40">
              <img src={logoMark} alt="ConnectLive" className="h-8 w-8 object-cover" />
            </div>
            <span className="font-mono text-[14px] font-bold tracking-tight">ConnectLive</span>
            <span className="ml-2 hidden items-center gap-1.5 rounded-sm bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-300 ring-1 ring-white/10 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Operational
            </span>
          </div>
          <div className="flex items-center gap-3">
            {userCount !== null && (
              <span className="hidden font-mono text-[11px] uppercase tracking-[0.18em] text-navy-200/70 sm:inline">
                {userCount.toLocaleString()} sessions delivered
              </span>
            )}
            <Link
              to="/order"
              className="rounded-md bg-navy-050 px-3.5 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-navy-800 transition hover:bg-white"
            >
              Order
            </Link>
          </div>
        </div>
      </header>

      {/* Bento grid */}
      <main className="relative z-10 mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
          {/* Hero tile */}
          <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-navy-800/80 backdrop-blur-xl p-6 sm:p-10 lg:col-span-7">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-[0.14] [background-image:linear-gradient(to_right,#3b6fa0_1px,transparent_1px),linear-gradient(to_bottom,#3b6fa0_1px,transparent_1px)] [background-size:44px_44px]"
            />
            <div className="relative">
              <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-navy-400">
                Remote support infrastructure
              </span>
              <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
                Every session
                <br />
                <span className="text-navy-400">on the record.</span>
              </h1>
              <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-navy-200">
                Authorised remote control for IT, help desks, and enterprise fleets. Sub-50ms
                sessions, curtain mode, and a full audit trail — provisioned within 24 hours.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-2.5">
                <Link
                  to="/order"
                  className="rounded-md bg-navy-050 px-5 py-3 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-navy-800 transition hover:bg-white"
                >
                  Order a license
                </Link>
                <a
                  href="#plans"
                  className="rounded-md border border-white/15 px-5 py-3 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-navy-050 transition hover:bg-white/5"
                >
                  See plans
                </a>
                <Link
                  to="/license"
                  className="px-2 py-3 font-mono text-[12px] uppercase tracking-[0.14em] text-navy-200/70 transition hover:text-navy-050"
                >
                  License lookup →
                </Link>
              </div>
            </div>
          </section>

          {/* Live session tile */}
          <section className="overflow-hidden rounded-2xl border border-white/10 bg-navy-800 lg:col-span-5">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-navy-200/70">
                Live session · 882-CL
              </span>
              <span className="rounded-sm bg-navy-400/25 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-navy-200 ring-1 ring-navy-400/40">
                Curtain
              </span>
            </div>
            <div className="relative aspect-video bg-navy-900">
              <img
                src={orbAsset.url}
                alt="ConnectLive live session orb animation"
                loading="lazy"
                decoding="async"
                className="h-full w-full object-contain"
              />
              <div className="absolute left-[38%] top-[42%] text-navy-200 drop-shadow-[0_0_6px_rgba(59,111,160,0.9)]">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M5.23 3l15.43 12.83-6.5 1.15 3.53 7.02-2.5 1.25-3.53-7.02-6.43 5.4V3z" />
                </svg>
              </div>
            </div>
            <div className="grid grid-cols-4 divide-x divide-white/10 border-t border-white/10">
              {[
                { k: "Latency", v: "42ms" },
                { k: "FPS", v: "60" },
                { k: "Uplink", v: "3.4Mb" },
                { k: "Codec", v: "H.264" },
              ].map((m) => (
                <div key={m.k} className="px-3 py-3">
                  <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-navy-200/60">
                    {m.k}
                  </div>
                  <div className="mt-1 font-mono text-[13px] font-bold text-navy-050">{m.v}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Order tracker tile */}
          <section className="rounded-2xl border border-white/10 bg-navy-700 p-6 lg:col-span-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-navy-400">
              Track an order
            </span>
            <p className="mt-3 text-[14px] leading-relaxed text-navy-200">
              Paste your order ID to see provisioning status and delivery.
            </p>
            <form onSubmit={trackOrder} className="mt-5 flex items-center gap-2">
              <input
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                placeholder="Order ID"
                aria-label="Order ID"
                className="min-w-0 flex-1 rounded-md border border-white/15 bg-navy-900/60 px-3 py-2.5 font-mono text-[12px] text-navy-050 placeholder:text-navy-200/40 focus:border-navy-400 focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-md bg-navy-400 px-4 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-navy-900 transition hover:bg-navy-200"
              >
                Track
              </button>
            </form>
          </section>

          {/* Deployment pipeline tile */}
          <section className="rounded-2xl border border-white/10 bg-navy-800 p-6 lg:col-span-5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-navy-400">
                Instance deployment
              </span>
              <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-navy-200">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-navy-400" />
                Live
              </span>
            </div>
            <div className="relative mt-8">
              <div className="absolute left-0 right-0 top-2.5 h-px bg-white/10" />
              <div className="absolute left-0 top-2.5 h-px w-2/3 bg-navy-400" />
              <div className="relative grid grid-cols-3">
                {[
                  { label: "Order", done: true },
                  { label: "Provision", active: true },
                  { label: "Activate", done: false },
                ].map((s) => (
                  <div key={s.label} className="flex flex-col items-center gap-3">
                    <span
                      className={`h-5 w-5 rounded-sm border-4 border-navy-800 ${
                        s.done ? "bg-navy-400" : s.active ? "animate-pulse bg-navy-400" : "bg-white/20"
                      }`}
                    />
                    <span
                      className={`font-mono text-[10px] uppercase tracking-[0.16em] ${
                        s.done || s.active ? "text-navy-050" : "text-navy-200/50"
                      }`}
                    >
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Sessions counter tile */}
          <section className="flex flex-col justify-between rounded-2xl border border-white/10 bg-navy-400 p-6 text-navy-900 lg:col-span-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-navy-900/70">
              Sessions delivered
            </span>
            <div>
              <div className="font-mono text-5xl font-bold tracking-tight">
                {userCount !== null ? userCount.toLocaleString() : "—"}
              </div>
              <p className="mt-2 text-[13px] font-medium leading-snug text-navy-900/80">
                Fully logged, auditable, attributable.
              </p>
            </div>
          </section>

          {/* Edge-clean product motion — no card chrome */}
          {SHOWCASE.map((v) => (
            <section key={v.src} className="lg:col-span-6">
              <div className="overflow-hidden rounded-2xl">
                <video
                  src={v.src}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  aria-label={v.caption}
                  disablePictureInPicture
                  className="block h-full w-full object-cover"
                />
              </div>
              <p className="mt-3 px-1 font-mono text-[11px] uppercase tracking-[0.18em] text-navy-200/70">
                {v.caption}
              </p>
            </section>
          ))}


          {/* Plans header */}
          <section id="plans" className="rounded-2xl border border-white/10 bg-navy-700 p-6 lg:col-span-12">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-navy-400">
                  Plans
                </span>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                  Choose your surface area
                </h2>
              </div>
              <p className="max-w-sm text-[13px] leading-relaxed text-navy-200">
                Promo pricing is live — every plan is discounted while the drop lasts. Custom orders
                are handled by our team directly.
              </p>
            </div>
            <div className="mt-5 inline-flex flex-wrap items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2.5">
              <Gift className="h-4 w-4 text-emerald-300" />
              <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-200">
                Promo drop — up to 46% off
              </span>
              <span className="text-[12px] text-navy-200">
                $250 → $150 · $570 → $310 · $840 → $560
              </span>
            </div>
          </section>

          {PLAN_CARDS.map((p) => (
            <div key={p.code} className="lg:col-span-3">
              <PlanCardView plan={p} />
            </div>
          ))}

          {/* Post-order delivery tile */}
          <section className="rounded-2xl border border-white/10 bg-navy-800 p-6 lg:col-span-12">
            <div className="flex flex-wrap items-start gap-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-navy-400/20 ring-1 ring-navy-400/40">
                <PlayCircle className="h-5 w-5 text-navy-200" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[17px] font-semibold tracking-tight">
                  Video setup guides are included with every completed order
                </h3>
                <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-navy-200">
                  Once your order is complete, we email you the full delivery pack: the agent
                  installer, the admin console installer, your Meeting ID and sign-in details — plus
                  step-by-step video setup guides that walk you through installing the agent,
                  enrolling devices, and running your first live session. Delivery normally lands
                  within 24 hours (48 hours at the outside) on business days, so please keep an eye
                  on your spam folder and mark our address as safe.
                </p>
              </div>
            </div>
          </section>

          {/* Newsletter tile */}
          <section className="rounded-2xl border border-white/10 bg-navy-700 p-6 backdrop-blur-xl lg:col-span-12">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="min-w-[260px] flex-1">
                <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-navy-400">
                  <Mail className="h-3.5 w-3.5" />
                  Newsletter
                </span>
                <h3 className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">
                  Release notes, promo drops, setup guides.
                </h3>
                <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-navy-200">
                  One email when there's something worth reading — never a schedule for its own sake.
                  Unsubscribe any time by replying.
                </p>
              </div>
              <form onSubmit={subscribe} className="flex w-full max-w-md flex-wrap items-center gap-2">
                <input
                  type="email"
                  required
                  value={newsletterEmail}
                  onChange={(e) => setNewsletterEmail(e.target.value)}
                  placeholder="you@company.com"
                  aria-label="Email address"
                  maxLength={254}
                  className="min-w-0 flex-1 rounded-md border border-white/15 bg-navy-900/60 px-3 py-2.5 font-mono text-[12px] text-navy-050 placeholder:text-navy-200/40 focus:border-navy-400 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={newsletterState === "sending"}
                  className="rounded-md bg-navy-050 px-4 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-navy-800 transition hover:bg-white disabled:opacity-60"
                >
                  {newsletterState === "sending" ? "Sending…" : "Subscribe"}
                </button>
                {newsletterMsg && (
                  <p
                    role="status"
                    className={`w-full font-mono text-[11px] ${
                      newsletterState === "error" ? "text-red-300" : "text-emerald-300"
                    }`}
                  >
                    {newsletterMsg}
                  </p>
                )}
              </form>
            </div>
          </section>


          {/* Banner tile */}
          <section className="relative overflow-hidden rounded-2xl border border-white/10 lg:col-span-12">
            <img
              src={bannerAsset.url}
              alt="ConnectLive multi-participant collaboration surface"
              className="h-56 w-full object-cover sm:h-72"
              loading="lazy"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-navy-900 via-navy-900/85 to-navy-900/25" />
            <div className="absolute bottom-0 left-0 p-6 sm:p-8">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-navy-400">
                Enterprise ready
              </span>
              <div className="mt-2 max-w-xl text-lg font-semibold tracking-tight sm:text-2xl">
                One surface for every department — IT, help desk, finance, HR.
              </div>
            </div>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function PlanCardView({ plan }: { plan: PlanCard }) {
  return (
    <Link
      to={plan.href}
      className={`group flex h-full flex-col rounded-2xl border p-5 transition duration-300 hover:-translate-y-1 hover:shadow-[0_18px_40px_-20px_rgba(0,0,0,0.8)] ${
        plan.featured
          ? "border-navy-400 bg-navy-600"
          : "border-white/10 bg-navy-800 hover:border-navy-400/60"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-navy-200">
          {plan.name}
        </span>
        {plan.featured ? (
          <span className="rounded-sm bg-navy-400 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-navy-900">
            Popular
          </span>
        ) : plan.saveLabel ? (
          <span className="inline-flex items-center gap-1 rounded-sm bg-emerald-400/15 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-emerald-200 ring-1 ring-emerald-400/30">
            <Gift className="h-3 w-3" />
            Promo
          </span>
        ) : null}
      </div>

      {plan.wasPrice && (
        <div className="mt-4 flex items-center gap-2">
          <span className="font-mono text-[13px] text-navy-200/60 line-through">
            {plan.wasPrice}
          </span>
          {plan.saveLabel && (
            <span className="rounded-sm bg-emerald-400/15 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-emerald-200">
              {plan.saveLabel}
            </span>
          )}
        </div>
      )}
      <div className={`${plan.wasPrice ? "mt-1" : "mt-4"} flex items-baseline gap-1`}>
        <span className="font-mono text-3xl font-bold tracking-tight">{plan.price}</span>
        {plan.period && (
          <span className="font-mono text-[12px] text-navy-200/70">{plan.period}</span>
        )}
      </div>
      <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-navy-400">
        {plan.devices}
      </div>


      <p className="mt-3 text-[13px] leading-relaxed text-navy-200">{plan.blurb}</p>

      <div className="mt-auto pt-6 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-navy-050">
        {plan.cta} <span aria-hidden>→</span>
      </div>
    </Link>
  );
}
