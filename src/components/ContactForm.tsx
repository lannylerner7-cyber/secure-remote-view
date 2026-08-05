import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { submitContactMessage } from "@/lib/contact.functions";

/**
 * Shared contact form. One component behind every "Contact us" button on the
 * site, so the marketing page and the customer portal submit the exact same
 * payload to the exact same server function.
 */

const field =
  "mt-1 w-full rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none transition focus:border-[#4F7CFF]/70 focus:bg-white/[0.06]";
const label = "text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45";

export function ContactForm({ source = "contact" }: { source?: string }) {
  const send = useServerFn(submitContactMessage);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    if (name.trim().length < 2) return toast.error("Please tell us your name.");
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return toast.error("Please enter a valid email address.");
    if (message.trim().length < 10) return toast.error("Please add a little more detail to your message.");

    setBusy(true);
    try {
      const res = await send({
        data: {
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          message: message.trim(),
          source,
        },
      });
      if (res.ok) {
        toast.success("Your message has been received", {
          description: "Our support team will join you briefly.",
        });
        setDone(res.reference ?? "sent");
        setName("");
        setEmail("");
        setPhone("");
        setMessage("");
      } else {
        toast.error(res.message);
      }
    } catch {
      toast.error("We couldn't send that just now. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-2xl border border-[#4F7CFF]/30 bg-[#4F7CFF]/10 p-6">
        <p className="text-sm font-semibold text-white">Your message has been received</p>
        <p className="mt-2 text-sm leading-relaxed text-white/70">
          Our support team will join you briefly — usually well inside one business day. A copy has
          been emailed to you{done !== "sent" ? <> under reference <strong className="text-white">{done}</strong></> : null}.
        </p>
        <button
          type="button"
          onClick={() => setDone(null)}
          className="mt-4 text-xs font-semibold text-[#4F7CFF] hover:underline"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <span className={label}>Name</span>
          <input
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Okafor"
            maxLength={80}
            autoComplete="name"
            required
          />
        </div>
        <div>
          <span className={label}>Email</span>
          <input
            className={field}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            maxLength={254}
            autoComplete="email"
            required
          />
        </div>
      </div>

      <div className="mt-4">
        <span className={label}>Phone number</span>
        <input
          className={field}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 555 000 1234 (optional)"
          maxLength={40}
          autoComplete="tel"
        />
      </div>

      <div className="mt-4">
        <span className={label}>Message</span>
        <textarea
          className={`${field} min-h-[140px] resize-y`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Tell us what you need — order ID or meeting code helps us jump straight in."
          maxLength={4000}
          required
        />
        <p className="mt-1 text-right text-[11px] text-white/30">{message.length}/4000</p>
      </div>

      <button
        type="submit"
        disabled={busy}
        className="mt-4 w-full rounded-lg bg-[#4F7CFF] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#3B67E8] disabled:opacity-60 sm:w-auto"
      >
        {busy ? "Sending…" : "Send message"}
      </button>

      <p className="mt-3 text-[11px] leading-relaxed text-white/40">
        We only use these details to answer you. Nothing is shared, nothing is sold.
      </p>
    </form>
  );
}
