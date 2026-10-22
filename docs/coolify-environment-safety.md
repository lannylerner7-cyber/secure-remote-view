# Coolify environment-variable handling

This is configuration-safety guidance, not approval to activate the incomplete
remote-access system. Do not connect staged source to production devices.

Official reference:
https://coolify.io/docs/applications/configuration/environment-variables

## Where values belong

Open the Coolify application and its Environment Variables settings. Normal
view edits one variable at a time. Production and preview have separate sections;
use isolated test resources for preview, not live customer data.

Developer view accepts `.env`-style text, but saving it can create, change AND
remove entries to match the supplied contents. Prefer Normal view for incremental
changes. Do not commit populated `.env` files or send values through chat.

Coolify configuration and the development workspace are separate environments;
setting a value in one does not establish that it exists in the other.

## Scope

- Runtime-only secrets: disable availability during build when only the server
  needs the value. Do not expose privileged credentials as VITE variables.
- Browser/public build configuration: Vite's VITE-prefixed values can be embedded
  into delivered JavaScript. Only intentionally public configuration belongs
  there; a Supabase publishable key is not a service-role secret.
- Build arguments may remain visible in image metadata. Do not use them for
  runtime secrets. Sensitive build dependencies require an appropriate build
  secret mechanism, with its actual availability verified.
- Literal interpolation preserves `$` characters in passwords.
- Use multiline value handling for PEM-style private keys; never paste them into
  source files or logs.
- Changing a build-time value requires a new build/deployment. Runtime changes
  require the runtime environment to be recreated; Coolify documents restart
  for runtime-only changes. Do not perform either here without rollout approval.

## Findings from this source snapshot

The browser Supabase client reads VITE_SUPABASE_URL and
VITE_SUPABASE_PUBLISHABLE_KEY. Server clients read SUPABASE_URL,
SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY. These names do not
prove that any values are set or that the current Docker build propagates them.
The Docker build has not been executed or approved for production.

The newsletter HMAC helper previously substituted a public hard-coded string
when SUPABASE_SERVICE_ROLE_KEY was absent. The staged version now refuses
signing without configuration and rejects verification without configuration.
Tests use synthetic values in an isolated context, never production credentials.
Existing tokens generated with the insecure fallback are deliberately rejected.
Tokens generated with a properly configured key retain their existing format.

## Current boundary

No Coolify access, values, connection tests or deployments have been performed.
No claim is made about the currently deployed revision. Client authorization,
visibility and revocation work remains incomplete; provisioning credentials
must not be used to activate the unchanged hidden-access paths.
