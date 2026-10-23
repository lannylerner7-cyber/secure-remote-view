import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ArrowUpRight } from "lucide-react";
import { SiteLink } from "./adapter";

type Variant = "primary" | "secondary" | "ghost";

function buttonClass(variant: Variant, full?: boolean, className = "") {
  return `button button-${variant}${full ? " button-full" : ""} ${className}`;
}

export function Button({
  to,
  variant = "primary",
  full,
  className = "",
  children,
  ...rest
}: {
  to: string;
  variant?: Variant;
  full?: boolean;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <SiteLink href={to} className={buttonClass(variant, full, className)} {...rest}>
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
    </SiteLink>
  );
}

export function ActionButton({
  variant = "primary",
  full,
  children,
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; full?: boolean }) {
  return (
    <button type={type} className={buttonClass(variant, full, className)} {...props}>
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
    </button>
  );
}

export function Badge({ children, live }: { children: ReactNode; live?: boolean }) {
  return (
    <span className="badge">
      {live && <span className="status-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  copy,
  align = "left",
}: {
  eyebrow: string;
  title: string;
  copy?: string;
  align?: "left" | "center";
}) {
  return (
    <div className={align === "center" ? "mx-auto max-w-3xl text-center" : "max-w-3xl"}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="display-lg mt-6">{title}</h2>
      {copy && <p className="body-lg mt-6 max-w-2xl">{copy}</p>}
    </div>
  );
}

/** Scroll reveal: IntersectionObserver + CSS transition (replaces motion/react whileInView). */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // SSR and delayed hydration must never leave important content invisible.
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (node.getBoundingClientRect().top >= window.innerHeight) setVisible(false);
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -80px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`cl-reveal ${visible ? "is-visible" : ""} ${className}`}
      style={{ "--cl-delay": `${Math.round(delay * 1000)}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}

type FieldProps = { label: string; error?: string; help?: string; id: string };

export function TextField({
  label,
  error,
  help,
  id,
  ...props
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input
        id={id}
        className="field-control"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined}
        {...props}
      />
      {error && (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      )}
      {!error && help && (
        <span id={`${id}-help`} className="field-help">
          {help}
        </span>
      )}
    </label>
  );
}

export function SelectField({
  label,
  error,
  help,
  id,
  children,
  ...props
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <select id={id} className="field-control" {...props}>
        {children}
      </select>
      {error && <span className="field-error">{error}</span>}
      {!error && help && <span className="field-help">{help}</span>}
    </label>
  );
}

export function TextAreaField({
  label,
  error,
  help,
  id,
  ...props
}: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <textarea id={id} className="field-control" aria-invalid={Boolean(error)} {...props} />
      {error && <span className="field-error">{error}</span>}
      {!error && help && <span className="field-help">{help}</span>}
    </label>
  );
}

export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <SiteLink
      href={to}
      className="inline-flex items-center gap-2 text-sm font-semibold text-white hover:text-cl-signal-bright"
    >
      {children} <ArrowUpRight size={15} aria-hidden="true" />
    </SiteLink>
  );
}

export function LogoMark() {
  return (
    <span
      className="relative grid size-9 place-items-center overflow-hidden rounded-full border border-white/20 bg-white/5"
      aria-hidden="true"
    >
      <span className="absolute size-5 rounded-full bg-cl-signal/75 blur-sm" />
      <span className="relative size-2.5 rounded-full border border-white bg-cl-signal-bright shadow-[0_0_16px_var(--signal)]" />
    </span>
  );
}

/** Inline status panel used for errors, warnings and preview explanations. */
export function Notice({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "error" | "warning" | "success";
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    info: "border-cl-signal/30 bg-cl-signal/5",
    error: "border-cl-danger/35 bg-cl-danger/5",
    warning: "border-cl-warning/30 bg-cl-warning/5",
    success: "border-cl-success/30 bg-cl-success/5",
  } as const;
  const titleTone = {
    info: "text-cl-signal-bright",
    error: "text-cl-danger",
    warning: "text-cl-warning",
    success: "text-cl-success",
  } as const;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`cl-pop rounded-xl border p-5 text-sm leading-6 text-cl-muted ${tones[tone]}`}
    >
      {title && <p className={`mb-1 font-semibold ${titleTone[tone]}`}>{title}</p>}
      <div>{children}</div>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
