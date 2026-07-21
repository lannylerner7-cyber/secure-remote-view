import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="inline-block h-3.5 w-3.5 rounded-full bg-[#4F7CFF]" />
            <span className="text-lg font-semibold tracking-tight text-[#1F2A44]">
              ConnectLive
            </span>
          </div>
          <nav className="flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#how" className="hover:text-foreground">How it works</a>
            <a href="#trust" className="hover:text-foreground">Trust</a>
            <a
              href="/login"
              className="rounded-md bg-[#1F2A44] px-4 py-2 font-medium text-white hover:opacity-90"
            >
              Admin sign in
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        <section className="grid gap-10 py-20 md:grid-cols-2 md:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-[#4F7CFF]">
              Transparent remote support
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[#1F2A44] md:text-5xl">
              Help your team, with their consent — every single time.
            </h1>
            <p className="mt-5 max-w-lg text-base text-muted-foreground">
              ConnectLive is a helpdesk platform for IT teams. Every screen-share
              and remote-control session opens with a fresh consent prompt and a
              persistent on-screen indicator. Full audit trail, no hidden viewing.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="/login"
                className="rounded-md bg-[#4F7CFF] px-5 py-3 text-sm font-semibold text-white hover:opacity-90"
              >
                Open admin panel
              </a>
              <a
                href="#agent"
                className="rounded-md border border-border px-5 py-3 text-sm font-semibold text-[#1F2A44] hover:bg-secondary"
              >
                Download Windows agent
              </a>
            </div>
          </div>

          <div className="relative">
            <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
              <div className="flex items-center gap-2 border-b border-border pb-3">
                <span className="h-2.5 w-2.5 rounded-full bg-[#4F7CFF]" />
                <span className="text-sm font-medium text-[#1F2A44]">
                  Sharing with Helpdesk
                </span>
                <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                  View only
                </span>
              </div>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Session</span>
                  <span className="font-mono text-xs">cl_9f4a…e21b</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Consent</span>
                  <span className="font-medium text-[#1F9D6B]">Granted 12:04</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Control</span>
                  <span className="text-muted-foreground">Not granted</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Route</span>
                  <span>Direct (P2P)</span>
                </div>
              </div>
              <button className="mt-5 w-full rounded-md border border-border py-2 text-sm font-medium text-[#1F2A44] hover:bg-secondary">
                End session
              </button>
            </div>
          </div>
        </section>

        <section id="how" className="border-t border-border py-16">
          <h2 className="text-2xl font-semibold tracking-tight text-[#1F2A44]">
            How a session works
          </h2>
          <div className="mt-8 grid gap-6 md:grid-cols-4">
            {[
              { n: "01", t: "Enroll once", d: "Signed agent is deployed via MDM/GPO and registers with your gateway." },
              { n: "02", t: "Ask", d: "Technician requests a session. User sees a native prompt on their desktop." },
              { n: "03", t: "Allow", d: "Screen sharing starts only after Allow. Control needs a second grant." },
              { n: "04", t: "Audit", d: "Every action recorded — actor, target, duration, control status." },
            ].map((s) => (
              <div key={s.n} className="rounded-xl border border-border bg-card p-5">
                <div className="text-xs font-mono text-[#4F7CFF]">{s.n}</div>
                <div className="mt-2 font-semibold text-[#1F2A44]">{s.t}</div>
                <p className="mt-1 text-sm text-muted-foreground">{s.d}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="trust" className="border-t border-border py-16">
          <h2 className="text-2xl font-semibold tracking-tight text-[#1F2A44]">
            The clean road
          </h2>
          <ul className="mt-6 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
            <li className="rounded-lg border border-border p-4">
              <span className="font-medium text-[#1F2A44]">Consent is never optional.</span>{" "}
              Every session opens in pending-consent state.
            </li>
            <li className="rounded-lg border border-border p-4">
              <span className="font-medium text-[#1F2A44]">Always visible.</span>{" "}
              Persistent banner + tray icon for the full session — cannot be hidden.
            </li>
            <li className="rounded-lg border border-border p-4">
              <span className="font-medium text-[#1F2A44]">Separate control grant.</span>{" "}
              View-only and remote control are two distinct permissions.
            </li>
            <li className="rounded-lg border border-border p-4">
              <span className="font-medium text-[#1F2A44]">Signed, not smuggled.</span>{" "}
              Code-signed binaries deployed through normal IT channels. No Defender exclusions to conceal activity.
            </li>
          </ul>
        </section>

        <section id="agent" className="border-t border-border py-16">
          <h2 className="text-2xl font-semibold tracking-tight text-[#1F2A44]">
            Windows agent
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
            The agent source lives in <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">agent/</code>.
            Build it on your own signing box with <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">./build.ps1</code>,
            then Authenticode-sign and deploy via MDM/GPO. See <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">agent/README.md</code>.
          </p>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 text-xs text-muted-foreground">
          <span>© ConnectLive</span>
          <span>Transparent by construction.</span>
        </div>
      </footer>
    </div>
  );
}
