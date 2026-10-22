# ConnectLive codebase map and source verification

Compared with GitHub revision `a743af430f9a7120c62a3e12b4a71bea12a252a3`.
This report inventories source; it does not certify behavior, authorization,
successful Windows builds, deployment health, or exhaustive security coverage.

## Locations in this project

| Location | Purpose |
| --- | --- |
| `` | Main GitHub source plus local defensive edits |
| `src/routes/_authenticated/console.tsx` | Technician web console at `/console` |
| `src/routes/_authenticated/payments.tsx` | Separate payments console at `/payments` |
| `admin/` | Windows technician Admin source |
| `agent/` | Windows Agent and repository Watch source |
| `supabase/migrations/` | Existing database migration source; not applied here |
| `imports/client-archives/agent/` | Extracted Agent builder ZIP, unchanged reference |
| `imports/client-archives/admin/` | Extracted Admin builder ZIP, unchanged reference |
| `docs/` | Review evidence, configuration and access-policy documentation |
| `artifacts/` | Original workspace services, not the imported product |

## Import comparison

- Unchanged tracked files: **367**
- Locally changed tracked files: **8**
- Missing tracked files (excluding environment files): **0**
- Added source files: **2**
- Environment files were deliberately excluded; values were not read.

### Changed

- `agent/src/Agent.cs`
- `agent/src/App.xaml.cs`
- `agent/src/SplashWindow.xaml.cs`
- `agent/src/Watch/ConnectLiveWatch.csproj`
- `agent/src/Watch/Program.cs`
- `src/lib/newsletter-unsub.server.ts`
- `src/lib/webrtc-signal.functions.ts`
- `src/routes/api/public/agent/session.$sessionId.reconnect.ts`

### Missing

None.

### Added

- `agent/src/LocalAccessState.cs`
- `supabase/migrations/20261021000000_restrict_admin_binding.sql`

## Subsystem inventory

| Subsystem | Files |
| --- | ---: |
| `src/routes` | 43 |
| `src/components` | 69 |
| `src/lib` | 32 |
| `src/shared` | 2 |
| `src/integrations` | 6 |
| `agent/src` | 32 |
| `admin/src` | 45 |
| `supabase/migrations` | 61 |

## Declared file routes

Paths below are route declarations, not proof of reachable/authenticated routes.
`_authenticated` is a pathless layout; it is not a URL segment.
HTTP methods are syntactic declarations only. Server functions and direct
Supabase calls are separate surfaces and are not covered by this table.

| Declaration | Declared methods | Source |
| --- | --- | --- |
| `/_authenticated/console` | Page/layout | `src/routes/_authenticated/console.tsx` |
| `/_authenticated/payments` | Page/layout | `src/routes/_authenticated/payments.tsx` |
| `/_authenticated` | Page/layout | `src/routes/_authenticated/route.tsx` |
| `/api/public/admin/bootstrap` | POST | `src/routes/api/public/admin/bootstrap.ts` |
| `/api/public/admin/session/$sessionId/files` | DELETE, GET, POST | `src/routes/api/public/admin/session.$sessionId.files.ts` |
| `/api/public/agent/beacon` | POST | `src/routes/api/public/agent/beacon.ts` |
| `/api/public/agent/enroll` | POST | `src/routes/api/public/agent/enroll.ts` |
| `/api/public/agent/heartbeat` | POST | `src/routes/api/public/agent/heartbeat.ts` |
| `/api/public/agent/hello` | POST | `src/routes/api/public/agent/hello.ts` |
| `/api/public/agent/ice` | GET | `src/routes/api/public/agent/ice.ts` |
| `/api/public/agent/power/$cmdId/ack` | POST | `src/routes/api/public/agent/power.$cmdId.ack.ts` |
| `/api/public/agent/release` | GET | `src/routes/api/public/agent/release.ts` |
| `/api/public/agent/session/$sessionId/consent` | POST | `src/routes/api/public/agent/session.$sessionId.consent.ts` |
| `/api/public/agent/session/$sessionId/cursor` | POST | `src/routes/api/public/agent/session.$sessionId.cursor.ts` |
| `/api/public/agent/session/$sessionId/file` | POST | `src/routes/api/public/agent/session.$sessionId.file.ts` |
| `/api/public/agent/session/$sessionId/frame` | POST | `src/routes/api/public/agent/session.$sessionId.frame.ts` |
| `/api/public/agent/session/$sessionId/inputs` | GET | `src/routes/api/public/agent/session.$sessionId.inputs.ts` |
| `/api/public/agent/session/$sessionId/reconnect` | POST | `src/routes/api/public/agent/session.$sessionId.reconnect.ts` |
| `/api/public/agent/session/$sessionId/signal` | GET, POST | `src/routes/api/public/agent/session.$sessionId.signal.ts` |
| `/api/public/agent/stream` | GET | `src/routes/api/public/agent/stream.ts` |
| `/api/public/auth/login` | POST | `src/routes/api/public/auth/login.ts` |
| `/api/public/cron/reconcile-orders` | POST | `src/routes/api/public/cron/reconcile-orders.ts` |
| `/api/public/health` | GET | `src/routes/api/public/health.ts` |
| `/api/public/newsletter/unsubscribe` | GET, POST | `src/routes/api/public/newsletter/unsubscribe.ts` |
| `/api/public/stats/orders` | GET | `src/routes/api/public/stats/orders.ts` |
| `/api/public/webhooks/cdp` | POST | `src/routes/api/public/webhooks/cdp.ts` |
| `/connectlive/admin` | Page/layout | `src/routes/connectlive.admin.tsx` |
| `/connectlive/payment` | Page/layout | `src/routes/connectlive.payment.tsx` |
| `/contact` | Page/layout | `src/routes/contact.tsx` |
| `/health` | GET | `src/routes/health.ts` |
| `/` | Page/layout | `src/routes/index.tsx` |
| `/license` | Page/layout | `src/routes/license.tsx` |
| `/order/$id` | Page/layout | `src/routes/order.$id.tsx` |
| `/order/` | Page/layout | `src/routes/order.index.tsx` |
| `/privacy` | Page/layout | `src/routes/privacy.tsx` |
| `/public/agent/login` | Page/layout | `src/routes/public.agent.login.tsx` |
| `/public/agent/portal` | Page/layout | `src/routes/public.agent.portal.tsx` |
| `/refund` | Page/layout | `src/routes/refund.tsx` |
| `/robots.txt` | GET | `src/routes/robots[.]txt.ts` |
| `/sitemap.xml` | GET | `src/routes/sitemap[.]xml.ts` |
| `/terms` | Page/layout | `src/routes/terms.tsx` |

## Client project declarations

| Project | XML parses | Target |
| --- | --- | --- |
| `agent/src/ConnectLiveAgent.csproj` | Yes; not compilation | `net8.0-windows10.0.19041.0` |
| `agent/src/Watch/ConnectLiveWatch.csproj` | Yes; not compilation | `net8.0-windows` |
| `admin/spikes/d3d-present/D3DPresentSpike.csproj` | Yes; not compilation | `net8.0-windows` |
| `admin/spikes/vp8-decode/Vp8DecodeSpike.csproj` | Yes; not compilation | `net8.0-windows` |
| `admin/src/ConnectLiveAdmin.csproj` | Yes; not compilation | `net8.0-windows10.0.19041.0` |

## Archive reference comparison

### Agent
- Files: 49
- Byte-identical to upstream: 46
- Different: `src/InputRelay.cs`, `src/StartupSelfHeal.cs`
- Archive-only: `BUILD-ON-WINDOWS.txt`

### Admin
- Files: 53
- Byte-identical to upstream: 52
- Different: None
- Archive-only: `BUILD-ON-WINDOWS.txt`

## Verification still required

- Full TypeScript semantic checking and dependency-resolved builds.
- Server/Agent grant enforcement, local withdrawal, peer-channel permissions and race handling.
- Windows UI/build/runtime tests; earlier compilation blockers remain documented.
- Isolated authentication, tenant isolation, database policies and all state transitions.
- Actual compiled ZIP signatures, contents and install/uninstall behavior.
- Android native implementation: no APK/client project is established by these sources.

No secrets, live devices, migrations or production configuration were used.
