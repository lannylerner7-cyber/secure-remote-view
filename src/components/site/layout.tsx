import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, ChevronDown, LoaderCircle, Menu, X } from "lucide-react";
import { SiteLink, useNewsletter, usePathname } from "./adapter";
import { ActionButton, Badge, Button, LogoMark, TextField } from "./ui";

function AnnouncementBar() {
  return (
    <div className="relative z-[51] border-b border-white/10 bg-cl-signal text-cl-canvas">
      <div className="container flex min-h-9 items-center justify-center gap-3 py-1.5 text-center text-xs font-bold">
        <span className="font-mono uppercase tracking-[0.12em]">Promo pricing live</span>
        <span className="hidden opacity-70 sm:inline">
          Up to 46% off every plan. Delivery within one business day of payment.
        </span>
        <SiteLink
          className="inline-flex items-center gap-1 underline underline-offset-4"
          href="/plans"
          data-testid="link-announcement-plans"
        >
          View plans <ArrowRight size={13} aria-hidden="true" />
        </SiteLink>
      </div>
    </div>
  );
}

const MOBILE_LINKS: [string, string][] = [
  ["Platform", "/#platform"],
  ["Security", "/#security"],
  ["Plans", "/plans"],
  ["License lookup", "/license"],
  ["Contact", "/contact"],
];

function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [resources, setResources] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const mobileMenuRef = useRef<HTMLElement>(null);
  const resourcesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(false);
    setResources(false);
    if (!window.location.hash) window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 24);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  useEffect(() => {
    if (!resources) return;
    const onPointer = (event: PointerEvent) => {
      if (!resourcesRef.current?.contains(event.target as Node)) setResources(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [resources]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        setOpen(false);
        document.getElementById("mobile-menu-trigger")?.focus();
        return;
      }
      if (event.key === "Escape" && resources) {
        setResources(false);
        return;
      }
      if (event.key === "Tab" && open && mobileMenuRef.current) {
        const focusable = Array.from(
          mobileMenuRef.current.querySelectorAll<HTMLElement>("a, button"),
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, resources]);

  useEffect(() => {
    if (!open) return;
    mobileMenuRef.current?.querySelector("a")?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <header
        className={`sticky top-0 z-50 border-b transition ${
          scrolled
            ? "border-white/10 bg-cl-canvas/90 backdrop-blur-xl"
            : "border-transparent bg-cl-canvas/70 backdrop-blur-md"
        }`}
      >
        <div className="container flex min-h-20 items-center justify-between gap-6">
          <SiteLink
            className="flex items-center gap-3"
            href="/"
            aria-label="ConnectLive home"
            data-testid="link-home"
          >
            <LogoMark />
            <span className="font-display text-lg font-semibold tracking-[-0.04em]">
              ConnectLive
            </span>
          </SiteLink>

          <nav
            className="hidden items-center gap-7 text-sm text-cl-muted lg:flex"
            aria-label="Primary navigation"
          >
            <SiteLink className="transition hover:text-white" href="/#platform" data-testid="link-nav-platform">
              Platform
            </SiteLink>
            <SiteLink className="transition hover:text-white" href="/#security" data-testid="link-nav-security">
              Security
            </SiteLink>
            <SiteLink className="transition hover:text-white" href="/plans" data-testid="link-nav-plans">
              Plans
            </SiteLink>
            <div className="relative" ref={resourcesRef}>
              <ActionButton
                className="!min-h-0 !p-0 !font-normal text-cl-muted hover:text-white"
                variant="ghost"
                aria-expanded={resources}
                aria-haspopup="true"
                onClick={() => setResources((value) => !value)}
                data-testid="button-nav-resources"
              >
                Resources{" "}
                <ChevronDown
                  size={14}
                  className={`transition ${resources ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </ActionButton>
              {resources && (
                <div className="absolute left-1/2 top-10 w-56 -translate-x-1/2">
                  <div className="surface cl-pop grid gap-1 p-2">
                    {[
                      ["License lookup", "/license"],
                      ["Track an order", "/license#track"],
                      ["Setup guidance", "/#workflow"],
                      ["Contact", "/contact"],
                    ].map(([label, href]) => (
                      <SiteLink
                        key={label}
                        className="rounded-lg px-4 py-3 text-sm text-cl-muted hover:bg-white/5 hover:text-white"
                        href={href}
                        onClick={() => setResources(false)}
                      >
                        {label}
                      </SiteLink>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </nav>

          <div className="flex items-center gap-2">
            <SiteLink
              className="hidden text-sm font-semibold text-cl-muted hover:text-white md:block"
              href="/license"
              data-testid="link-header-license"
            >
              License lookup
            </SiteLink>
            <Button className="!min-h-10 !px-4" to="/order" data-testid="link-header-order">
              Start an order
            </Button>
            <span className="lg:hidden"><ActionButton
              id="mobile-menu-trigger"
              className="!size-10 !min-h-10 !p-0 lg:hidden"
              variant="secondary"
              aria-label={open ? "Close navigation" : "Open navigation"}
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              data-testid="button-mobile-menu"
            >
              {open ? <X size={18} /> : <Menu size={18} />}
            </ActionButton></span>
          </div>
        </div>
      </header>

      {open && (
        <div
          className="cl-slide fixed inset-x-0 bottom-0 top-[7.25rem] z-40 overflow-y-auto bg-cl-canvas/[0.98] p-6 backdrop-blur-xl lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Site navigation"
        >
          <nav ref={mobileMenuRef} className="container grid gap-2" aria-label="Mobile navigation">
            {MOBILE_LINKS.map(([label, to]) => (
              <SiteLink
                key={to}
                className="border-b border-white/10 py-5 font-display text-3xl tracking-tight"
                href={to}
                onClick={() => setOpen(false)}
              >
                {label}
              </SiteLink>
            ))}
            <div className="mt-8">
              <Button to="/order" full>
                Start an order
              </Button>
            </div>
          </nav>
        </div>
      )}
    </>
  );
}

function NewsletterForm() {
  const subscribe = useNewsletter();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (state === "sending") return;
    if (!/^\S+@\S+\.\S+$/.test(value)) {
      setState("error");
      setMessage("Enter a valid email address.");
      return;
    }
    setState("sending");
    setMessage("");
    try {
      const res = await subscribe(value);
      setState(res.ok ? "done" : "error");
      setMessage(res.message);
      if (res.ok) setEmail("");
    } catch {
      setState("error");
      setMessage("That didn't go through. Check the address and try again.");
    }
  };

  return (
    <>
      <form className="mt-5 flex gap-2" onSubmit={submit} noValidate>
        <div className="min-w-0 flex-1">
          <TextField
            id="newsletter"
            name="email"
            label="Email address"
            type="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ops@company.com"
            data-testid="input-newsletter-email"
          />
        </div>
        <ActionButton
          type="submit"
          className="mt-[1.62rem] !size-[3.25rem] shrink-0 !p-0"
          aria-label="Subscribe"
          disabled={state === "sending"}
          data-testid="button-newsletter-subscribe"
        >
          {state === "sending" ? (
            <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
          ) : (
            <ArrowRight size={18} aria-hidden="true" />
          )}
        </ActionButton>
      </form>
      {message && (
        <p
          className={`mt-3 text-xs ${state === "error" ? "text-cl-danger" : state === "done" ? "text-cl-success" : "text-cl-muted"}`}
          aria-live="polite"
          data-testid="status-newsletter"
        >
          {message}
        </p>
      )}
    </>
  );
}

function FooterGroup({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="hairline-title">{title}</p>
      <ul className="mt-5 grid gap-3 text-sm text-cl-muted">
        {links.map(([label, to]) => (
          <li key={to + label}>
            <SiteLink className="hover:text-white" href={to}>
              {label}
            </SiteLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/10 bg-[#020203]">
      <div className="container py-16 lg:py-24">
        <div className="surface grid gap-8 overflow-hidden p-7 md:p-10 lg:grid-cols-[1.4fr_0.6fr] lg:items-end">
          <div>
            <p className="eyebrow">Ready when you are</p>
            <h2 className="display-md mt-5 max-w-3xl">Put every support session on the record.</h2>
          </div>
          <div className="flex flex-wrap gap-3 lg:justify-end">
            <Button to="/order">Start an order</Button>
            <Button to="/contact" variant="secondary">
              Contact us
            </Button>
          </div>
        </div>

        <div className="grid gap-12 py-16 md:grid-cols-2 lg:grid-cols-[1.4fr_0.7fr_0.7fr_1.2fr]">
          <div className="max-w-sm">
            <div className="flex items-center gap-3">
              <LogoMark />
              <span className="font-display text-xl font-semibold">ConnectLive</span>
            </div>
            <p className="mt-5 text-sm leading-7 text-cl-muted">
              Authorized remote operations for teams that need speed, visible control, and a
              defensible audit trail.
            </p>
            <div className="mt-6">
              <Badge live>Systems operational</Badge>
            </div>
          </div>
          <FooterGroup
            title="Product"
            links={[
              ["Platform", "/#platform"],
              ["Security", "/#security"],
              ["Plans", "/plans"],
              ["Order", "/order"],
            ]}
          />
          <FooterGroup
            title="Support"
            links={[
              ["License lookup", "/license"],
              ["Track an order", "/license#track"],
              ["Contact", "/contact"],
              ["support@connectliveagent.com", "mailto:support@connectliveagent.com"],
            ]}
          />
          <div>
            <p className="hairline-title">Field notes</p>
            <p className="mt-4 text-sm leading-6 text-cl-muted">
              Release notes, promo drops, and setup guides. One email when there is something worth
              reading.
            </p>
            <NewsletterForm />
          </div>
        </div>

        <div className="flex flex-col gap-5 border-t border-white/10 pt-7 text-xs text-cl-faint md:flex-row md:items-center md:justify-between">
          <div>
            <p>© {new Date().getFullYear()} ConnectLive. Authorised remote support.</p>
            <p className="mt-2 max-w-3xl leading-5">
              CONNECTLIVE LLC · EIN 42-4280821 · Name control CONN · Registered U.S. limited
              liability company. Tax records on file for periods 2021–2026.
            </p>
          </div>
          <div className="flex flex-wrap gap-5">
            <SiteLink className="hover:text-white" href="/privacy">
              Privacy
            </SiteLink>
            <SiteLink className="hover:text-white" href="/terms">
              Terms
            </SiteLink>
            <SiteLink className="hover:text-white" href="/refund">
              Refunds
            </SiteLink>
          </div>
        </div>
      </div>
    </footer>
  );
}

/** Public website shell — every rule of the Figma design system is scoped under `.cl-site`. */
export function SiteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="cl-site">
      <div className="noise" aria-hidden="true" />
      <AnnouncementBar />
      <Header />
      <main key={pathname} className="cl-page">
        {children}
      </main>
      <Footer />
    </div>
  );
}
