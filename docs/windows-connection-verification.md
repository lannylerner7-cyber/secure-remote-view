# Windows connection readiness

## Source changes and compile checks — 2026-10-21

The Agent previously started an ICE configuration fetch without awaiting it
before creating the first peer. An early offer could therefore create a
STUN-only peer even when the backend had usable TURN credentials.

The Agent now starts the lookup alongside signaling and awaits completion before
first peer creation. Both clients bound ICE lookup to five seconds through
linked cancellation tokens. Cancellation prevents Admin peer creation after a
stopped negotiation; Agent authorization is checked again after the await.
The deadline is a maximum lookup budget, not a fixed five-second delay.
On gateway failure the existing direct-only fallback remains; it is not a
successful relay configuration.

Both Windows-targeted projects compiled successfully on Linux:

- Agent: zero errors, three warnings (async methods and DPI configuration).
- Admin: zero errors, six warnings (nullable file transport references and DPI,
  including generated WPF compilation).

The missing NuGet cache was restored before compilation. These are development
builds, not signed installer ZIPs or Windows runtime validation.

## Existing implementation observed

- Agent capture uses DXGI Desktop Duplication with a GDI fallback.
- Admin video decoding uses a bounded drop-oldest frame queue.
- Both clients obtain temporary ICE settings from the application gateway;
  long-lived Cloudflare tokens remain server-side.

## Remaining runtime checks

No claim of delay-free connectivity is made. Against the connected backend on
two Windows devices, verify authorized first connection, direct and forced-relay
paths, cancellation during a slow gateway response, network loss/reconnect, and
stop/revocation. Measure offer-to-first-frame time plus capture, encode,
transport, decode and presentation delays. Check credential expiry and ICE
restart behavior over long sessions. DXGI capture alone cannot establish
transport performance.
