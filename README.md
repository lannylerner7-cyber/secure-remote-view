# Consent Remote

Skip to content
#1 - Helpdesk Remote-Support Platform
What & Why
Build a transparent, consent-based IT helpdesk remote-support platform: a web admin panel where IT staff see enrolled Windows machines, pick one, and open a live screen-share session with an optional remote-control toggle. It is powered by a small mesh of APIs coordinated by a single "leader" gateway. This plan covers what is buildable and testable in this workspace (the API mesh + admin console + a browser-based device simulator) and documents the native Windows agent design as guidance for out-of-workspace work.

Non-negotiable design principle (the "clean road"): every view/control session is visible to and consented by the end user. A device stays enrolled across reboots for convenience, but enrollment is not silent viewing — each session requires a fresh consent handshake and shows a persistent on-screen indicator. No detection-evasion, no hidden indicators, no Defender exclusions used to conceal activity. Binaries are code-signed and deployed via MDM/GPO through normal IT channels.

API parts (each defined clearly; the Gateway is the leader that plugs the rest in)
Gateway API (leader / control plane) — the single entrypoint. Handles admin auth, device enrollment, the device registry (online/offline presence), and orchestration: it asks the Session API to open sessions, requests channels from the Signaling API, and reads the Health API to choose the primary-vs-fallback path. The other services register with it; it is the one coordination point everyone talks through.
Session API — owns session lifecycle and consent: create session (pending-consent), end-user consent handshake, state transitions (pending → view → control → ended), the view-only ↔ remote-control mode grant (control needs a separate explicit grant), and the per-session audit log.
Signaling / Relay API — the live real-time channel: WebRTC signaling (SDP/ICE exchange) for browser screen share device→admin, the control channel (admin→device input events, only while control is granted), and a fallback relay route (TURN-style relay) used when direct peer-to-peer fails.
Health / Registry API — liveness and discovery: downstream services and devices heartbeat here; the Gateway uses it for presence in the admin panel and to decide when to switch a session to the fallback relay route.
Standout features (transparent by construction)
Real-time device list with presence, last-seen, OS/version, and current session state.
One-click session start with a clear consent prompt; separate explicit grant to escalate from view-only to remote control.
Persistent, obvious on-screen session indicator while a session is active; end user can revoke/end at any time.
Full audit trail (who connected, to which device, when, duration, whether control was granted) — exportable for compliance.
Automatic fallback relay when direct connection fails, so sessions "just work" behind NAT/firewalls.
Gateway as a single pane of glass that health-checks and coordinates the whole mesh.
Done looks like
An admin can log into the web panel and see a live list of enrolled devices with online/offline status.
Clicking a device opens a session that shows a consent state; once consented, the admin sees the live screen share in the browser.
A view/control toggle switches between watch-only and remote control; control is only possible after an explicit grant.
When a direct connection can't be established, the session falls back to the relay route automatically and still works.
Every session appears in an audit log with actor, target, timestamps, duration, and control status.
A browser-based "device simulator" page can act as a stand-in endpoint so the full flow (enroll → presence → consent → screen share → control → audit) is demonstrable end-to-end without the native agent.
Out of scope
Building/compiling/signing the native Windows agent (can't be compiled, signed, or tested in this workspace). Its design is documented below as guidance only.
Any detection-evasion, hidden/минimized session indicators, silent persistence, or Defender-exclusion-to-conceal behavior — explicitly excluded.
MDM/GPO deployment tooling and certificate issuance (normal IT process, outside this build).
Unattended/always-on access modes beyond enrollment; if added later they must remain visibly indicated and audited.
Native Windows agent — design guidance (documented, not built here)
Language: recommend C#/.NET (clean Windows Service + WinUI/tray indicator + Authenticode signing story) or Go/Rust for a single static signed binary.
Shape: a Windows Service for enrollment/heartbeat/persistence across reboots, plus a per-user-session tray app that renders the visible session indicator and the consent UI.
Capture/control: Windows.Graphics.Capture or DXGI for frames; standard input APIs only, and only while a control grant is active. No global keyboard hooks.
Trust: internal PKI code-signing deployed via MDM/GPO to Trusted Publishers; folder exclusion (if any) is for performance on a visible, signed tool — never to hide activity.
Registration vs. viewing: the service auto-starts and re-registers with the Gateway after reboot so IT need not reinstall, but it never begins capture without a fresh per-session consent + on-screen indicator.
Steps
Define the API contract — model devices, enrollment, sessions, consent state, control grants, audit entries, health/heartbeat, and signaling exchange in the OpenAPI spec; then run codegen so the admin panel and services share generated types/hooks/schemas.
Gateway (leader) service — admin auth, device enrollment + registry, presence, and orchestration endpoints that coordinate the Session/Signaling/Health services and expose the admin panel's backend.
Session service — session lifecycle, the consent handshake, view/control mode grants, and the audit log.
Signaling/Relay service — WebRTC signaling, the control channel, and the automatic fallback relay route with selection driven by health/connection state.
Health/Registry service — service + device heartbeats and the presence/fallback signals the Gateway consumes.
Web admin panel — device list with live presence, session start with visible consent state, in-browser live screen-share viewer, view/control toggle, and the audit-log view.
Browser device simulator — a page that enrolls as a fake device and shares a tab/screen so the entire flow is demonstrable end-to-end in this workspace, including the visible session indicator and consent prompt.
Persistence & audit — store devices, sessions, consent/control events, and audit entries in the database so state survives restarts and the audit trail is durable.
Relevant files
lib/api-spec/openapi.yaml
artifacts/api-server/src/app.ts
artifacts/api-server/src/routes/index.ts
artifacts/api-server/src/routes/health.ts
lib/db/src/schema/index.ts
Active task
Helpdesk Remote-Support Platform
And the plan laid

2 hours ago
Codegen passed typecheck. Let me grep the generated hook and schema names so I pass exact identifiers to the design subagent.

I have exact identifiers. Let me locate the Zod output and read the key backend files I'll modify, in one batch.

No artifact.toml in the api-server dir — let me find where artifact service config and proxy paths live, and confirm the WebSocket setup requirements.

Now I understand the artifact config. Let me read the skills I need for the WebSocket setup and for launching the design subagent correctly.

I have what I need. This build has a delicate real-time engine (WebRTC + relay fallback) at its core — I'll own that module myself for reliability and let the design subagent focus on UI. Let me start with the shared realtime client library the frontend depends on.

Design subagent needs exact hook signatures. Let me grep the generated mutation/query signatures precisely.

I have all the hook signatures. Now I'll launch the design subagent (background) with a complete brief, then build the backend in parallel while it works.

Design subagent is running. Now I'll build the backend in parallel. First, let me check the Zod response exports (to validate responses like the health route does) and how the DB package pushes schema.

DB uses drizzle-kit push. Now I'll write the backend in batches while the design subagent works. Batch 1: DB schema, API types, auth, store, and seed.

Now the store (DB access + shape mapping) and seed.

Now the realtime WS server, auth middleware, all route handlers, and server wiring.

Now the middleware, all routers, and server wiring in one batch.

Now add the ws dependency and wire everything up. Let me update the api-server package.json, then install, push the DB schema, and typecheck.

Install succeeded. Now push the DB schema and typecheck the backend in parallel.

DB schema pushed. Now typecheck the backend.

Two issues: schema tables are exported from a subpath, and Express 5 query typing. Let me check the db index and the exact lines.

The db error means it's resolving stale build output, and the param errors are Express 5 route-param typing. Let me inspect the tsconfigs and db build setup.

Root cause: lib/db's built declarations (dist/schema) are stale/empty from when the schema was empty, and the Express 5 route params type as string | string[]. Let me fix the param coercion and rebuild the db declarations.

Now rebuild the stale db declarations, then re-typecheck the backend.

Backend typechecks cleanly. Let me restart the API server to load the new code and verify it comes up.

API server is healthy — realtime initialized, listening, sample devices seeded. The design subagent finished the frontend. Let me start the admin workflow and typecheck the frontend in parallel.

The frontend has query-option typing errors — the subagent passed options without the required queryKey. Let me check the generated hook signature and the offending files.

The hooks require an explicit queryKey when passing query options (an Orval typing quirk). Let me read the offending lines and fix them with the generated query-key helpers.

Now re-run the frontend typecheck to confirm the fixes.

Both frontend and backend typecheck cleanly and all workflows are running. Let me verify the API endpoints and capture the login page in parallel.

API behaves exactly as designed (health ok, login 503 until password set, auth-gated 401, enroll works). Let me verify the frontend renders — the login page and the public simulator.

Both pages render cleanly with a professional, no-emoji design. The core API and frontend are working. Now I need to handle the admin password so the authenticated flow works. Let me read the environment-secrets skill first (required before any secret operation) and clean up the test device I created.

The skill confirms secrets must go through requestSecrets (which ends the turn) — I must not set ADMIN_PASSWORD myself. Test device cleaned up. Before requesting the password, let me run the architect code review now while I have full context, since it's independent of the password.

The review found real, severe authorization gaps that break the core consent-first invariant — a technician could self-grant consent/control. These must be fixed. Let me examine the client-fetch layer and the device/viewer pages to wire device-bound auth correctly.

custom-fetch supports per-call headers via the hook's request option, so I can bind a device token header. The review is correct — I need device-bound auth on consent/control-grant plus atomic state guards. Let me read the viewer page and confirm the mutation hook's request param before implementing.

The mutation hooks accept a request option for per-call headers — exactly what I need for device-bound auth. Let me read the core backend files I need to modify.

I have the full picture now. The review's findings are valid and I'll fix all of them. Let me read the server realtime file to fix the viewer-hello hijack guard without breaking the relay logic.

The review's findings are valid and important. Before editing, I need the current devices.ts (heartbeat/enroll) to extend device-bound auth consistently. Let me read it, then apply all fixes.

The review's findings are valid and I'll fix all of them: device-bound auth on consent/control/end/heartbeat, atomic session-transition guards, atomic device claim, and the realtime viewer-hello hijack guard. Applying all backend + simulator fixes now.

Now update the sessions route to use the new device-bound auth and SessionMutation results.

Now let me typecheck both packages and verify no leftover references to the removed helpers.

Both typechecks pass and no stale references remain. Let me restart the API server and verify the new security gates with curl (device-token auth + state-machine 409s).

API server is clean. Let me check the sessions table columns so my psql-seeded session is valid, then run the full security-gate verification.

Schema confirmed. Now let me run a full security-gate verification: enroll a device, seed a pending session in the DB, then exercise every new auth/state guard (403 without device token, 409 on illegal transitions, 401 heartbeat without token), and clean up.

The 000 means curl couldn't connect — $REPLIT_DEV_DOMAIN has no scheme. Let me re-run with https://.

The heartbeat gates passed (401 without token, 200 with). The session tests returned 000 only because psql's "INSERT 0 1" tag polluted the captured session ID. Let me re-run with a clean ID extraction.

All security gates pass exactly as intended: 403 without/with-wrong device token, 409 on illegal state transitions (grant-before-request, double-consent, double-end), 403 for technician-only and unauthenticated actions, and the happy path (200 → active/granted, 200 → ended). Combined with the earlier heartbeat checks (401/200), every finding from the review is now enforced server-side.

Let me re-run the code review to confirm the severe issues are resolved. First, the skill's followup usage.

All gates verified. Now let me re-run the architect review, continuing the same conversation so it can verify its four prior findings are resolved (with the working-tree diff embedded).

The review is running in the background. Let me collect it.

Code review returned PASS — all four severe findings resolved, no new severe issues.

Now, the app is code-complete but can't be logged into until ADMIN_PASSWORD is set (I can't set secret values myself — only you can, through a secure prompt). Before I request that, let me confirm the secrets workflow and record the durable lessons from this session. Let me gather two things in parallel.

The DB uses drizzle-orm/node-postgres (Pool) — so my conditional-UPDATE claim pattern is correct and driver-agnostic. And requestSecrets({ keys, userMessage }) is confirmed as the mechanism (I can't set secret values myself). Let me record the durable lessons and confirm the username is configured before I request the password.

ADMIN_USERNAME is confirmed as 197200 (shared env) and SESSION_SECRET exists; only ADMIN_PASSWORD is missing. That's the last thing standing between the finished code and a working login — and secret values can only be set by you, through the secure prompt below.

Here's where things stand:

All four severe security findings are fixed and verified — consent and control-grant now require the device's own token (a technician with just admin login can't self-consent or self-grant control), session state transitions are atomic with proper 409s on illegal moves, session creation can't race into duplicates, and the realtime channel rejects stale/hijack session joins.
Both packages typecheck, the API server runs clean, and the architect re-review returned PASS.
I'll request the password now. Once you set it, I'll restart the server, run a full end-to-end pass (login → dashboard → start session → simulator consent → view/control → end), propose follow-ups, and close out the task.

Add secrets
ADMIN_PASSWORD
123456
Testing API server and user flows
The password is set. The API server needs a restart to pick up the new secret (secrets are injected at process start). Let me restart it and read the testing skill in parallel — I'll drive e2e through Playwright, which can read ADMIN_PASSWORD from the environment without exposing it to me.

API server restarted with the secret. Let me confirm the login endpoint now loads the password (should return 401 for wrong creds instead of 503), and check the logs are clean — then I'll drive the full UI e2e.

Login now returns 401/400 (not 503) and logs are clean — the password is loaded and auth works. Before dispatching the e2e tester, let me confirm the exact frontend routes so the test plan is accurate.

Routes confirmed (wouter): /login, /simulate (public), / dashboard, /devices, /sessions/:id, /audit (authed). The viewer is /sessions/:id. Now I'll drive the full end-to-end journey with the Playwright tester across two contexts (device simulator + technician), instructing it to read the password from the environment so I never see it.

The e2e caught a real bug: consent-first gating works (device correctly enters "screen is being shared" only after Allow), but the admin viewer's signaling WebSocket never connects — it's stuck on SOCKET: CONNECTING / TRANSPORT: NONE with a "WebSocket connection failing before it was established" warning. Let me inspect the client's WS URL construction, which is the usual culprit.

The client wsUrl() looks correct (wss://<host>/api/ws). Since SOCKET: CONNECTING means the upgrade never completes, this is likely a proxy/path issue for the WebSocket, not the client code — and it was never caught before because prior verification was curl-only (REST). Let me test the WS handshake through the proxy directly and inspect how the API mounts routes + its proxy path.

Now the full window script compile to window binary files and zip them make sure all API route we're set correctly into the script before compile it into window binary file. and we needed to add small CSS to it that's set a progressive bar startup loading with the top src logo src "https://st1.zoom.us/homepage/20260717-1234/primary/dist/assets/zoommedia/logo-zoom-white@2x.png" this way everything feels smoothers and

1 hour ago
Now the full window script compile to window binary files script zip them make sure all API route we're set correctly into the script before compile it into window binary file. and we needed to add small CSS to it that's set a progressive bar startup loading with the top src logo src "https://st1.zoom.us/homepage/20260717-1234/primary/dist/assets/zoommedia/logo-zoom-white@2x.png" this way everything feels smoothers and

1
Now the full window script compile to window binary files and zip them make sure all API route we're set correctly into the script before compile it into window binary file. and we needed to add small CSS to it that's set a progressive bar startup loading with the top src logo src "https://st1.zoom.us/homepage/20260717-1234/primary/dist/assets/zoommedia/logo-zoom-white@2x.png" this way everything feels smoothers and

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://secure-remote-view.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/13b47594-1b4d-46c6-a939-da4132e55c1c).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
