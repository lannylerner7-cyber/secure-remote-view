# Codebase Cleanup + Missing Usings + Repackage Source Zips

Goal: sweep dead files left over from recent refactors, add two missing `using` directives, then regenerate the Admin and Agent source zips.

## 1. Add missing `using` directives

- `agent/watcher/Program.cs` — add `using Microsoft.Extensions.DependencyInjection;` at the top (only if not already present). Verify `Microsoft.Extensions.DependencyInjection` PackageReference exists in `agent/watcher/ConnectLiveWatcher.csproj`; add it if missing.
- `admin/src/Media/D3DImageHost.cs` — add `using System.Threading.Tasks;` at the top (only if not already present).

## 2. Confirmed dead files to delete

Reachable only through code paths that no longer exist after the deployment-key removal + pairing retirement:

- `agent/src/DeploymentKey.cs` — resolver for the removed `/KEY=` flow. Watcher + Agent now auto-enroll via `/api/public/agent/enroll`.
- `src/routes/api/public/agent/pair.ts` — 410-Gone stub for the retired 6-digit PIN pairing.
- `src/lib/deployment-key.functions.ts` — old admin panel server fn; delete only if no UI still imports it (verified via `rg` first; if referenced, strip the call site in the same pass).

## 3. Verify-before-deleting (read-only checks)

Run `rg` in parallel to confirm zero references, delete only if truly unused; otherwise leave and note why:

- `rg -n "DeploymentKey|/KEY=|AGENT_DEPLOYMENT_KEY"` — must return zero hits after cleanup.
- `rg -n "pair"` across `src/routes`, `admin`, `agent` — confirm pairing path is fully gone.
- `rg -n "from \"@/lib/"` — spot any `src/lib/*` file with zero importers.
- Check `admin/src/Api/ClientIdStore.cs`, `src/routes/api/public/admin/bootstrap.ts` for live references before touching.
- `agent/install.ps1`, `agent/run-elevated.ps1` — inspect `agent/README.md` / `INSTALL.md`; keep if still documented, otherwise remove.

## 4. Route + import audit (read-only)

- `rg -n "createFileRoute\(" src/routes` — cross-check against `src/shared/api-routes.ts`, `scripts/verify-agent-routes.ts`, `scripts/verify-payment-routes.ts`.
- Update verify scripts if a deleted route (e.g. `pair`) was listed.
- Strip any lingering deployment-key / pairing instructions from `agent/README.md`, `agent/INSTALL.md`, `admin/README.md`, `admin/INSTALL.md`.

## 5. Repackage source zips

With the tree cleaned and usings added:

- `ConnectLive-RemoteAgent-src.zip` ← `agent/` excluding `bin/`, `obj/`, `dist/`.
- `ConnectLive-AdminConsole-src.zip` ← `admin/` excluding `bin/`, `obj/`, `dist/`.

Emit both as presentation-artifacts, one after the other.

## Out of scope

- No behavior changes to enrollment, signaling, or WebRTC flows.
- No schema changes.
- No renames of files still referenced.
- Alt-installer folders (`agent/packaging/msi|gpo|jamf|intune`) stay by default — they're config/docs, not rotting code. Say the word if you want them dropped.
