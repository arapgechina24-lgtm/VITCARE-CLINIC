-- VITCARE-CLINIC — Billing for clinic services
-- ---------------------------------------------------------------------------
-- ── SCOPE, AND THE LINE THAT MUST NOT MOVE ─────────────────────────────────
-- This bills CLINIC SERVICES: consultation, procedures, dressings, observation.
-- It does NOT bill medicines. VITCARE-POS prices and takes payment for drugs
-- on a KRA-fiscal receipt; charging them again here would take money from the
-- patient twice for one item. A prescription's total is therefore displayed
-- beside an invoice as POS's figure and never summed into it.
--
-- ── NUMBERING ──────────────────────────────────────────────────────────────
-- POS issues VC-YYYYMMDD-NNNN as a fiscal invoice number, server-allocated in
-- blocks (see its reserve_invoice_block). Clinic invoices use a DISTINCT
-- prefix, VC-CL-YYYYMMDD-NNNN, because two systems minting the same number
-- against the same KRA PIN is a compliance problem, not a cosmetic one.
-- These documents are NOT fiscalised: eTIMS lives in POS, and nothing here
-- claims otherwise.
--
-- ── THE INVARIANT ──────────────────────────────────────────────────────────
-- Totals are DERIVED, never supplied. subtotal/vat/total come from the items
-- and paid comes from the payments, both recomputed by trigger on every write.
-- A client cannot post a total, because a client that can post a total can
-- post the wrong one, and an invoice whose stated total disagrees with its own
-- lines is the single worst bug a billing module can have. The API surface
-- below has no parameter that sets an amount on an invoice — only lines and
-- payments, from which amounts follow.
--
-- Money is integer CENTS of KES throughout, matching prescriptions.
-- total_amount_cents. Unit prices are VAT-EXCLUSIVE, matching how POS stores
-- them; VAT is computed per line and summed, which is how the printed document
-- reads and therefore how it must total.

-- ── Catalogue ─────────────────────────────────────────────────────────────
create table if not exists service_catalog (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  code text not null,
  name text not null,
  category text,
  price_cents integer not null check (price_cents >= 0),
  -- Kenya VAT is 0 (exempt/zero-rated, category A) or 0.16 (standard, B).
  -- Constrained rather than free numeric: an invented rate on a tax document
  -- is not a rounding question, it is a wrong tax return.
  vat_rate numeric(4,2) not null default 0 check (vat_rate in (0, 0.16)),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (site_id, code)
);
alter table service_catalog enable row level security;

create policy service_catalog_site_read on service_catalog
  for select using (site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'));
-- Prices are set by an administrator, not by whoever is on the desk.
create policy service_catalog_admin_write on service_catalog
  for all using (has_role(auth.uid(), 'ADMIN')) with check (has_role(auth.uid(), 'ADMIN'));
grant select on service_catalog to authenticated;

-- ── Invoices ──────────────────────────────────────────────────────────────
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  -- Null until issued: a draft has no number, so an abandoned draft does not
  -- burn one and leave an unexplained hole in the day's sequence.
  invoice_no text unique,
  encounter_id uuid references encounters(id),
  patient_id uuid not null references patients(id),
  site_id uuid not null references sites(id),
  status text not null default 'DRAFT'
    check (status in ('DRAFT','ISSUED','PART_PAID','PAID','VOID')),
  payer text not null default 'CASH' check (payer in ('CASH','SHA','INSURER')),
  insurer_code text,
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  vat_cents integer not null default 0 check (vat_cents >= 0),
  total_cents integer not null default 0 check (total_cents >= 0),
  paid_cents integer not null default 0 check (paid_cents >= 0),
  void_reason text,
  issued_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table invoices enable row level security;

create policy invoices_site_read on invoices
  for select using (site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'));
create policy invoices_cashier_write on invoices
  for insert with check (
    created_by = auth.uid()
    and site_id in (select site_id from user_sites(auth.uid()))
    and (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN'))
  );
create policy invoices_site_update on invoices
  for update using (site_id in (select site_id from user_sites(auth.uid())));
grant select, insert, update on invoices to authenticated;

create index if not exists invoices_site_status_idx on invoices (site_id, status);
create index if not exists invoices_patient_idx on invoices (patient_id);
create index if not exists invoices_encounter_idx on invoices (encounter_id);

create table if not exists invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  service_id uuid references service_catalog(id),
  -- Description and price are SNAPSHOTS, not lookups. Re-reading the catalogue
  -- when an old invoice is opened would silently restate what a patient was
  -- charged the moment a price changes.
  description text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  vat_rate numeric(4,2) not null default 0 check (vat_rate in (0, 0.16)),
  created_at timestamptz not null default now()
);
alter table invoice_items enable row level security;

create policy invoice_items_site_read on invoice_items
  for select using (exists (
    select 1 from invoices i where i.id = invoice_id
      and (i.site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'))
  ));
grant select on invoice_items to authenticated;

create index if not exists invoice_items_invoice_idx on invoice_items (invoice_id);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id),
  method text not null check (method in ('CASH','MPESA','INSURER','WAIVER')),
  amount_cents integer not null check (amount_cents > 0),
  reference text,
  received_by uuid not null references users(id),
  received_at timestamptz not null default now()
);
alter table payments enable row level security;

-- No UPDATE and no DELETE policy anywhere, and none granted below. A received
-- payment is a financial record: correcting one is a new compensating entry,
-- not an edit, for the same reason the POS stock ledger is append-only.
create policy payments_site_read on payments
  for select using (exists (
    select 1 from invoices i where i.id = invoice_id
      and (i.site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'))
  ));
grant select on payments to authenticated;

create index if not exists payments_invoice_idx on payments (invoice_id);

-- ── Numbering counter ─────────────────────────────────────────────────────
create table if not exists invoice_counters (
  site_id uuid not null references sites(id),
  day date not null,
  next_seq integer not null default 1,
  primary key (site_id, day)
);
alter table invoice_counters enable row level security;
-- Zero policies on purpose: only the SECURITY DEFINER allocator below touches
-- this, and it runs as the owner. Same posture as integration_outbox.

-- ── The derivation ────────────────────────────────────────────────────────
-- One function, called by every trigger, so there is exactly one definition of
-- what an invoice's numbers mean.
create or replace function billing_recalc_invoice(p_invoice_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_subtotal integer;
  v_vat integer;
  v_paid integer;
  v_status text;
begin
  select
    coalesce(sum(quantity * unit_price_cents), 0),
    -- Rounded PER LINE and then summed, because that is what the printed
    -- invoice shows line by line. Rounding the sum instead can differ by a
    -- cent from the document the patient is holding.
    coalesce(sum(round(quantity * unit_price_cents * vat_rate)), 0)
  into v_subtotal, v_vat
  from invoice_items where invoice_id = p_invoice_id;

  select coalesce(sum(amount_cents), 0) into v_paid
  from payments where invoice_id = p_invoice_id;

  select status into v_status from invoices where id = p_invoice_id;

  update invoices
  set subtotal_cents = v_subtotal,
      vat_cents = v_vat,
      total_cents = v_subtotal + v_vat,
      paid_cents = v_paid,
      status = case
        -- DRAFT and VOID are states a human put the invoice in; arithmetic
        -- must not move it out of either.
        when v_status in ('DRAFT', 'VOID') then v_status
        when v_paid >= v_subtotal + v_vat then 'PAID'
        when v_paid > 0 then 'PART_PAID'
        else 'ISSUED'
      end,
      updated_at = now()
  where id = p_invoice_id;
end;
$$;
revoke execute on function billing_recalc_invoice(uuid) from anon;
revoke execute on function billing_recalc_invoice(uuid) from authenticated;

create or replace function billing_items_changed()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform billing_recalc_invoice(coalesce(new.invoice_id, old.invoice_id));
  return coalesce(new, old);
end;
$$;
revoke execute on function billing_items_changed() from anon;
revoke execute on function billing_items_changed() from authenticated;

drop trigger if exists trg_invoice_items_recalc on invoice_items;
create trigger trg_invoice_items_recalc after insert or update or delete on invoice_items
  for each row execute function billing_items_changed();

drop trigger if exists trg_payments_recalc on payments;
create trigger trg_payments_recalc after insert or update or delete on payments
  for each row execute function billing_items_changed();

-- Audit: invoices and payments are money, and the audit trigger already knows
-- how to record a row change. patient_id resolution for these two tables goes
-- through the jsonb path added in 0018.
create or replace function audit_row_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_patient_id uuid;
  v_row jsonb := to_jsonb(coalesce(new, old));
begin
  v_patient_id := case
    when TG_TABLE_NAME = 'patients' then coalesce(new.id, old.id)
    when TG_TABLE_NAME in ('encounters', 'prescriptions', 'appointments', 'invoices')
      then (v_row ->> 'patient_id')::uuid
    when TG_TABLE_NAME = 'prescription_items' then (
      select patient_id from prescriptions where id = (v_row ->> 'prescription_id')::uuid
    )
    when TG_TABLE_NAME in ('invoice_items', 'payments') then (
      select patient_id from invoices where id = (v_row ->> 'invoice_id')::uuid
    )
    else null
  end;
  insert into audit_log(actor_id, action, table_name, record_id, patient_id, details)
  values (auth.uid(), TG_OP, TG_TABLE_NAME, coalesce(new.id, old.id), v_patient_id, v_row);
  return coalesce(new, old);
end;
$$;
revoke execute on function audit_row_change() from anon;
revoke execute on function audit_row_change() from authenticated;

drop trigger if exists trg_audit_invoices on invoices;
create trigger trg_audit_invoices after insert or update or delete on invoices
  for each row execute function audit_row_change();
drop trigger if exists trg_audit_payments on payments;
create trigger trg_audit_payments after insert or update or delete on payments
  for each row execute function audit_row_change();
