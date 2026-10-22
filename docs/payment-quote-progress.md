# Unique payment quotes and references

## Staged implementation

- Migration `20261021002000_unique_payment_quotes.sql` reserves a coin/address/
  amount combination and creates its order in one transaction.
- It serializes allocations per coin/address, checks existing invoices as well
  as reservations, and tries the base quote plus 0–99 native currency units.
- Reservations are retained after expiry to avoid attributing late payments to
  newer invoices. If the permitted range is exhausted, allocation fails rather
  than silently expanding the adjustment.
- The invoice explains the maximum matching adjustment: 0.00000099 BTC or
  0.000099 USDT/USDC. The exact displayed amount must arrive, excluding fees.
- `createOrderPublic` uses the allocation RPC and fails explicitly when a wallet
  or migration is missing; there is no non-unique fallback.
- `CL-<complete order UUID>` appears on the invoice, in the admin order list and
  in newly polled payment-event metadata. Events retain the existing `order_id`
  relation. The reference is not asserted to be an on-chain memo.
- Amount matching now uses integer base units, not approximate floating-point
  tolerance that could match adjacent quote amounts.

## Verification and limits

15 isolated payment-identity checks passed; all 164 TypeScript files parsed.
The tests cover native precision, scientific notation, adjacent quotes,
normalization, invalid values and full UUID preservation.

The migration has **not** been applied or PostgreSQL/concurrency-tested.
This is not a working payment engine or a live preview of invoices/admin data.
Existing imported payment code remains inactive.

## Still required before any payment activation

- Remove the CDP webhook/config dependencies and implement direct network
  verification for BTC and both ERC-20 tokens.
- Validate chain, token contract, recipient, amount, block identity and timing;
  reject/review historical, reused, ambiguous and malformed evidence.
- Atomically claim each accepted transaction/event once and handle reorgs.
- Enforce backend confirmation policy and expose actual 0/3–3/3 progress.
- Five-second non-overlapping refresh, bounded provider timeouts, and clear
  unavailable/stale states; no expiry/decline caused merely by a failed API.
- Market-rate freshness and exact quote provenance; no silent $1 peg assumption.
- QR upload/storage, decoding and validation against the selected wallet/network.
- Complete typed database contracts after migration review and test integration.
- Authenticated payment-administration verification in an isolated environment.

Do not deploy the partial migration/code as a completed checkout replacement.
