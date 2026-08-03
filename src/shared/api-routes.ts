/**
 * Central API route registry.
 *
 * Consumers that MUST stay in sync with this file:
 *   - Agent (C#):   agent/src/ApiClient.cs
 *   - Admin (C#):   admin/src/Api/ApiClient.cs
 *   - Web admin:    src/routes/_authenticated/console.tsx
 *
 * /api/public/agent/enroll is keyless and IP-throttled: it mints a device
 * token on first contact. Every other /api/public/agent/* route MUST validate
 * X-Device-Id + X-Device-Token. The legacy /pair route and the X-Deployment-Key header
 * are gone — neither the routes nor the clients reference them any more.
 */
export const API_ROUTES = {
  // Agent → server
  agentEnroll: "/api/public/agent/enroll",
  agentHello: "/api/public/agent/hello",
  agentHeartbeat: "/api/public/agent/heartbeat",
  /** SSE wake channel. Consumed by agent/src/StreamListener.cs, which nudges
   *  the heartbeat loop on `event: wake` so revival is sub-second instead of
   *  waiting a full heartbeat tick. Heartbeat stays the source of truth. */
  agentStream: "/api/public/agent/stream",
  /** S9 — ICE gateway. STUN always, TURN when TURN_URLS is configured.
   *  Authed by device token (agent) or Supabase bearer JWT (technician).
   *  Every peer fetches this before building an RTCPeerConnection and falls
   *  back to hardcoded STUN if the call fails. */
  agentIce: "/api/public/agent/ice",

  agentReconnect: (sessionId: string) => `/api/public/agent/session/${sessionId}/reconnect`,
  agentConsent: (sessionId: string) => `/api/public/agent/session/${sessionId}/consent`,
  agentFrame: (sessionId: string) => `/api/public/agent/session/${sessionId}/frame`,
  agentInputs: (sessionId: string) => `/api/public/agent/session/${sessionId}/inputs`,
  agentSignal: (sessionId: string) => `/api/public/agent/session/${sessionId}/signal`,
  agentCursor: (sessionId: string) => `/api/public/agent/session/${sessionId}/cursor`,
  agentPowerAck: (cmdId: string) => `/api/public/agent/power/${cmdId}/ack`,

  // Shared infrastructure
  health: "/api/public/health",

  // Admin auth (native console + lockout-aware login)
  authLogin: "/api/public/auth/login",

  // One-time bootstrap (gated by BOOTSTRAP_TOKEN)
  adminBootstrap: "/api/public/admin/bootstrap",
} as const;


export const AGENT_HEADER = {
  deviceToken: "X-Device-Token",
  deviceId: "X-Device-Id",
} as const;

/**
 * Payment / order routes. Public-facing surface for the buyer funnel,
 * CDP webhook, cron reconciler, and the paid-orders ticker.
 */
export const PAYMENT_ROUTES = {
  webhookCdp: "/api/public/webhooks/cdp",
  cronReconcileOrders: "/api/public/cron/reconcile-orders",
  statsOrders: "/api/public/stats/orders",
  buyerOrder: "/order",
  buyerInvoice: (id: string) => `/order/${id}`,
  buyerLicense: "/license",
} as const;
