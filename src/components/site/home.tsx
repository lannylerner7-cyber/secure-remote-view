import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronDown,
  LockKeyhole,
  MousePointer2,
  Pause,
  Play,
  Radio,
  ShieldCheck,
  Video,
} from "lucide-react";
import agentShot from "@/assets/connectlive-agent.png";
import adminShot from "@/assets/connectlive-admin.png";
import sessionCore from "@/assets/connectlive-session-core.png";
import { faqs, plans, securityFeatures, workflow } from "./data";
import { PricingCard } from "./pricing-card";
import { SessionCore } from "./session-core";
import { ActionButton, Badge, Button, Reveal, SectionHeading, TextLink } from "./ui";

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function Hero() {
  return (
    <section className="relative min-h-[calc(100dvh-7.25rem)] overflow-hidden border-b border-white/10">
      <div
        className="grid-surface absolute inset-0 opacity-35 [mask-image:linear-gradient(to_bottom,black,transparent_90%)]"
        aria-hidden="true"
      />
      <div
        className="absolute left-1/2 top-0 h-[42rem] w-[42rem] -translate-x-1/2 rounded-full bg-cl-signal/10 blur-[130px]"
        aria-hidden="true"
      />
      <div className="container relative grid min-h-[calc(100dvh-7.25rem)] items-center gap-10 py-16 lg:grid-cols-[1.08fr_0.92fr] lg:py-10">
        <Reveal>
          <Badge live>Authorized remote operations</Badge>
          <h1 className="display-xl mt-7">
            Control the session.{" "}
            <span className="text-cl-signal-bright">Keep the evidence.</span>
          </h1>
          <p className="body-lg mt-8 max-w-xl">
            A fast, authorization-led remote support platform for IT teams that need every
            connection to be clear, controlled, and reviewable.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button to="/order" data-testid="link-hero-order">
              Start an order <ArrowRight size={17} aria-hidden="true" />
            </Button>
            <Button to="/#platform" variant="secondary" data-testid="link-hero-platform">
              Explore the platform <ArrowDown size={17} aria-hidden="true" />
            </Button>
          </div>
          <div className="mt-9 flex flex-wrap gap-x-7 gap-y-3 font-mono text-[0.7rem] uppercase tracking-[0.12em] text-cl-faint">
            <span className="flex items-center gap-2">
              <Check size={13} className="text-cl-success" aria-hidden="true" /> Delivered within
              one business day
            </span>
            <span className="flex items-center gap-2">
              <Check size={13} className="text-cl-success" aria-hidden="true" /> Pay in BTC, USDT
              or USDC
            </span>
          </div>
        </Reveal>
        <Reveal delay={0.14} className="relative">
          <SessionCore />
          <div className="surface absolute inset-x-6 bottom-1 z-10 grid grid-cols-3 divide-x divide-white/10 overflow-hidden rounded-xl md:inset-x-16">
            {[
              ["Session", "CL–4821"],
              ["Operator", "Verified"],
              ["Audit", "Recording"],
            ].map(([label, value]) => (
              <div className="p-3 text-center md:p-4" key={label}>
                <p className="hairline-title">{label}</p>
                <p className="mt-2 font-mono text-xs font-semibold">{value}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function TrustRail() {
  const technologies = ["Windows", "WebRTC", "H.264", "DXGI capture", "Audit logging"];
  return (
    <section className="border-b border-white/10 py-7">
      <div className="container flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
        <p className="hairline-title">Built for real support infrastructure</p>
        <div className="flex flex-wrap items-center gap-x-9 gap-y-4 text-sm font-semibold text-cl-faint md:text-base">
          {technologies.map((name) => (
            <span key={name}>{name}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="hairline-title">{label}</p>
      <p className="mt-2 font-mono text-sm font-semibold">{value}</p>
    </div>
  );
}

function ProductConsole() {
  const [tab, setTab] = useState<"overview" | "audit">("overview");
  const [curtain, setCurtain] = useState(true);
  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="status-dot" />
          <span className="font-mono text-xs uppercase tracking-widest">
            Finance-LT-024 · session CL–4821
          </span>
        </div>
        <ActionButton
          className="!min-h-8 !px-3 !py-1 text-xs"
          variant="secondary"
          onClick={() => setCurtain((value) => !value)}
          data-testid="button-console-curtain"
        >
          <LockKeyhole size={13} aria-hidden="true" /> {curtain ? "Release curtain" : "Take control"}
        </ActionButton>
      </div>
      <div className="relative min-h-[22rem] overflow-hidden bg-[#080d17] p-5 md:p-8">
        <div className="grid-surface absolute inset-0 opacity-30" />
        <div className="relative mx-auto max-w-xl overflow-hidden rounded-xl border border-white/10 bg-[#dfe7f4] p-2 shadow-2xl">
          <div className="flex gap-1.5 border-b border-black/10 px-2 py-2">
            <i className="size-2 rounded-full bg-cl-danger" />
            <i className="size-2 rounded-full bg-cl-warning" />
            <i className="size-2 rounded-full bg-cl-success" />
          </div>
          <div className="grid min-h-56 place-items-center bg-gradient-to-br from-[#16233c] to-[#09101d]">
            <div key={String(curtain)} className="cl-pop text-center">
              <div className="mx-auto grid size-16 place-items-center rounded-full border border-cl-signal/30 bg-cl-signal/10">
                <Radio className="text-cl-signal-bright" aria-hidden="true" />
              </div>
              <p className="mt-4 font-mono text-xs uppercase tracking-widest text-white/70">
                {curtain ? "Privacy curtain active" : "Desktop visible to operator"}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="flex gap-1 border-b border-white/10 p-2" role="tablist">
          {(["overview", "audit"] as const).map((item) => (
            <ActionButton
              key={item}
              role="tab"
              aria-selected={tab === item}
              className={`!min-h-9 !px-4 !py-1 text-xs capitalize ${tab === item ? "!bg-white/10 !text-white" : ""}`}
              variant="ghost"
              onClick={() => setTab(item)}
              data-testid={`tab-console-${item}`}
            >
              {item === "audit" ? "Audit log" : item}
            </ActionButton>
          ))}
        </div>
        <div key={tab} className="cl-pop grid gap-4 p-5 sm:grid-cols-3">
          {(tab === "overview"
            ? [
                ["Transport", "WebRTC · host"],
                ["Codec", "H.264"],
                ["Render", "60 fps · D3D"],
              ]
            : [
                ["14:02", "Device authorized"],
                ["14:03", "Curtain enabled"],
                ["14:10", "Render health sampled"],
              ]
          ).map(([label, value]) => (
            <Metric key={label} label={label} value={value} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-white/10 p-4">
          {["Restart stream", "Send clipboard", "Transfer files", "Record session"].map((action) => (
            <span
              className="rounded-full bg-white/5 px-3 py-2 text-xs text-cl-muted shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
              key={action}
            >
              {action}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Platform() {
  const features = [
    [
      "Authorize before connection",
      "Enroll devices with a valid Meeting ID, enforce seat availability, and keep active support visibly indicated.",
      MousePointer2,
    ],
    [
      "Operate without friction",
      "Keep input responsive and the operator focused with session quality visible at a glance.",
      Radio,
    ],
    [
      "Close with a complete record",
      "Capture identity, timing, actions, and outcome in one readable session history.",
      ShieldCheck,
    ],
  ] as const;

  return (
    <section className="section" id="platform">
      <div className="container">
        <SectionHeading
          eyebrow="One operating surface"
          title="Built around the moments that matter."
          copy="From authorized enrollment to the final audit entry, ConnectLive gives support teams a single controlled workflow."
        />
        <div className="mt-16 grid gap-6 lg:grid-cols-[0.82fr_1.18fr]">
          <div className="grid gap-4">
            {features.map(([title, copy, Icon], index) => (
              <Reveal key={title} delay={index * 0.08}>
                <article className="surface group p-6 hover:border-white/25">
                  <div className="flex gap-5">
                    <span className="grid size-11 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-cl-signal-bright">
                      <Icon size={19} aria-hidden="true" />
                    </span>
                    <div>
                      <p className="hairline-title">0{index + 1}</p>
                      <h3 className="mt-3 font-display text-2xl tracking-tight">{title}</h3>
                      <p className="mt-3 text-sm leading-7 text-cl-muted">{copy}</p>
                    </div>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
          <Reveal delay={0.1}>
            <ProductConsole />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function ProductEcosystem() {
  const surfaces = [
    {
      src: agentShot,
      title: "Endpoint agent",
      copy: "Enrollment, heartbeat, hardware capture, monitor selection, and visible session state on the supported device.",
      className: "md:col-span-2",
    },
    {
      src: adminShot,
      title: "Technician console",
      copy: "A focused operator surface for fleet presence, live sessions, curtain control, files, clipboard, and recording.",
      className: "",
    },
    {
      src: sessionCore,
      title: "Resilient session path",
      copy: "WebRTC video first, with frame fallback, reconnect handling, and render-health telemetry when networks change.",
      className: "",
    },
  ];

  return (
    <section className="section border-y border-white/10 bg-[#020203]">
      <div className="container">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow="One product, three operating surfaces"
            title="The complete support path—not a marketing abstraction."
            copy="A unified view of the endpoint agent, technician console, and resilient transport architecture working as one system."
          />
          <Badge>ConnectLive platform</Badge>
        </div>
        <div className="mt-14 grid gap-4 md:grid-cols-2">
          {surfaces.map((surface, index) => (
            <Reveal key={surface.title} delay={index * 0.07} className={surface.className}>
              <article className="surface group grid h-full overflow-hidden md:grid-cols-[1.05fr_0.95fr]">
                <div className="relative min-h-72 overflow-hidden bg-[#07111d]">
                  <img
                    className="source-image absolute inset-0 h-full w-full object-cover transition-[transform,filter] duration-700 ease-out group-hover:scale-[1.03] group-hover:brightness-110"
                    src={surface.src}
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    decoding="async"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                </div>
                <div className="flex flex-col justify-end p-7">
                  <p className="hairline-title">0{index + 1} / Surface</p>
                  <h3 className="mt-5 font-display text-2xl tracking-tight">{surface.title}</h3>
                  <p className="pretty mt-4 text-sm leading-7 text-cl-muted">{surface.copy}</p>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {[
            "Device presence",
            "WebRTC video",
            "Frame fallback",
            "Curtain control",
            "Clipboard",
            "File transfer",
            "Recording",
            "Power actions",
          ].map((item) => (
            <Badge key={item}>{item}</Badge>
          ))}
        </div>
      </div>
    </section>
  );
}

const motionClips = [
  {
    src: "https://www.google.com/chrome/static/videos/whats-new/sidebyside/sidebyside.webm",
    title: "Fluid live response",
    label: "Operator feel",
  },
  {
    src: "https://www.google.com/chrome/static/videos/whats-new/144/pdfannotations.webm",
    title: "Precise document input",
    label: "Control feel",
  },
];

function LoopVideoCard({ src, title, label }: { src: string; title: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const reduceMotion = usePrefersReducedMotion();
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (reduceMotion) {
      video.pause();
      setPlaying(false);
    }
  }, [reduceMotion]);

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (video.paused) {
        await video.play();
        setPlaying(true);
      } else {
        video.pause();
        setPlaying(false);
      }
    } catch {
      setPlaying(false);
    }
  };

  return (
    <article className="surface group relative min-h-64 overflow-hidden">
      <video
        ref={videoRef}
        className="source-image absolute inset-0 h-full w-full object-cover"
        src={src}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        disablePictureInPicture
        aria-label={title}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/10 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-5">
        <div>
          <p className="hairline-title !text-white/60">{label}</p>
          <h3 className="mt-2 font-display text-xl">{title}</h3>
        </div>
        <ActionButton
          className="!size-11 shrink-0 !p-0"
          variant="secondary"
          aria-label={playing ? `Pause ${title}` : `Play ${title}`}
          onClick={togglePlayback}
        >
          <span key={playing ? "pause" : "play"} className="cl-pop inline-flex">
            {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          </span>
        </ActionButton>
      </div>
    </article>
  );
}

function MotionShowcase() {
  return (
    <section className="section" id="setup">
      <div className="container">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow="Watch the workflow"
            title="See the setup. Feel the response."
            copy="Replay the complete agent walkthrough, then preview the fluid interaction quality ConnectLive is designed to deliver."
          />
          <Badge>
            <Video size={13} aria-hidden="true" /> Setup replay
          </Badge>
        </div>
        <div className="mt-14 grid gap-4 lg:grid-cols-[1.45fr_0.55fr]">
          <div className="surface overflow-hidden p-2">
            <div className="aspect-video overflow-hidden rounded-[1.1rem] bg-black">
              <iframe
                className="h-full w-full"
                src="https://www.youtube.com/embed/xjtQdMZFOKg?autoplay=1&mute=1&loop=1&playlist=xjtQdMZFOKg&rel=0&modestbranding=1&playsinline=1"
                title="ConnectLive agent setup guide"
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            </div>
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="hairline-title">Agent setup guide</p>
                <p className="mt-2 font-display text-xl">Installation to first live session</p>
              </div>
              <p className="max-w-sm text-xs leading-5 text-cl-faint">
                Use the player controls to pause, replay, change volume, or open the guide full
                screen. Video setup guides come with every completed order.
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            {motionClips.map((clip) => (
              <LoopVideoCard key={clip.src} {...clip} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Security() {
  return (
    <section className="section border-y border-white/10 bg-cl-panel" id="security">
      <div className="container">
        <SectionHeading
          eyebrow="Control by design"
          title="Fast for support. Legible for security."
          copy="High-velocity support does not have to mean invisible access. Every interaction has a clear state and owner."
        />
        <div className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10 md:grid-cols-2">
          {securityFeatures.map(([title, copy], index) => (
            <Reveal key={title} delay={index * 0.06} className="h-full">
              <article className="h-full bg-cl-panel p-7 md:p-9">
                <div className="flex items-center justify-between">
                  <span className="grid size-10 place-items-center rounded-full border border-white/10 text-cl-signal-bright">
                    <ShieldCheck size={18} aria-hidden="true" />
                  </span>
                  <span className="font-mono text-xs text-cl-faint">0{index + 1}</span>
                </div>
                <h3 className="mt-9 font-display text-2xl tracking-tight">{title}</h3>
                <p className="mt-3 max-w-md text-sm leading-7 text-cl-muted">{copy}</p>
              </article>
            </Reveal>
          ))}
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {[
            ["View", "Authorized screen sharing"],
            ["Control", "Permission-based interaction"],
            ["Audit", "Session activity history"],
          ].map(([value, label]) => (
            <div className="surface p-6" key={label}>
              <p className="tabular font-display text-4xl tracking-tight">{value}</p>
              <p className="mt-2 text-sm text-cl-muted">{label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Workflow() {
  return (
    <section className="section" id="workflow">
      <div className="container">
        <SectionHeading eyebrow="From order to operation" title="A clean deployment path." />
        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {workflow.map(([number, title, copy], index) => (
            <Reveal key={title} delay={index * 0.08}>
              <article className="relative h-full border-l border-white/15 py-2 pl-6">
                <p className="font-mono text-xs text-cl-signal-bright">{number}</p>
                <h3 className="mt-8 font-display text-xl">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-cl-muted">{copy}</p>
              </article>
            </Reveal>
          ))}
        </div>
        <div className="mt-12">
          <TextLink to="/order">Start your deployment</TextLink>
        </div>
      </div>
    </section>
  );
}

function PricingPreview() {
  return (
    <section className="section border-y border-white/10 bg-cl-panel" id="plans">
      <div className="container">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow="Plans"
            title="Start controlled. Scale without friction."
            copy="Promo pricing is live on every plan. Choose the operating surface that fits today, then expand without rebuilding your workflow."
          />
          <TextLink to="/plans">Compare every feature</TextLink>
        </div>
        <div className="mt-14 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan, index) => (
            <Reveal key={plan.slug} delay={index * 0.05} className="h-full">
              <PricingCard plan={plan} compact />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Proof() {
  const principles = [
    {
      title: "Direct when possible. Resilient when necessary.",
      copy: "WebRTC handles the primary live path. Frame polling and reconnect logic keep the operator informed when direct transport degrades.",
      label: "Transport",
    },
    {
      title: "Presence is observed, never assumed.",
      copy: "Device availability follows actual heartbeats, while stale connections and sessions are cleaned up by explicit time-based rules.",
      label: "Fleet state",
    },
  ];
  return (
    <section className="section">
      <div className="container">
        <SectionHeading
          eyebrow="Inside the engine"
          title="Designed from operational reality."
          copy="Transport fallback, device presence, input safety, session cleanup, and measurable render health are treated as core product behavior."
        />
        <div className="mt-14 grid gap-5 lg:grid-cols-[1fr_1fr_0.62fr]">
          {principles.map((item) => (
            <article className="surface flex min-h-80 flex-col p-7 md:p-9" key={item.title}>
              <p className="hairline-title">{item.label}</p>
              <p className="mt-7 font-display text-2xl leading-9 tracking-tight">{item.title}</p>
              <p className="mt-auto pt-10 text-sm leading-7 text-cl-muted">{item.copy}</p>
            </article>
          ))}
          <article className="surface grid min-h-80 place-content-center p-7 text-center">
            <p className="tabular font-display text-7xl tracking-[-0.08em] text-cl-signal-bright">5</p>
            <p className="mt-4 text-sm leading-6 text-cl-muted">
              Adaptive encoder rungs represented in the native streaming engine.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

function FAQ() {
  const [open, setOpen] = useState(0);
  return (
    <section className="section border-t border-white/10" id="faq">
      <div className="container grid gap-14 lg:grid-cols-[0.65fr_1.35fr]">
        <SectionHeading eyebrow="Questions" title="What teams ask before they connect." />
        <div className="border-t border-white/10">
          {faqs.map((item, index) => (
            <div className="border-b border-white/10" key={item.question}>
              <ActionButton
                className="w-full !justify-between !rounded-none !px-0 !py-6 text-left font-display !text-lg !font-semibold [&>span]:w-full [&>span]:justify-between"
                variant="ghost"
                onClick={() => setOpen(open === index ? -1 : index)}
                aria-expanded={open === index}
                data-testid={`button-faq-${index}`}
              >
                <span className="text-cl-ink">{item.question}</span>
                <ChevronDown
                  className={`shrink-0 transition ${open === index ? "rotate-180" : ""}`}
                  size={18}
                  aria-hidden="true"
                />
              </ActionButton>
              {open === index && (
                <div className="cl-expand overflow-hidden">
                  <p className="max-w-2xl pb-6 text-sm leading-7 text-cl-muted">{item.answer}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  return (
    <section className="section-tight">
      <div className="container">
        <div className="surface grid-surface relative overflow-hidden px-7 py-16 text-center md:px-12 md:py-24">
          <div className="absolute left-1/2 top-1/2 size-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cl-signal/15 blur-[110px]" />
          <div className="relative mx-auto max-w-3xl">
            <p className="eyebrow">Open a controlled connection</p>
            <h2 className="display-lg mt-6">Support at speed. Evidence by default.</h2>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Button to="/order">Start an order</Button>
              <Button to="/contact" variant="secondary">
                Talk to the team
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function HomeContent() {
  return (
    <>
      <Hero />
      <TrustRail />
      <Platform />
      <ProductEcosystem />
      <MotionShowcase />
      <Security />
      <Workflow />
      <PricingPreview />
      <Proof />
      <FAQ />
      <FinalCTA />
    </>
  );
}
