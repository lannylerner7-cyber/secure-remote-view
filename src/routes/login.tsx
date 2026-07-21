import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  head: () => ({
    meta: [
      { title: "Sign in — ConnectLive" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function LoginPage() {
  const navigate = useNavigate();
  const [technicianId, setTechnicianId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Technician IDs (e.g. 197200) map to internal email addresses.
    const email = /@/.test(technicianId)
      ? technicianId.trim()
      : `tech-${technicianId.trim()}@connectlive.internal`;

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError("Invalid credentials.");
      return;
    }
    navigate({ to: "/admin" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0F172A] px-4">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#1F2A44] p-8 shadow-2xl">
        <Link to="/" className="mb-6 flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full bg-[#4F7CFF]" />
          <span className="text-sm font-semibold text-white">ConnectLive</span>
        </Link>
        <h1 className="text-xl font-semibold text-white">Technician sign in</h1>
        <p className="mt-1 text-xs text-white/60">
          Use your ConnectLive technician ID.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-white/70">
              Technician ID
            </label>
            <input
              value={technicianId}
              onChange={(e) => setTechnicianId(e.target.value)}
              autoComplete="username"
              required
              className="mt-1 w-full rounded-md border border-white/10 bg-[#0F172A] px-3 py-2 text-sm text-white outline-none focus:border-[#4F7CFF]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-white/70">
              Password
            </label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded-md border border-white/10 bg-[#0F172A] px-3 py-2 text-sm text-white outline-none focus:border-[#4F7CFF]"
            />
          </div>
          {error && (
            <p className="rounded bg-red-500/15 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
          <button
            disabled={loading}
            className="w-full rounded-md bg-[#4F7CFF] py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
