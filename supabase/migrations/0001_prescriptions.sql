-- VITCARE-CLINIC — Prescription + integration tables
-- ---------------------------------------------------------------------------
-- Depends on 0000_base_schema.sql (sites, users, patients, encounters,
-- has_role(), user_sites(), audit_row_change()).

-- ── Prescriptions ────────────────────────────────────────────────────────
create table if not exists prescriptions (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references encounters(id),
  patient_id uuid not null references patients(id),
  prescriber_id uuid not null references users(id),
  fulfillment_site_id uuid not null references sites(id),
  status text not null default 'DRAFT'
    check (status in ('DRAFT','PENDING','PRICED','DISPENSED','COLLECTED',
                      'OUT_OF_STOCK','PARTIAL','SUBSTITUTED','CANCELLED')),
  total_amount_cents integer,             -- populated from POS on PRICED
  payer text not null default 'CASH'
    check (payer in ('CASH','SHA','INSURER')),
  insurer_code text,
  note text,
  site_id uuid not null references sites(id),   -- issuing site (for RLS)
  created_by uuid not null references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists prescription_items (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references prescriptions(id) on delete cascade,
  drug_code text,
  drug_name text not null,
  strength text,
  dose text not null,
  frequency text not null,
  duration_days integer,
  quantity integer not null check (quantity > 0),
  instructions text,
  substitution_allowed boolean not null default false,
  dispensed_quantity integer,             -- filled from POS events
  line_status text
);

-- ── Outbox (CLINIC → POS reliability) ────────────────────────────────────
-- Written in the SAME transaction as the prescription. A worker drains it.
create table if not exists integration_outbox (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references prescriptions(id),
  payload jsonb not null,                 -- the CreatePrescription contract body
  delivered boolean not null default false,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_outbox_pending
  on integration_outbox (next_attempt_at)
  where delivered = false;

-- ── Processed webhook events (POS → CLINIC idempotency) ──────────────────
create table if not exists processed_webhook_events (
  event_id uuid primary key,             -- dedupe: one row per POS eventId
  prescription_id uuid not null,
  status text not null,
  received_at timestamptz not null default now()
);

-- ── Row-Level Security ────────────────────────────────────────────────────
alter table prescriptions enable row level security;
alter table prescription_items enable row level security;
alter table integration_outbox enable row level security;
alter table processed_webhook_events enable row level security;

create policy prescriptions_site_read on prescriptions
  for select using (site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'));

create policy prescriptions_clinician_write on prescriptions
  for insert with check (
    created_by = auth.uid()
    and has_role(auth.uid(), 'CLINICIAN')
  );

create policy prescriptions_clinician_update on prescriptions
  for update using (site_id in (select site_id from user_sites(auth.uid())));

-- prescription_items inherit visibility from their parent prescription.
create policy prescription_items_read on prescription_items
  for select using (
    exists (
      select 1 from prescriptions p
      where p.id = prescription_items.prescription_id
        and (p.site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'))
    )
  );
create policy prescription_items_write on prescription_items
  for insert with check (
    exists (
      select 1 from prescriptions p
      where p.id = prescription_items.prescription_id
        and p.created_by = auth.uid()
    )
  );

grant select, insert, update on prescriptions to authenticated;
grant select, insert on prescription_items to authenticated;

-- integration_outbox and processed_webhook_events get NO grant to
-- authenticated/anon at all (on top of having zero policies) — only the
-- service-role key (server code / the drain worker) can touch them.

-- ── Write-side audit — reuses the same trigger as patients/encounters ────
create trigger trg_audit_prescriptions after insert or update or delete on prescriptions
  for each row execute function audit_row_change();
create trigger trg_audit_prescription_items after insert or update or delete on prescription_items
  for each row execute function audit_row_change();

-- Added in 0006 (kept here too so a fresh deploy gets it inline): a
-- permanently-failed delivery needs a terminal state distinct from
-- `delivered`, or the drain re-sends it forever. See 0006_outbox_failed_flag.sql.
