-- VITCARE-CLINIC — charge capture: what was done, recorded where it happened
-- ---------------------------------------------------------------------------
-- ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
-- Until now the treatment module and the billing module did not touch. A
-- clinician dressed a wound, took a swab and gave an injection; the receptionist
-- then had to work out what to charge from a paper note, a verbal handover, or
-- a guess. That gap has exactly two failure modes and a clinic runs into both:
-- services performed and never billed, and services billed that were never
-- performed. The first is revenue the facility earned and lost. The second is a
-- patient charged for something that did not happen.
--
-- So the clinician now records what they did, at the point of care, against the
-- catalogue. The desk pulls that list onto the invoice. Nobody retypes anything.
--
-- ── WHY THIS IS NOT JUST "LET CLINICIANS ADD INVOICE LINES" ────────────────
-- Because they are different acts by different people with different authority.
-- Recording that a procedure was performed is a CLINICAL statement — it belongs
-- in the record whether or not anyone ever pays for it. Putting a priced line on
-- a financial document is a CASHIER's act, and 0021 restricts it to the desk
-- roles for good reason. Collapsing the two would either hand clinicians the
-- till or make the clinical record depend on someone opening an invoice.
--
-- Keeping them separate buys the property that matters most here:
--
--   A NON-BILLABLE SERVICE IS STILL RECORDED.
--
-- KEPI immunisation, HIV testing, TB treatment and PEP must never be charged —
-- and must always be captured, because SHA capitation is disbursed on reported
-- service volume. If capture happened by adding an invoice line, then every
-- service that cannot be charged would go unrecorded, and the facility would
-- under-report exactly the work the Primary Healthcare Fund pays it for.
-- record_encounter_service therefore accepts non-billable services deliberately;
-- pull_encounter_services_to_invoice is what leaves them off the bill.

create table if not exists encounter_services (
  id uuid primary key default gen_random_uuid(),
  encounter_id uuid not null references encounters(id) on delete cascade,
  service_id uuid not null references service_catalog(id),
  quantity integer not null check (quantity > 0),
  -- "left forearm", "second dressing today". Clinical context for the next
  -- person to open the chart, not a billing field.
  note text,
  recorded_by uuid not null references users(id),
  recorded_at timestamptz not null default now(),
  -- Set when the desk pulls this onto an invoice; ON DELETE SET NULL so a line
  -- removed from a draft returns to the worklist instead of vanishing from it.
  invoice_item_id uuid references invoice_items(id) on delete set null,
  -- One row per service per visit. Doing a dressing three times is quantity 3,
  -- not three rows — which also makes re-recording an idempotent correction
  -- rather than a silent duplicate charge.
  unique (encounter_id, service_id)
);
alter table encounter_services enable row level security;

create index if not exists encounter_services_encounter_idx
  on encounter_services (encounter_id);
-- Drives the desk's "not yet billed" worklist.
create index if not exists encounter_services_unbilled_idx
  on encounter_services (encounter_id) where invoice_item_id is null;

-- Read is site-scoped; every write goes through the SECURITY DEFINER functions
-- below, which is why there is no insert/update/delete policy here. Same shape
-- as invoice_items in 0020.
drop policy if exists encounter_services_site_read on encounter_services;
create policy encounter_services_site_read on encounter_services
  for select using (exists (
    select 1 from encounters e where e.id = encounter_id
      and (e.site_id in (select site_id from user_sites(auth.uid()))
           or has_role(auth.uid(), 'AUDITOR'))
  ));
grant select on encounter_services to authenticated;

-- ── Record ────────────────────────────────────────────────────────────────
-- Clinician, nurse or admin: dressings, injections and observations are nursing
-- work, so restricting this to prescribers would push the treatment room back
-- onto paper.
create or replace function record_encounter_service(
  p_encounter_id uuid,
  p_service_id uuid,
  p_quantity integer default 1,
  p_note text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_svc service_catalog;
  v_id uuid;
begin
  if not (has_role(auth.uid(), 'CLINICIAN') or has_role(auth.uid(), 'NURSE')
          or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'only clinical staff can record a service';
  end if;
  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'quantity must be at least 1';
  end if;

  select e.site_id into v_site_id from encounters e where e.id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  select * into v_svc from service_catalog s
  where s.id = p_service_id and s.site_id = v_site_id;
  if v_svc.id is null then
    raise exception 'unknown service for this site';
  end if;

  -- Inactive is refused: a Conditional module the facility does not run cannot
  -- have been performed, so recording it would be a false clinical statement.
  if not v_svc.active then
    raise exception '% is not available at this facility (% module is not active)',
      v_svc.code, v_svc.module;
  end if;
  -- NOT billable is deliberately allowed. See the header — this is the whole
  -- reason capture is separate from billing.

  insert into encounter_services (encounter_id, service_id, quantity, note, recorded_by)
  values (p_encounter_id, p_service_id, p_quantity,
          nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  on conflict (encounter_id, service_id) do update
    set quantity = excluded.quantity,
        note = excluded.note,
        recorded_by = excluded.recorded_by,
        recorded_at = now()
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function record_encounter_service(uuid, uuid, integer, text) from anon;
grant execute on function record_encounter_service(uuid, uuid, integer, text) to authenticated;

-- ── Un-record ─────────────────────────────────────────────────────────────
create or replace function remove_encounter_service(p_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_invoice_status text;
begin
  if not (has_role(auth.uid(), 'CLINICIAN') or has_role(auth.uid(), 'NURSE')
          or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'only clinical staff can withdraw a recorded service';
  end if;

  select e.site_id, i.status into v_site_id, v_invoice_status
  from encounter_services es
  join encounters e on e.id = es.encounter_id
  left join invoice_items it on it.id = es.invoice_item_id
  left join invoices i on i.id = it.invoice_id
  where es.id = p_id;

  if v_site_id is null then
    raise exception 'unknown recorded service';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  -- Once the charge is on a document the patient has seen, withdrawing the
  -- clinical record behind it would leave a priced line with nothing to justify
  -- it. Correct the invoice first, or record a clinical note.
  if v_invoice_status is not null and v_invoice_status <> 'DRAFT' then
    raise exception 'this service is billed on an invoice that is already % — void or credit it first',
      lower(v_invoice_status);
  end if;

  delete from encounter_services where id = p_id;
end;
$$;
revoke execute on function remove_encounter_service(uuid) from anon;
grant execute on function remove_encounter_service(uuid) to authenticated;

-- ── Read ──────────────────────────────────────────────────────────────────
-- One list serving two readers: the clinician sees what has been recorded for
-- this visit, the desk sees what is still waiting to be billed.
create or replace function list_encounter_services(p_encounter_id uuid)
returns table (
  id uuid, service_id uuid, code text, name text, category text, unit text,
  quantity integer, note text, recorded_by_name text, recorded_at timestamptz,
  billable boolean, sha_phc_status text, billing_notes text,
  cash_price_cents integer, insurance_price_cents integer,
  invoice_item_id uuid, billed boolean
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
begin
  select e.site_id into v_site_id from encounters e where e.id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or v_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select es.id, es.service_id, s.code, s.name, s.category, s.unit,
           es.quantity, es.note, u.full_name, es.recorded_at,
           s.billable, s.sha_phc_status, s.billing_notes,
           s.cash_price_cents, s.insurance_price_cents,
           es.invoice_item_id, es.invoice_item_id is not null
    from encounter_services es
    join service_catalog s on s.id = es.service_id
    left join users u on u.id = es.recorded_by
    where es.encounter_id = p_encounter_id
    order by es.recorded_at;
end;
$$;
revoke execute on function list_encounter_services(uuid) from anon;
grant execute on function list_encounter_services(uuid) to authenticated;

-- ── Pull onto the invoice ─────────────────────────────────────────────────
-- The desk's one-click bridge. Prices every capturable service at the invoice's
-- payer, skips what must not be charged, and links each line back to the
-- clinical record it came from.
--
-- Returns counts rather than raising on the skips: a visit that included an
-- immunisation and a dressing should bill the dressing and say plainly that one
-- service was not chargeable — not fail, and not silently drop it.
create or replace function pull_encounter_services_to_invoice(p_invoice_id uuid)
returns table (added integer, skipped integer)
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
  v_payer text;
  v_encounter_id uuid;
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
  v_added integer := 0;
  v_skipped integer := 0;
  r record;
  v_item_id uuid;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to add charges';
  end if;

  select i.site_id, i.status, i.payer, i.encounter_id
    into v_site_id, v_status, v_payer, v_encounter_id
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
  if v_encounter_id is null then
    raise exception 'this invoice is not attached to an encounter';
  end if;

  for r in
    -- Aliased, not bare: s.* already carries an `id`, so selecting es.id
    -- unqualified would put two columns of that name in the record and the
    -- insert below (which wants the SERVICE id) and the update at the end of
    -- the loop (which wants the CAPTURE id) would silently disagree.
    select es.id as es_id, es.quantity as es_qty, s.*
    from encounter_services es
    join service_catalog s on s.id = es.service_id
    where es.encounter_id = v_encounter_id
      and es.invoice_item_id is null      -- idempotent: already-billed rows are skipped
    order by es.recorded_at
  loop
    -- The same three refusals add_invoice_item applies, counted instead of
    -- raised. A statutory service stays recorded and unbilled, which is the
    -- correct outcome, not an error.
    if not r.billable or not r.active or r.effective_from > v_today then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into invoice_items (
      invoice_id, service_id, description, unit, quantity,
      unit_price_cents, vat_rate, price_basis
    )
    values (
      p_invoice_id, r.id, r.name, r.unit, r.es_qty,
      billing_price_cents(v_payer, r.sha_phc_status,
                          r.cash_price_cents, r.insurance_price_cents),
      r.vat_rate,
      billing_price_basis(v_payer, r.sha_phc_status)
    )
    returning id into v_item_id;

    update encounter_services set invoice_item_id = v_item_id where id = r.es_id;
    v_added := v_added + 1;
  end loop;

  perform billing_recalc_invoice(p_invoice_id);
  return query select v_added, v_skipped;
end;
$$;
revoke execute on function pull_encounter_services_to_invoice(uuid) from anon;
grant execute on function pull_encounter_services_to_invoice(uuid) to authenticated;
