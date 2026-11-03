# ConnectLive Access console layout

## Scope

The technician console follows the supplied ScreenConnect reference's structure:
a narrow navigation rail, a separate Access/group sidebar, a stable contextual
toolbar above selection/search, and a grouped device workspace. It retains
ConnectLive's existing navy/blue palette (`#0B1220`, `#0F172A`, `#4F7CFF`,
`#B9CCFF`) and typography. This is not a change to the separate payments admin.

The primary action is **Pair device**, not a non-functional copy of
ScreenConnect's Build button. Run Tool and Create Session Group were not added:
ConnectLive has no corresponding implemented workflows.

## Control locations and preserved behavior

| Location | Controls |
| --- | --- |
| Left rail | Access, Overview, Sessions, Expected, Audit; existing super-admin-only Team and Settings |
| Rail footer | Notifications, account menu, sign out |
| Access sidebar | Pair device; company/OS/online/update/session/recent/offline/stopped groups with counts |
| Sidebar footer | Expected devices and the existing Agent download portal |
| Workspace toolbar | Connect for one eligible selected device; Power; More |
| More menu | Existing session-ending/relaunch/removal actions, secondary navigation and clear selection |
| Selection/search row | Select all visible devices, selection count, device search and clear search |
| Device rows | Selection, real identity/status/last seen/version information and Connect |
| Existing viewer | The original bounded viewer and its monitor, input, clipboard, file, recording, privacy, reconnect and session controls |

All 21 existing session/control/transport handler bodies were compared against
the pre-redesign source and are unchanged. The existing device-removal
confirmation is retained.

Only resolved staff roles can perform mutations. Pairing follows the existing
database boundary: admin for an owned license, or super-admin. Viewers and
unresolved roles receive no mutating controls. Native command permissions and
acknowledgements still come from the existing backend/Agent.
Connect is offered for online/reconnecting devices, not for an offline or
stopped Agent; stopped devices explain the separate admin relaunch action.

## Data and failure states

- Groups and counts use loaded device/session/release data, not sample data.
- Online, reconnecting, offline and stopped use the existing presence logic.
- Search combines terms across identity, host, OS, platform, version and company.
- Selections hidden by a group or search are removed from the target set.
- Company reads request only license ID and company. Missing/unread company
  information is not confused with a genuinely unassigned device.
- Initial device-load failure, retained stale rows after a failed refresh,
  loading, empty group and search-no-results are separate states with recovery.
- Recently accessed explicitly describes its existing latest-50-session,
  seven-day window; it is not presented as an exhaustive history query.
- Agent downloads and copied Expected-device install links use the real
  in-app portal rather than a guessed external download anchor.

## Automated verification

Run from the workspace root (the fallback also supports the flattened GitHub
source export):

```sh
APP=imports/connectlive
[ -d "$APP/src" ] || APP=.
node tests/console-access.cjs
node tests/admin-viewer-layout.cjs
node tests/viewer-geometry.cjs
node tests/browser-first-protocol.cjs
node tests/agent-lifecycle.cjs
node tests/runtime-cache.cjs
pnpm --dir "$APP" exec tsc --noEmit --pretty false
NITRO_PRESET=node-server pnpm --dir "$APP" exec vite build
```

These checks passed for this change. The new suite covers 51 filter, selection,
action-wiring, permission and navigation assertions without network/device
traffic. Existing viewer geometry, video protocol, lifecycle and cache checks
also passed. The production build uses the Node preset intended for Coolify,
not the default Cloudflare build target.

## Browser verification boundary

Signed-in browser verification uses a disposable identity and explicitly
synthetic devices under its own license. It must not operate on the real fleet
or produce external messages. The fixture's temporary heartbeat is bounded and
updates only its guarded synthetic row. Credentials are kept in a private
temporary file, never committed or included in screenshots.

### Signed-in results — 2026-11-03

- Desktop 1280×800, reference 1024×614 and tablet 768×800: layout and controls
  checked without major overlap.
- Phone 390×844: the first pass found clipped, horizontally scrolling navigation.
  After the bounded responsive fix, body/rail/group widths fit the viewport; all
  eight groups and account/notification/menu controls remained reachable.
- All groups, multi-term search, no results, selection counts/select-all,
  hidden-selection pruning, menu dismissal and role-dependent availability passed.
- Pair dialog loaded the owned license without generating a secret. Agent
  downloads reached the existing portal login. Expected, Overview, Sessions and
  Audit loaded.
- A real UI-created synthetic session reached invited/waiting-for-Agent, then
  ended through End sharing. The desktop viewer's containment, action rail,
  Fit/1:1 and explicit close were checked without claiming decoded video.
- Removal was canceled, then confirmed for a synthetic offline device only.
- Injected devices-only 503 responses produced both initial-load error and
  retained-list/Retry states; Retry recovered.
- Viewer-role mutation gates, admin-role restoration, account menu and sign-out
  passed. No power, relaunch, revoke or notification-setting command was sent.
- Fixture cleanup verified zero remaining test users, roles, licenses, devices,
  sessions, pairings, power commands or matching audit records. The private
  credential file was removed and the bounded heartbeat stopped.

The phone viewer was not reopened: the already-ended fixture session has no
read-only View action. Reconnecting eligibility is covered by the pure tests,
not a live reconnecting Agent.

These browser checks do not establish real Windows capture, input, clipboard/file
transfer, Watch recovery, MSI installation, signed updates or session continuity.
Those require an attached Windows host and observed Agent acknowledgements.
No native-Admin cutover, production deployment or merge to main is implied.
