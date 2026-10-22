# Repository cleanup review

Scope: the application source exported from `imports/connectlive/` to the
existing GitHub repository root. This is not a rewrite or Git history cleanup.

## Verified removals

| File relative to application root | Evidence | Action |
| --- | --- | --- |
| `admin/src/ConnectLiveAdmin_aifv2k4d_wpftmp.csproj` | Generated WPF intermediate, 45,309 bytes; byte-identical to the next file. The real project is `admin/src/ConnectLiveAdmin.csproj`. No active build entry point refers to this generated filename. | Removed from workspace source. |
| `admin/src/ConnectLiveAdmin_4aqegr20_wpftmp.csproj` | Duplicate generated intermediate; not a maintained project. | Removed from workspace source. |

Git ignores now exclude `**/*_wpftmp.csproj` in both workspace and exported
application layouts. Replit ignores the same generated intermediates.
The source exporter propagates these two explicit deletions into a matching
upstream clone, so copying newer files cannot leave the obsolete projects behind.

## Retained deliberately

- Agent icon, Admin icon and website favicon: identical bytes, but separate
  packaging/runtime consumers. Removing one would break its relative asset path.
- CDP modules: still called by order and reconciliation code; not dead files.
  Replacing that behavior is a separate functional change.
- Lovable error-reporting module: still imported by the root route.
- UI components, routes, asset descriptors, migrations and client build scripts:
  no deletion based on age, naming or absence from a single text search.
- Uploaded source archives and previous Windows ZIPs: retained as evidence.

No existing Windows ZIP was modified. This document records a conservative
cleanup, not proof that every remaining file is necessary. The cleanup and
Coolify curl compatibility fix were pushed using the authorized SSH deploy key
to `replit/connectlive-source-update`, source commit
`17883b431845fddd4e7415a8b83e248e80d2c657`. Main and production were not changed.

## Verification

- Confirmed both reviewed paths are absent and the maintained Admin project remains.
- Searched maintained project, solution, PowerShell, batch, props and targets files:
  neither removed filename is referenced.
- Confirmed Git ignores a newly generated `*_wpftmp.csproj` filename.
- Exercised the exporter in an isolated fixture: both obsolete files are deleted,
  pending deleted tracked inputs are skipped, active source is copied, and
  unrelated upstream files are preserved.
- A fresh Admin compile is **not verified**: the no-restore attempt reported missing
  Windows runtime/reference packs (NETSDK1112). The restore-enabled attempt
  produced only “Determining projects to restore...” and no new assembly.
  Its nominal process success is not treated as a successful build.
