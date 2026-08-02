import { createFileRoute } from "@tanstack/react-router";

const MAX_FAILURES = 3;
const LOCK_MINUTES = 60;

type Body = { identifier?: string; password?: string };

function getIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}

function toEmail(identifier: string) {
  const id = identifier.trim();
  if (!id) return null;
  return /@/.test(id) ? id.toLowerCase() : `tech-${id}@connectlive.internal`;
}

export const Route = createFileRoute("/api/public/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const email = body.identifier ? toEmail(body.identifier) : null;
        const password = body.password ?? "";
        if (!email || !password) {
          return Response.json({ error: "Missing credentials" }, { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const key = email.toLowerCase();

        // 1. Check existing lockout state.
        const { data: attempt } = await supabaseAdmin
          .from("login_attempts")
          .select("failures, locked_until")
          .eq("identifier", key)
          .maybeSingle();

        const now = Date.now();
        if (attempt?.locked_until && new Date(attempt.locked_until).getTime() > now) {
          const remainingMs = new Date(attempt.locked_until).getTime() - now;
          return Response.json(
            {
              error: "Account temporarily locked",
              lockedForSeconds: Math.ceil(remainingMs / 1000),
            },
            { status: 423 },
          );
        }

        // 2. Attempt the sign-in via the admin client (validates password without persisting).
        const { createClient } = await import("@supabase/supabase-js");
        const authClient = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );
        const { data: signIn, error } = await authClient.auth.signInWithPassword({
          email,
          password,
        });

        const ip = getIp(request);

        if (error || !signIn?.session) {
          // 3. Record failure & possibly lock.
          const newFailures = (attempt?.failures ?? 0) + 1;
          const shouldLock = newFailures >= MAX_FAILURES;
          const lockedUntil = shouldLock
            ? new Date(now + LOCK_MINUTES * 60 * 1000).toISOString()
            : null;
          await supabaseAdmin.from("login_attempts").upsert(
            {
              identifier: key,
              failures: shouldLock ? 0 : newFailures,
              locked_until: lockedUntil,
              last_ip: ip,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "identifier" },
          );
          if (shouldLock) {
            return Response.json(
              {
                error: "Too many failed attempts. Account locked for 1 hour.",
                lockedForSeconds: LOCK_MINUTES * 60,
              },
              { status: 423 },
            );
          }
          return Response.json(
            {
              error: "Invalid credentials",
              attemptsLeft: MAX_FAILURES - newFailures,
            },
            { status: 401 },
          );
        }

        // 4. Success — reset counter and return the session for client hydration.
        await supabaseAdmin
          .from("login_attempts")
          .upsert(
            {
              identifier: key,
              failures: 0,
              locked_until: null,
              last_ip: ip,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "identifier" },
          );

        return Response.json({
          session: {
            access_token: signIn.session.access_token,
            refresh_token: signIn.session.refresh_token,
          },
        });
      },
    },
  },
});
