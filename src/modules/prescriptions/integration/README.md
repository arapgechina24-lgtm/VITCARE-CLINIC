# Prescription Integration — VITCARE-CLINIC ↔ VITCARE-POS

POS accepts inbound API calls, so the two systems stay fully decoupled —
CLINIC calls POS, POS calls back via webhooks. No shared database, no shared
code.

## Files

| File | Role | Lives on |
|------|------|----------|
| `prescription-contract.ts` | **Source of truth** — Zod schemas, status state machine, versioning. Copy this file to POS too. | Both |
| `pos-client-outbox.ts` | Pushes prescriptions to POS via the outbox pattern (retries, idempotency, HMAC signing). | CLINIC (here) |
| `webhook-handler.ts` | Receives POS status webhooks; verifies signature, dedupes, enforces transitions. | CLINIC (here) |
| `supabase-deps.ts` | Wires the two DB-agnostic interfaces above (`WebhookDeps`, `OutboxStore`) against this project's actual Supabase tables. | CLINIC (here) |
| `openapi.yaml` | The wire contract, for both teams and for contract tests. | Both |
| `webhook-handler.test.ts` | 19 tests: signature forgery, body tampering, replay window, dedupe, state machine, payload validation. | CLINIC (here) |
| `pos-client-outbox.test.ts` | 18 tests: request shape/idempotency key, retry-vs-permanent classification, backoff ceiling, drain accounting. | CLINIC (here) |

## Tests

```bash
npm test          # 37 tests, ~1s, no network and no database
```

They run on every commit via the pre-commit hook (`scripts/install-hooks.sh`)
alongside the RLS check, because this module is the one place where a silent
regression costs a patient their medication rather than just breaking a page.

The `WebhookDeps` / `OutboxStore` interfaces exist precisely so these run
against injected fakes — no Supabase, no POS, no clock skew flakiness. Two
properties are worth understanding before editing:

- **Rejected requests must not touch the database.** Several tests assert not
  just a 401 but that `hasProcessedEvent` was never called. A 401 that still
  queried the DB would mean unauthenticated input reaching the data layer.
- **A transient POS outage must never discard a prescription.** The
  retry-vs-permanent table is the safety net; making `permanent` unconditional
  fails 7 tests, which is the point.

Both suites were mutation-tested — each guard (signature check, length guard,
replay window, permanence classification, idempotency key, backoff ceiling,
boundary validation) was deliberately broken to confirm a test catches it.

Mounted at:
- `POST /api/integration/pos/prescription-status` — `src/app/api/integration/pos/prescription-status/route.ts`
- `POST /api/prescriptions/outbox-drain` — `src/app/api/prescriptions/outbox-drain/route.ts` (called on a schedule, not by POS)

Schema: `supabase/migrations/0001_prescriptions.sql` (prescriptions,
prescription_items, integration_outbox, processed_webhook_events), on top of
the Phase 0 base schema in `0000_base_schema.sql`.

## The flow

```
Clinician sends Rx (Prescribe step)
   ↓  (same DB transaction, enforced in the Prescribe route handler)
   ├─ INSERT prescriptions (status=DRAFT→PENDING)
   └─ INSERT integration_outbox row
        ↓
   [outbox-drain worker runs on a schedule]
        ↓  POST /prescriptions  (HMAC-signed, Idempotency-Key = prescriptionId)
        ▼
   VITCARE-POS  — checks stock, prices, dispenses, takes payment
        ↓  POST /integration/pos/prescription-status  (HMAC-signed, per event)
        ▼
   handlePosWebhook  → verify → dedupe → assertTransition → update Rx + audit
        ↓
   Clinician sees PRICED / DISPENSED / COLLECTED on the timeline
```

## Security model (both directions)

- **HMAC-SHA256** over `` `${X-Timestamp}.${rawBody}` `` with `POS_SIGNING_SECRET`.
  Verified on the **raw** body before parsing, in both directions.
- **Replay protection**: reject timestamps older than 5 minutes.
- **Idempotency**: CLINIC sends `Idempotency-Key` (the prescriptionId) so POS
  dedupes; POS sends a unique `eventId` so CLINIC dedupes via `processed_webhook_events`.
- `integration_outbox` / `processed_webhook_events` have RLS enabled with **zero
  client-role policies** — only the service-role key (used server-side by the
  route handlers above) can touch them.

## Environment variables (server-side, this repo)

```
POS_BASE_URL=https://<vitcare-pos-host>/api
POS_SIGNING_SECRET=<shared secret, 32+ random bytes — same value the POS side uses>
POS_REQUEST_TIMEOUT_MS=8000
OUTBOX_DRAIN_SECRET=<random string — query token so only your own scheduler can trigger a drain>
```

## What the POS team must implement (on vitcare-pos)

1. `POST /prescriptions` — accept the `CreatePrescription` body, verify the
   HMAC, **dedupe on `Idempotency-Key`**, queue it, return `202`.
2. Emit `PrescriptionStatusEvent` webhooks to `POST /api/integration/pos/prescription-status`
   on this CLINIC deployment, on every status change, HMAC-signed the same
   way, with a unique `eventId` and retries on non-2xx.
3. Use the **same `prescription-contract.ts`** — copy it verbatim into
   vitcare-pos so both sides share one vocabulary and one CONTRACT_VERSION.

This is a separate, later task against the vitcare-pos repo — it is
deliberately out of scope for this CLINIC repo's Phase 1 (see the root
README's Phase 1 note: the loop ships to one clinic + the pharmacy before POS
needs to do anything beyond accepting the two new endpoints).

## Next: SHA claims (Phase 3)

Payer is already modelled (`CASH | SHA | INSURER`) end to end. Before
building SHA claim submission, treat the current Social Health Authority
claim format/endpoints as a research task, not an assumption — the spec has
shifted since the NHIF transition.
