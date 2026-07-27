/**
 * Central API route registry.
 * Import from BOTH the admin panel AND the C# agent doc so we can't drift.
 *
 * /api/public/agent/enroll is gated by X-Deployment-Key (one-time, silent).
 * Every other /api/public/agent/* route MUST validate X-Device-Token.
 * The legacy /pair route is deprecated (410 Gone).
 */
export const API_ROUTES = {
  // Agent → server
  agentEnroll: "/api/public/agent/enroll",
  agentHello: "/api/public/agent/hello",
  agentHeartbeat: "/api/public/agent/heartbeat",
  agentSessionPoll: (sessionId: string) => `/api/public/agent/session/${sessionId}`,
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
