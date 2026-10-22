# Lovable reference audit

## Updated application references

- Homepage banner: recovered the original 63,170-byte JPEG from the previous
  project host; Vite now bundles it instead of using the unavailable `/__l5e` proxy.
- Root social-sharing metadata: uses the bundled banner instead of the legacy
  gpt-engineer upload bucket.
- Removed four unused asset metadata files. These were remote pointers, not media
  binaries. The MP4 and animated GIF were not used by any current route and have
  not been recovered or added to the site. The logo already exists as hero-float-2.
- Removed the editor-only auth message bridge. Browser storage remains localStorage,
  exactly as it was on the Coolify domain; persistence and token refresh remain enabled.
- Removed editor-only error hooks; the root error boundary still logs errors and
  retains its existing recovery UI.
- Supabase configuration errors now direct operators to Coolify variables.

## Database migration

The two historical migrations dated 2026-07-27 and 2026-08-03 contain the old
reconciliation host. Preserve them as history. The new 20261022000000 migration
retargets only a matching existing reconcile-orders job to connectliveagent.com.
It preserves authentication, schedule and active state, and creates no new job.
Deploying the web container alone does not apply this migration.

Applied transactionally to the configured Supabase project on 2026-10-22 and
recorded in migration history. The project has no cron.job table, so this was a
verified no-op for scheduling: no job was created, enabled or redirected.

## Deliberately retained

- The @lovable.dev Vite configuration package, its configuration and lockfile:
  currently required for the TanStack/Nitro build. Removing it requires a separate
  build-tool migration, not a text replacement.
- Historical README, roadmap and audit references describe the original import.
- External Google demo videos, Google Fonts and YouTube are not Lovable assets.
  Their availability/playback is a separate concern.

Search covered maintained web sources, native Agent/Admin, public files, scripts,
tools, build configuration and database migrations. No matching native client
references were found. No secrets or application data were changed. The only
database write was the migration-history entry described above.
