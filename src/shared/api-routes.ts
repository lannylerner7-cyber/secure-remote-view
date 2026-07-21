/**
 * Central API route registry.
 * Import from BOTH the admin panel AND the C# agent doc so we can't drift.
 *
 * Every /api/public/agent/* route MUST validate X-Device-Token except `enroll`.
 */
export const API_ROUTES = {
  // Agent → server
  agentEnroll: "/api/public/agent/enroll",
  agentHello: "/api/public/agent/hello",
  agentHeartbeat: "/api/public/agent/heartbeat",
  agentPair: "/api/public/agent/pair",
  agentSessionPoll: (sessionId: string) => `/api/public/agent/session/${sessionId}`,
  agentConsent: (sessionId: string) => `/api/public/agent/session/${sessionId}/consent`,

  // One-time bootstrap (gated by BOOTSTRAP_TOKEN)
  adminBootstrap: "/api/public/admin/bootstrap",
} as const;

export const AGENT_HEADER = {
  deviceToken: "X-Device-Token",
  deviceId: "X-Device-Id",
} as const;
