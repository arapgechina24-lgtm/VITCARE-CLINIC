-- VITCARE-CLINIC — the payer decides the price, so it is chosen first
-- ---------------------------------------------------------------------------
-- ── THE DEFECT THIS FIXES ──────────────────────────────────────────────────
-- 0021 asked for the payer in issue_invoice(), at the END of the workflow:
--
--     open_invoice_for_encounter(encounter)          -- no payer
--     add_invoice_item(invoice, service, qty)        -- prices the line
--     add_invoice_item(...)                          -- prices the line
--     issue_invoice(invoice, 'INSURER', 'KENGEN')    -- payer, finally
--
-- With one price per service that was merely odd. With the real catalogue it is
-- wrong: cash and credit tariffs differ by a 20% uplift, and SHA-covered
-- services must not be charged at all. Every line above was priced before the
-- system knew which of those applied, and issue_invoice() changed the payer
-- without touching a single line — so an insurer would have been invoiced at
-- cash rates, quietly, with the document's own payer field saying otherwise.
--
-- The payer now belongs to the invoice from the moment it is opened, and
-- changing it re-prices what is already on it.
--
-- ── THE PRICING RULE, IN ONE PLACE ─────────────────────────────────────────
--   payer     sha_phc_status   price        basis
--   CASH      any              cash         CASH
--   INSURER   any              insurance    INSURANCE
--   SHA       Covered          0            SHA_COVERED
--   SHA       anything else    cash         CASH
--
-- Two of those rows deserve their reasoning stated.
--
-- SHA + Covered → ZERO, NOT REFUSED. The Primary Healthcare Fund pays by
-- capitation — a gazetted KES 900 per registered person per year, disbursed on
-- reported service volume. So the catalogue's rule has two halves that pull in
-- opposite directions: "SHA-registered patients MUST NOT be charged cash for
-- services flagged 'Covered'", and "every encounter must still be captured in
-- the EMR and submitted, because reported volume drives the disbursement."
-- Refusing the line would satisfy the first and break the second. A line at
-- zero satisfies both: the patient pays nothing, and the service is on the
-- record where the claim can find it.
--
-- SHA + not covered → CASH, NOT THE CREDIT TARIFF. This one is a judgement
-- call and is flagged as such. The workbook defines the insurance column as
-- applying to "private schemes... that settle on credit terms", which SHA is
-- not, and it says nothing about what an SHA member pays for a service outside
-- the covered set. Between the two available columns, cash is the one that
-- cannot overcharge a patient who is paying out of pocket. price_basis records
-- which column was used on every line, so if the facility rules otherwise the
-- affected invoices can be found rather than guessed at.
--
-- ── WHAT CANNOT BE CHARGED ─────────────────────────────────────────────────
-- add_invoice_item now refuses three things outright, rather than pricing them
-- at zero and hoping:
--   · a non-billable service — statutory, programme-funded, or POS-priced;
--   · an inactive service — a Conditional module the facility does not run;
--   · a service whose price is not yet effective (catalogue v1.0 is dated
--     01-Sep-2026 and marked DRAFT pending board approval).
-- The error names the reason and quotes the catalogue's own note, because a
-- refusal a receptionist cannot explain to the patient in front of them is a
-- refusal that gets worked around.

-- ── The rule, as two immutable functions ──────────────────────────────────
-- Extracted so the catalogue screen, the charge path and the re-pricing path
-- cannot drift. IMMUTABLE: same inputs, same answer, no reads.
create or replace function billing_price_cents(
  p_payer text, p_sha_status text, p_cash_cents integer, p_insurance_cents integer
)
returns integer language sql immutable
as $$
  select case
    when p_payer = 'INSURER' then p_insurance_cents
    when p_payer = 'SHA' and p_sha_status = 'Covered' then 0
    else p_cash_cents
  end;
$$;

create or replace function billing_price_basis(p_payer text, p_sha_status text)
returns text language sql immutable
as $$
  select case
    when p_payer = 'INSURER' then 'INSURANCE'
    when p_payer = 'SHA' and p_sha_status = 'Covered' then 'SHA_COVERED'
    else 'CASH'
  end;
$$;

-- ── Catalogue ─────────────────────────────────────────────────────────────
-- Dropped rather than replaced: the return type gains columns, and
-- CREATE OR REPLACE cannot change one.
drop function if exists list_service_catalog(uuid);
create or replace function list_service_catalog(
  p_site_id uuid,
  p_payer text default 'CASH',
  p_include_inactive boolean default false
)
returns table (
  id uuid, code text, name text, category text, sub_category text, unit text,
  module text, sha_phc_status text, billable boolean, active boolean,
  cash_price_cents integer, insurance_price_cents integer,
  price_cents integer, price_basis text,
  effective_from date, chargeable boolean, billing_notes text
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
begin
  if p_payer not in ('CASH','SHA','INSURER') then
    raise exception 'unsupported payer %', p_payer;
  end if;
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select
      s.id, s.code, s.name, s.category, s.sub_category, s.unit,
      s.module, s.sha_phc_status, s.billable, s.active,
      s.cash_price_cents, s.insurance_price_cents,
      billing_price_cents(p_payer, s.sha_phc_status, s.cash_price_cents, s.insurance_price_cents),
      billing_price_basis(p_payer, s.sha_phc_status),
      s.effective_from,
      -- Exactly what add_invoice_item will accept. The screen greys out what
      -- the server would refuse, from the same three conditions, so a desk
      -- never discovers the refusal only after clicking.
      (s.billable and s.active and s.effective_from <= v_today),
      s.billing_notes
    from service_catalog s
    where s.site_id = p_site_id
      and (p_include_inactive or s.active)
    order by s.category nulls last, s.sub_category nulls last, s.name;
end;
$$;
revoke execute on function list_service_catalog(uuid, text, boolean) from anon;
grant execute on function list_service_catalog(uuid, text, boolean) to authenticated;

-- ── Payer, and re-pricing what is already on the draft ────────────────────
-- The one place in this module that deliberately re-reads the catalogue after
-- a line has been written. Everywhere else a price is a snapshot, because
-- restating an old invoice when a price changes is a lie about what a patient
-- was charged. Here the invoice is still a DRAFT and the question it answers
-- has changed — not "what did this cost?" but "who is paying?" — so leaving the
-- old figures would be the lie instead.
create or replace function set_invoice_payer(
  p_invoice_id uuid,
  p_payer text,
  p_insurer_code text default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to set the payer';
  end if;
  if p_payer not in ('CASH','SHA','INSURER') then
    raise exception 'unsupported payer %', p_payer;
  end if;
  if p_payer = 'INSURER' and coalesce(btrim(p_insurer_code), '') = '' then
    raise exception 'an insurer-paid invoice needs an insurer code';
  end if;

  select i.site_id, i.status into v_site_id, v_status
  from invoices i where i.id = p_invoice_id;
  if v_site_id is null then
    raise exception 'unknown invoice';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'invoice is % — the payer is fixed once it is issued', lower(v_status);
  end if;

  update invoices
  set payer = p_payer,
      insurer_code = case when p_payer = 'INSURER'
                          then btrim(p_insurer_code) else null end,
      updated_at = now()
  where id = p_invoice_id;

  -- Re-price every line that came from the catalogue. A hand-entered line has
  -- no service_id and no catalogue price to re-read, so it is left alone
  -- rather than silently zeroed.
  update invoice_items it
  set unit_price_cents = billing_price_cents(p_payer, s.sha_phc_status,
                                             s.cash_price_cents, s.insurance_price_cents),
      price_basis = billing_price_basis(p_payer, s.sha_phc_status),
      unit = s.unit
  from service_catalog s
  where s.id = it.service_id and it.invoice_id = p_invoice_id;

  -- The per-row trigger from 0020 already re-derives the totals; this makes
  -- the invoice correct even when no line was touched.
  perform billing_recalc_invoice(p_invoice_id);
end;
$$;
revoke execute on function set_invoice_payer(uuid, text, text) from anon;
grant execute on function set_invoice_payer(uuid, text, text) to authenticated;

-- ── Open ──────────────────────────────────────────────────────────────────
-- Signature changes, so the one-argument version has to go: leaving both would
-- make a one-argument call ambiguous and Postgres would refuse it at runtime.
drop function if exists open_invoice_for_encounter(uuid);
create or replace function open_invoice_for_encounter(
  p_encounter_id uuid,
  p_payer text default 'CASH',
  p_insurer_code text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_patient_id uuid;
  v_invoice_id uuid;
  v_existing_payer text;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to raise invoices';
  end if;
  if p_payer not in ('CASH','SHA','INSURER') then
    raise exception 'unsupported payer %', p_payer;
  end if;

  select e.site_id, e.patient_id into v_site_id, v_patient_id
  from encounters e where e.id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  select i.id, i.payer into v_invoice_id, v_existing_payer
  from invoices i
  where i.encounter_id = p_encounter_id and i.status = 'DRAFT'
  limit 1;

  if v_invoice_id is not null then
    -- Still idempotent — one visit, one draft — but not inert. A desk that
    -- reopens with a corrected payer means it, and the alternative is a
    -- silently ignored correction on a document about to be issued.
    if v_existing_payer is distinct from p_payer then
      perform set_invoice_payer(v_invoice_id, p_payer, p_insurer_code);
    end if;
    return v_invoice_id;
  end if;

  insert into invoices (encounter_id, patient_id, site_id, payer, insurer_code, created_by)
  values (p_encounter_id, v_patient_id, v_site_id, p_payer,
          case when p_payer = 'INSURER' then nullif(btrim(coalesce(p_insurer_code, '')), '') end,
          auth.uid())
  returning id into v_invoice_id;

  return v_invoice_id;
end;
$$;
revoke execute on function open_invoice_for_encounter(uuid, text, text) from anon;
grant execute on function open_invoice_for_encounter(uuid, text, text) to authenticated;

-- ── Charge ────────────────────────────────────────────────────────────────
create or replace function add_invoice_item(
  p_invoice_id uuid,
  p_service_id uuid,
  p_quantity integer
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
  v_payer text;
  v_item_id uuid;
  v_svc service_catalog;
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to add charges';
  end if;
  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'quantity must be at least 1';
  end if;

  select i.site_id, i.status, i.payer into v_site_id, v_status, v_payer
  from invoices i where i.id = p_invoice_id;
  if v_site_id is null then
    raise exception 'unknown invoice';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'invoice is % — charges can only be added to a draft', lower(v_status);
  end if;

  select * into v_svc from service_catalog s
  where s.id = p_service_id and s.site_id = v_site_id;
  if v_svc.id is null then
    raise exception 'unknown service for this site';
  end if;

  -- The three refusals. Each quotes the catalogue so the desk can explain it.
  if not v_svc.billable then
    raise exception '% must not be charged: %',
      v_svc.code, coalesce(v_svc.billing_notes, 'statutory or programme-funded service');
  end if;
  if not v_svc.active then
    raise exception '% is not available at this facility (% module is not active)',
      v_svc.code, v_svc.module;
  end if;
  if v_svc.effective_from > v_today then
    raise exception '% is priced from % and cannot be charged yet',
      v_svc.code, to_char(v_svc.effective_from, 'DD Mon YYYY');
  end if;

  insert into invoice_items (
    invoice_id, service_id, description, unit, quantity,
    unit_price_cents, vat_rate, price_basis
  )
  values (
    p_invoice_id, p_service_id, v_svc.name, v_svc.unit, p_quantity,
    billing_price_cents(v_payer, v_svc.sha_phc_status,
                        v_svc.cash_price_cents, v_svc.insurance_price_cents),
    v_svc.vat_rate,
    billing_price_basis(v_payer, v_svc.sha_phc_status)
  )
  returning id into v_item_id;

  return v_item_id;
end;
$$;
revoke execute on function add_invoice_item(uuid, uuid, integer) from anon;
grant execute on function add_invoice_item(uuid, uuid, integer) to authenticated;

-- ── Issue ─────────────────────────────────────────────────────────────────
-- One argument now. The payer is already on the invoice and every line has
-- been priced from it; taking it again here is what allowed the two to
-- disagree in the first place.
drop function if exists issue_invoice(uuid, text, text);
create or replace function issue_invoice(p_invoice_id uuid)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
  v_payer text;
  v_insurer text;
  v_items integer;
  v_day date;
  v_seq integer;
  v_no text;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to issue invoices';
  end if;

  select i.site_id, i.status, i.payer, i.insurer_code
    into v_site_id, v_status, v_payer, v_insurer
  from invoices i where i.id = p_invoice_id;
  if v_site_id is null then
    raise exception 'unknown invoice';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'invoice is already %', lower(v_status);
  end if;
  if v_payer = 'INSURER' and coalesce(btrim(v_insurer), '') = '' then
    raise exception 'an insurer-paid invoice needs an insurer code';
  end if;

  select count(*) into v_items from invoice_items where invoice_id = p_invoice_id;
  if v_items = 0 then
    raise exception 'cannot issue an invoice with no charges on it';
  end if;

  -- Clinic-local day, not UTC: at 01:00 in Nairobi a UTC date is still
  -- yesterday, which would file the invoice under the wrong day's sequence.
  v_day := (now() at time zone 'Africa/Nairobi')::date;

  insert into invoice_counters (site_id, day, next_seq)
  values (v_site_id, v_day, 2)
  on conflict (site_id, day) do update set next_seq = invoice_counters.next_seq + 1
  returning next_seq - 1 into v_seq;

  v_no := 'VC-CL-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_seq::text, 4, '0');

  update invoices
  set invoice_no = v_no,
      status = 'ISSUED',
      issued_at = now(),
      updated_at = now()
  where id = p_invoice_id;

  -- Re-derive so an all-SHA-covered invoice, which totals zero, lands on PAID
  -- rather than sitting on ISSUED with nothing owing against it.
  perform billing_recalc_invoice(p_invoice_id);

  return v_no;
end;
$$;
revoke execute on function issue_invoice(uuid) from anon;
grant execute on function issue_invoice(uuid) to authenticated;
