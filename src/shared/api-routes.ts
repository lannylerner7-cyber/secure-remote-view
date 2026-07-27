/**
 * Central API route registry.
 *
 * Consumers that MUST stay in sync with this file:
 *   - Agent (C#):   agent/src/ApiClient.cs + agent/watcher/Program.cs
 *   - Admin (C#):   admin/src/Api/ApiClient.cs
 *   - Web admin:    src/routes/_authenticated/console.tsx
 *
 * /api/public/agent/enroll is gated by X-Deployment-Key (one-time, silent).
 * Every other /api/public/agent/* route MUST validate X-Device-Token.
 * The legacy /pair route is deprecated (410 Gone) — kept in the registry
 * so older agents surface a clean error instead of a 404.
 */
export const API_ROUTES = {
  // Agent → server
  agentEnroll: "/api/public/agent/enroll",
  agentHello: "/api/public/agent/hello",
  agentHeartbeat: "/api/public/agent/heartbeat",
  agentPair: "/api/public/agent/pair", // legacy — always 410 Gone

  agentReconnect: (sessionId: string) => `/api/public/agent/session/${sessionId}/reconnect`,
  agentConsent: (sessionId: string) => `/api/public/agent/session/${sessionId}/consent`,
  agentFrame: (sessionId: string) => `/api/public/agent/session/${sessionId}/frame`,
  agentInputs: (sessionId: string) => `/api/public/agent/session/${sessionId}/inputs`,
  agentSignal: (sessionId: string) => `/api/public/agent/session/${sessionId}/signal`,
  agentCursor: (sessionId: string) => `/api/public/agent/session/${sessionId}/cursor`,

  // One-time bootstrap (gated by BOOTSTRAP_TOKEN)
  adminBootstrap: "/api/public/admin/bootstrap",
} as const;


export const AGENT_HEADER = {
  deviceToken: "X-Device-Token",
  deviceId: "X-Device-Id",
  deploymentKey: "X-Deployment-Key",
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
