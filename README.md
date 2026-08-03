# VITCARE-CLINIC

Clinical system for Vitcare Health Center, Naivasha. Separate repo, separate
Supabase project, and deliberately **no shared database** with the pharmacy
till — the two systems meet only at a versioned, HMAC-signed contract
(`src/modules/prescriptions/integration/`).

| | |
|---|---|
| Dev server | `npm run dev -- -p 3001` — **port 3000 is the live pharmacy till, leave it alone** |
| Supabase | `xbllbyebzgnhyslhbwrz` (eu-west-1) |
| Tests | `npm test` (37, ~1s, no network or DB) |
| Guardrails | `sh scripts/install-hooks.sh` once after cloning |

## Where Phase 1 actually stands

The agreed Phase 1 is **one loop**: Register → Triage → Consult → Prescribe →
**Dispense in POS → status back**. Roughly half of it exists.

| Step | Where | State |
|---|---|---|
| Register | CLINIC | ✅ built, browser-tested |
| Triage | CLINIC | ✅ |
| Consult | CLINIC | ✅ |
| Prescribe | CLINIC | ✅ — writes prescription + items + outbox row in one transaction |
| Outbox → POS | CLINIC | ⚠️ code written and unit-tested; **never run** (no service key, not scheduled) |
| Dispense | **POS** | ❌ not started |
| Status back | **POS** | ❌ not started |

Everything still outstanding is either a five-minute setting or lives in the
**vitcare-pos** repo. No further clinical UI is needed to finish Phase 1.

## Step 0 — unblock (do these first)

1. **Add a real clinician.** Nobody can currently consult or prescribe. All
   eight pharmacy staff are ADMIN / PHARMACIST / RECEPTIONIST by design, and
   prescribing is restricted to `CLINICIAN`. Until a clinical officer exists
   with that role, the loop cannot run end to end with real accounts.
2. **Paste `SUPABASE_SERVICE_ROLE_KEY`** into `.env.local` (Supabase dashboard
   → Project Settings → API keys → `service_role`). Both integration routes
   return 503 without it.
3. **Generate the two shared secrets** and put the signing one on *both* sides:
   ```bash
   openssl rand -hex 32   # POS_SIGNING_SECRET  (identical in POS and CLINIC)
   openssl rand -hex 32   # OUTBOX_DRAIN_SECRET (clinic only)
   ```

## Step 1 — build the POS half (the real work)

In **vitcare-pos**, three things, per
`src/modules/prescriptions/integration/README.md`:

1. Copy `prescription-contract.ts` across **verbatim**. It is the one shared
   file; both sides must agree on the status vocabulary and `CONTRACT_VERSION`.
2. `POST /api/prescriptions` — verify the HMAC over the raw body, reject stale
   timestamps, **dedupe on `Idempotency-Key`** (the clinic retries on any
   non-2xx, so a retry must not create a second order), return `202`.
3. A pharmacy queue screen, and on dispense emit signed `PrescriptionStatusEvent`
   webhooks to `POST /api/integration/pos/prescription-status` here —
   `PRICED` → `DISPENSED` → `COLLECTED`, each with a unique `eventId`.

The receiving side of all of this already exists and is tested; POS is
writing to a contract that is defined, documented in `openapi.yaml`, and
covered by 37 tests.

## Step 2 — connect them

The clinic and pharmacy share premises, so the simplest correct topology is
both apps on the same machine or the same LAN — no public hosting, no domain:

```
POS_BASE_URL=http://localhost:3000/api        # same machine
POS_BASE_URL=http://192.168.x.x:3000/api      # POS on another LAN machine
```

Then schedule the drain (every 30s per the design). On this Mac that is a
launchd timer hitting:

```
POST http://localhost:3001/api/prescriptions/outbox-drain?token=$OUTBOX_DRAIN_SECRET
```

Note the outbox is what makes this safe: if POS is down, prescriptions queue
and retry with backoff rather than being lost.

## Step 3 — prove the loop

Register a patient → triage → consult → prescribe → confirm it appears in the
POS queue → dispense → confirm the clinic shows `DISPENSED`. That single
round trip is the Phase 1 exit criterion.

## Before real patients

- **Delete the four `@vitcare.test` accounts.** They share a known password
  and can read patient records.
- **Custom SMTP.** Supabase's shared sender rate-limits at ~4 emails/hour,
  which will not support eight staff signing in.
- **Consider the Pro plan.** Free-tier projects auto-pause after 7 days idle;
  this already took the pharmacy backend down once (2026-08-01).
- Optionally add `{{ .Token }}` to the Magic Link email template so the
  6-digit code box works — sign-in works without it today via the emailed
  link, but a typed code is better when staff read email on a phone and work
  at the till.

## Explicitly NOT next

Labs, insurance/SHA claims, and dashboards all wait until the loop above runs
in production. That sequencing is the main defence against scope creep. When
SHA does come up, treat the claim format as a research task — the spec has
shifted since the NHIF transition; don't build it from memory.
