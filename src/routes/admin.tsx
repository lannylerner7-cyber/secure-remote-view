import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/admin")({
  component: LoginPage,
  head: () => ({
    meta: [
      { title: "Technician sign-in — ConnectLive" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function formatLockout(seconds: number) {
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} min`;
  return `${seconds}s`;
}

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

    try {
      const res = await fetch("/api/public/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: technicianId, password }),
      });
      const data = (await res.json()) as {
        session?: { access_token: string; refresh_token: string };
        error?: string;
        attemptsLeft?: number;
        lockedForSeconds?: number;
      };
      if (!res.ok || !data.session) {
        if (typeof data.lockedForSeconds === "number") {
          setError(
            `Account locked for ${formatLockout(data.lockedForSeconds)}. Try again later.`,
          );
        } else if (typeof data.attemptsLeft === "number") {
          setError(
            `Invalid credentials. ${data.attemptsLeft} attempt${data.attemptsLeft === 1 ? "" : "s"} left before a 1-hour lockout.`,
          );
        } else {
          setError(data.error ?? "Sign-in failed.");
        }
        setLoading(false);
        return;
      }
      const { error: setErr } = await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
      setLoading(false);
      if (setErr) {
        setError(setErr.message);
        return;
      }
      navigate({ to: "/console" });
    } catch {
      setLoading(false);
      setError("Network error. Please try again.");
    }
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
          Use your ConnectLive technician ID. Three failed attempts trigger a
          1-hour lockout.
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
