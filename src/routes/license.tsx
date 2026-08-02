import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { lookupLicenseByEmail } from "@/lib/orders.functions";
import { Footer } from "@/components/Footer";

type License = {
  id: string;
  plan_code: string;
  amount_usd: number;
  access_link: string | null;
  created_at: string;
  status: string;
};

export const Route = createFileRoute("/license")({
  component: LicensePage,
  head: () => ({
    meta: [
      { title: "Look up your ConnectLive license" },
      {
        name: "description",
        content:
          "Enter the email you used at checkout to retrieve your ConnectLive license access link.",
      },
      { property: "og:title", content: "Look up your ConnectLive license" },
      {
        property: "og:description",
        content: "Recover the access link for a paid ConnectLive license.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function LicensePage() {
  const lookup = useServerFn(lookupLicenseByEmail);
  const [email, setEmail] = useState("");
  const [rows, setRows] = useState<License[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    setRows(null);
    try {
      const res = (await lookup({ data: { email } })) as License[];
      setRows(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#050B1F] text-white">
      <header className="border-b border-white/10 px-6 py-4">
        <Link to="/" className="text-sm text-white/70 hover:text-white">
          ← ConnectLive
        </Link>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-3xl font-semibold">Look up your license</h1>
        <p className="mt-2 text-sm text-white/60">
          Enter the email you used at checkout. We'll show your most recent paid licenses.
        </p>

        <form onSubmit={submit} className="mt-8 flex gap-2">
          <input
            required
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-[#4F7CFF]"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[#4F7CFF] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#3E67E0] disabled:opacity-50"
          >
            {busy ? "Searching…" : "Look up"}
          </button>
        </form>

        {err && (
          <div className="mt-6 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            {err}
          </div>
        )}

        {rows && rows.length === 0 && (
          <div className="mt-6 rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-white/60">
            No paid license found for that email. If you just paid, it may take a few minutes to
            confirm on-chain.
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="mt-6 space-y-3">
            {rows.map((r) => (
              <div key={r.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between text-xs text-white/50">
                  <span>Order {r.id.slice(0, 8)}</span>
                  <span>{new Date(r.created_at).toLocaleDateString()}</span>
                </div>
                <div className="mt-1 text-lg font-medium">
                  {r.plan_code}{" "}
                  <span className="text-sm text-white/50">
                    · ${Number(r.amount_usd).toFixed(2)}
                  </span>
                </div>
                {r.access_link ? (
                  <a
                    href={r.access_link}
                    className="mt-3 inline-block rounded-lg bg-[#4F7CFF] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3E67E0]"
                  >
                    Open access link →
                  </a>
                ) : (
                  <div className="mt-2 text-xs text-amber-200">
                    Payment confirmed — access link is being prepared. Try again shortly.
                  </div>
                )}
                <div className="mt-2 text-[11px] text-white/40">
                  <Link to="/order/$id" params={{ id: r.id }} className="hover:text-white">
                    View invoice →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-8 text-xs text-white/40">Rate-limited to 5 lookups per email per hour.</p>
      </main>
      <Footer />
    </div>
  );
}
