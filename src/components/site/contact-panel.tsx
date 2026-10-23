import { useState, type FormEvent } from "react";
import { CircleCheck, Headphones, LoaderCircle, Package, ShieldQuestion } from "lucide-react";
import { ActionButton, Badge, Button, Notice, TextAreaField, TextField } from "./ui";

export type ContactInput = { name: string; email: string; phone: string; message: string; source: string };
export type ContactResult = { ok: boolean; message: string; reference?: string | null };

/**
 * Figma contact layout on the existing contact contract (name, email, phone,
 * message, source) and the existing validation rules. Without `onSend`
 * (preview) submission explains that messaging is not connected.
 */
export function ContactPanel({ onSend }: { onSend?: (input: ContactInput) => Promise<ContactResult> }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", message: "" });
  const [errors, setErrors] = useState<Partial<typeof form>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [previewBlocked, setPreviewBlocked] = useState(false);

  const update = (key: keyof typeof form, value: string) => setForm((c) => ({ ...c, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next: Partial<typeof form> = {};
    if (form.name.trim().length < 2) next.name = "Please tell us your name.";
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) next.email = "Please enter a valid email address.";
    if (form.message.trim().length < 10) next.message = "Please add a little more detail to your message.";
    setErrors(next);
    setErr(null);
    if (Object.keys(next).length) return;
    if (!onSend) {
      setPreviewBlocked(true);
      return;
    }
    setBusy(true);
    try {
      const res = await onSend({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        message: form.message.trim(),
        source: "contact",
      });
      if (res.ok) {
        setDone(res.reference ?? "sent");
        setForm({ name: "", email: "", phone: "", message: "" });
      } else setErr(res.message);
    } catch {
      setErr("We couldn't send that just now. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <div className="container">
        <div className="grid gap-12 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
          <div>
            <Badge live>Response desk online</Badge>
            <h1 className="display-lg mt-7">Talk to people who understand the operation.</h1>
            <p className="body-lg mt-6">
              Tell us what's going on and the whole support team sees it. You'll get an instant
              confirmation, and a human reply inside one business day — usually much sooner.
            </p>
            <div className="mt-10 grid gap-3">
              <SupportLink icon={Package} title="Order help" copy="Questions about plan selection or provisioning." to="/order" />
              <SupportLink icon={ShieldQuestion} title="License lookup" copy="Find your access link or track an order." to="/license" />
              <SupportLink icon={Headphones} title="Setup guidance" copy="Plan an agent rollout and first live session." to="/#setup" />
            </div>
            <p className="mt-8 text-sm leading-7 text-cl-muted">
              If a live session is stuck right now, drop your order ID or meeting code into the
              message and it jumps the queue. Prefer plain email? Write to{" "}
              <a className="text-white underline underline-offset-4" href="mailto:support@connectliveagent.com">
                support@connectliveagent.com
              </a>
              .
            </p>
          </div>

          <div className="surface p-6 md:p-9">
            {done ? (
              <div className="cl-pop grid min-h-[30rem] place-content-center text-center">
                <CircleCheck className="mx-auto text-cl-success" size={56} aria-hidden="true" />
                <h2 className="display-md mt-7">Your message has been received.</h2>
                <p className="mx-auto mt-5 max-w-md text-sm leading-7 text-cl-muted">
                  Our support team will join you briefly — usually well inside one business day. A
                  copy has been emailed to you
                  {done !== "sent" && (
                    <>
                      {" "}under reference <strong className="text-white">{done}</strong>
                    </>
                  )}
                  .
                </p>
                <div className="mt-8">
                  <ActionButton variant="secondary" onClick={() => setDone(null)}>
                    Send another message
                  </ActionButton>
                </div>
              </div>
            ) : (
              <form onSubmit={submit} noValidate>
                <div className="flex items-center justify-between gap-3">
                  <p className="hairline-title">Contact request</p>
                  <span className="text-xs text-cl-faint">All fields except phone required</span>
                </div>
                <div className="mt-7 grid gap-5 md:grid-cols-2">
                  <TextField id="contact-name" label="Name" autoComplete="name" maxLength={80} value={form.name}
                    onChange={(e) => update("name", e.target.value)} error={errors.name} placeholder="Jane Okafor" data-testid="input-contact-name" />
                  <TextField id="contact-email" label="Email" type="email" autoComplete="email" maxLength={254} value={form.email}
                    onChange={(e) => update("email", e.target.value)} error={errors.email} placeholder="you@company.com" data-testid="input-contact-email" />
                  <div className="md:col-span-2">
                    <TextField id="contact-phone" label="Phone number (optional)" type="tel" autoComplete="tel" maxLength={40} value={form.phone}
                      onChange={(e) => update("phone", e.target.value)} placeholder="+1 555 000 1234" data-testid="input-contact-phone" />
                  </div>
                  <div className="md:col-span-2">
                    <TextAreaField id="contact-message" label="How can we help?" maxLength={4000} value={form.message}
                      onChange={(e) => update("message", e.target.value)} error={errors.message}
                      help={`${form.message.length}/4000`}
                      placeholder="Tell us what you need — order ID or meeting code helps us jump straight in." data-testid="input-contact-message" />
                  </div>
                </div>
                {err && <div className="mt-6"><Notice tone="error" title="Message not sent">{err}</Notice></div>}
                {previewBlocked && (
                  <div className="mt-6">
                    <Notice tone="warning" title="Messaging is not connected in this preview">
                      Nothing was sent. Email support@connectliveagent.com or use the live site to reach the team.
                    </Notice>
                  </div>
                )}
                <div className="mt-7 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="max-w-sm text-xs leading-5 text-cl-faint">
                    We only use these details to answer you. Nothing is shared, nothing is sold.
                  </p>
                  <ActionButton type="submit" disabled={busy} data-testid="button-contact-send">
                    {busy && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
                    {busy ? "Sending" : "Send message"}
                  </ActionButton>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SupportLink({ icon: Icon, title, copy, to }: { icon: typeof Package; title: string; copy: string; to: string }) {
  return (
    <Button className="!h-auto !justify-start !rounded-xl !p-4 text-left" to={to} variant="secondary" full>
      <Icon className="shrink-0 text-cl-signal-bright" size={19} aria-hidden="true" />
      <span>
        <span className="block text-sm">{title}</span>
        <span className="mt-1 block text-xs font-normal text-cl-faint">{copy}</span>
      </span>
    </Button>
  );
}
