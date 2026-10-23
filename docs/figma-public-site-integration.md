# ConnectLive public-site design integration

## Source and scope

The user supplied the completed Figma Make project
`2ja8vrgqlLqiVbPneYfxgV` as a source ZIP. Its public React components, typography,
layout, and image assets were adapted to the existing application rather than
replacing the application with the prototype.

Routes covered: `/`, `/plans`, `/order`, `/order/$id`, `/license`, `/contact`,
`/privacy`, `/terms`, `/refund`, and the public not-found screen.
Technician administration, payment administration, authentication, API handlers,
database migrations, native clients, and deployment settings are unchanged.

## Deliberate integration differences

- TanStack Router and existing server functions remain authoritative.
- Live checkout loads active plans and prices from the backend; the Figma
  prototype's sample wallet addresses, amounts, and fake confirmation are absent.
- The three-step checkout validates contact details, requires the displayed
  terms/refund acknowledgement before submission, and surfaces failed requests.
  This checkbox is a frontend acknowledgement, not a new database consent record.
- Existing invoice polling, confirmation targets, order reference, QR address,
  expiry handling, and access links are retained.
- Full existing legal text is retained instead of the export's abbreviated text.
- Newsletter submission appears in the shared footer; order tracking is available
  from license lookup. Existing backend validation and response handling remain.
- Public styling is scoped to `.cl-site`. Reduced-motion rules are retained,
  and initial server-rendered content is visible before hydration.
- Static performance claims from the reference were replaced with capability
  labels: this design update does not establish a latency or availability SLA.
- Marketing plan cards retain supplied plan copy and prices; checkout always
  reads the live price. Keeping marketing prices automatically synchronized is
  a separate improvement.

## Verification boundaries

The Node production build succeeds. Desktop and mobile browser checks cover
navigation, plan selection, checkout validation, currency/payload mapping, and
recoverable request failures. Mutating requests are intercepted before leaving
the browser: no orders, messages, subscriptions, or payments are created by these
checks. This does not claim a completed purchase or payment confirmation.

An unrelated, pre-existing TypeScript nullability diagnostic remains in the
native-agent reconnect API route; it is not introduced or changed by this design.
Successful GitHub publication does not by itself establish a completed Coolify
rollout; inspect that rollout separately.
