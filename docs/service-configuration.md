# Service configuration inventory

Names only. No secret values requested, configured or copied.

| Service | Known names | Intended responsibility | Current status |
| --- | --- | --- | --- |
| SMTP | SMTP_FROM_ADDRESS, SMTP_FROM_NAME, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_USERNAME | Email | Deferred |
| Cloudflare TURN | CLOUDFLARE_CALLS_APP_ID, CLOUDFLARE_CALLS_APP_TOKEN | Relay connectivity when a direct media path is unavailable | Names known; credentials/live behavior unverified |
| Coinbase | CDP_WEBHOOK_SECRET, CDP_API_KEY_NAME, CDP_API_KEY_PRIVATE_KEY | Payment API and signed events | Deferred |
| Bootstrap | BOOTSTRAP_TOKEN | Initial privileged provisioning | Determine whether still needed |
| Lovable | LOVABLE_API_KEY | Legacy integration | Determine actual consumers before replacement |
| Supabase | Inventory required from code, without reading environment files | Existing database/auth/realtime/storage integration | Preserve; test configuration unavailable |
| Cloudflare D1 | No configuration assumed | Separate database product | User mentioned it; repository integration not established |
| Windows signing | Signing configuration deferred | Publisher identity for compiled releases | No compiled releases verified |

## Cloudflare monitoring research

Official source: https://developers.cloudflare.com/health-checks/

Cloudflare Standalone Health Checks monitor an origin IP address or hostname,
support response/protocol/path/interval criteria, and provide uptime/latency
analytics and notifications. The consulted documentation lists availability on
Pro, Business and Enterprise, not Free. Verify current account eligibility before
adoption.

This is appropriate to investigate for the hosted application's health endpoint.
It is not a mechanism to keep a Windows process, WLAN connection or sleeping
device alive, nor a substitute for truthful per-device last-seen reporting.
It does not demonstrate or fix media-rendering performance.

No Cloudflare services were provisioned. Do not add D1 or replace the existing
database merely because TURN/monitoring use the same provider.
