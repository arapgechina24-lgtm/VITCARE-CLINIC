-- VITCARE-CLINIC — what a farm pays, and how a returning patient gets a visit
-- ---------------------------------------------------------------------------
-- Groundwork for letting clinicians treat corporate patients through the
-- ordinary chain. Nothing here is visible to a user yet, and nothing here
-- changes an existing behaviour: it adds a price list, a duplicate guard, and
-- the one primitive the clinical spine turned out to be missing.
--
-- ── WHY A SCHEME NEEDS ITS OWN PRICE LIST ──────────────────────────────────
-- The obvious design is to make "SCHEME" a fourth payer next to CASH / SHA /
-- INSURER and let billing_price_cents() pick a column. That is wrong twice
-- over, and both reasons are worth stating so nobody re-proposes it.
--
-- FIRST, the columns are not the farms' prices. The catalogue charges KES 500
-- cash for a Clinical Officer consultation (CON-002) and KES 600 on the
-- insurance column. Stokman's contract is KES 100. La Pieve's is KES 50. A
-- payer column would put a figure five to ten times the agreed rate on a
-- document going to a customer's finance office — the same class of error as
-- 0025's, where an insurer was invoiced at cash rates.
--
-- SECOND, `payer` is not ours alone. The enum ('CASH','SHA','INSURER') is
-- written into invoices, into prescriptions, and into the HMAC prescription
-- contract that VITCARE-POS validates with a Zod enum on its side of the wire.
-- Adding a value to it is a breaking change to a signed cross-system contract,
-- and the failure mode is silent: prescriptions for corporate patients would
-- stop reaching the pharmacy. So the payer enum is not touched, here or later.
--
-- A scheme tariff is therefore its own dated list, exactly like scheme_limits
-- and for the same reason: a price is a term of a contract that gets
-- renegotiated, and last March's statement has to keep reporting last March's
-- price.
--
-- ── UNTARIFFED IS NULL, NEVER ZERO ─────────────────────────────────────────
-- scheme_tariff() returns no row for a service the contract does not cover.
-- That has to stay distinguishable from a service the contract covers at no
-- charge. Collapsing the two would either bill a farm for something never
-- agreed, or silently drop a chargeable service off the statement — which is
-- the KES 130,000 hole 0030 was written to close, reappearing by a different
-- route. The derivation in 0038 refuses on a missing tariff and names the
-- service; it never falls back to the catalogue price.
--
-- ── THE BUCKET LIVES ON THE TARIFF ROW ─────────────────────────────────────
-- The farms' sheets have four columns — CONSULTATION, LAB, SURGICAL, PHARMACY
-- — and 237 catalogue services across 19 categories have to land in them. The
-- tempting shortcut is a category-to-column map inside the derivation. It is a
-- bad shortcut: "Nursing & Treatment Room" holds both a dressing (surgical, on
-- the farms' sheet) and an observation; "Occupational Health & Certification"
-- is the pre-employment medical the farms buy by the dozen. A hardcoded map
-- would have to guess, and a new category would land nowhere without anyone
-- noticing.
--
-- So the column is declared once, per scheme, at the moment the price is
-- agreed — which is when somebody actually knows the answer. It cannot go
-- missing, because a service with no tariff row is refused anyway.

-- ── The tariff ────────────────────────────────────────────────────────────
create table if not exists scheme_tariffs (
  id uuid primary key default gen_random_uuid(),
  scheme_id uuid not null references schemes(id) on delete cascade,
  service_id uuid not null references service_catalog(id),
  -- Which of the farm's four columns this service is billed under.
  bucket text not null check (bucket in ('CONSULTATION','LAB','SURGICAL','PHARMACY')),
  price_cents integer not null check (price_cents >= 0),
  -- The day this price starts applying. Unlike a monthly cap, a negotiated
  -- price can legitimately change mid-month, so this is not forced to the 1st.
  -- It is resolved against the DATE OF THE VISIT, so back-entering last week
  -- bills at last week's price.
  effective_from date not null,
  note text,
  set_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique (scheme_id, service_id, effective_from)
);
alter table scheme_tariffs enable row level security;
create policy scheme_tariffs_site_read on scheme_tariffs
  for select using (exists (
    select 1 from schemes s where s.id = scheme_id
      and (s.site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'))
  ));
create policy scheme_tariffs_admin_write on scheme_tariffs
  for all using (has_role(auth.uid(), 'ADMIN')) with check (has_role(auth.uid(), 'ADMIN'));
grant select on scheme_tariffs to authenticated;
-- Not decoration, and not covered by the GRANT above. Supabase's project
-- template hands `anon` and `authenticated` every verb on a newly created table
-- in `public`, so a table is fully writable the moment it exists and a
-- `grant select` adds nothing. RLS refuses the DML verbs here because both
-- policies test auth.uid() — but RLS DOES NOT POLICE TRUNCATE, so for that one
-- verb the grant is the entire control, exactly as 0028 found on audit_log.
-- Every 0030 table carries this line; scheme_tariffs is no different.
revoke insert, update, delete, truncate on scheme_tariffs from authenticated, anon;

create index if not exists scheme_tariffs_lookup_idx
  on scheme_tariffs (scheme_id, service_id, effective_from desc);

-- A price is a contract term, so changing one leaves a trail for the same
-- reason changing a cap does.
drop trigger if exists trg_audit_scheme_tariffs on scheme_tariffs;
create trigger trg_audit_scheme_tariffs after insert or update or delete on scheme_tariffs
  for each row execute function audit_row_change();

-- ── Resolve one ───────────────────────────────────────────────────────────
-- Zero rows means "this contract does not cover that service". Callers must
-- treat that as a refusal, not as free. SECURITY INVOKER, like
-- scheme_cap_cents: it reads a table the caller can already read.
create or replace function scheme_tariff(
  p_scheme_id uuid,
  p_service_id uuid,
  p_on date
)
returns table (price_cents integer, bucket text)
language sql
stable
set search_path = public
as $$
  select t.price_cents, t.bucket
  from scheme_tariffs t
  where t.scheme_id = p_scheme_id
    and t.service_id = p_service_id
    and t.effective_from <= p_on
  order by t.effective_from desc
  limit 1;
$$;
revoke execute on function scheme_tariff(uuid, uuid, date) from public, anon;
grant execute on function scheme_tariff(uuid, uuid, date) to authenticated;

-- ── Set one ───────────────────────────────────────────────────────────────
create or replace function set_scheme_tariff(
  p_scheme_id uuid,
  p_service_id uuid,
  p_bucket text,
  p_price_cents integer,
  p_effective_from date default null,
  p_note text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_svc service_catalog;
  v_from date := coalesce(p_effective_from, (now() at time zone 'Africa/Nairobi')::date);
  v_month date;
  v_issued integer;
  v_id uuid;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'only an administrator can set a scheme price';
  end if;
  if p_bucket is null or p_bucket not in ('CONSULTATION','LAB','SURGICAL','PHARMACY') then
    raise exception 'a scheme price must say which column it bills under: CONSULTATION, LAB, SURGICAL or PHARMACY';
  end if;
  if coalesce(p_price_cents, -1) < 0 then
    raise exception 'a price cannot be negative';
  end if;

  select s.site_id into v_site_id from schemes s where s.id = p_scheme_id;
  if v_site_id is null then
    raise exception 'unknown scheme';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  select * into v_svc from service_catalog s
  where s.id = p_service_id and s.site_id = v_site_id;
  if v_svc.id is null then
    raise exception 'unknown service for this site';
  end if;
  -- A service the catalogue marks non-billable is statutory, programme-funded
  -- or priced in VITCARE-POS. Pricing one to a farm would either charge for
  -- care that must be free or double-bill what the till already collects.
  if not v_svc.billable then
    raise exception '% is not billable — %',
      v_svc.code,
      coalesce(v_svc.billing_notes, 'it is statutory, programme-funded or priced in the POS');
  end if;

  v_month := date_trunc('month', v_from)::date;
  select count(*) into v_issued
  from scheme_statements st
  where st.scheme_id = p_scheme_id and st.status = 'ISSUED' and st.period >= v_month;
  if v_issued > 0 then
    raise exception
      'a statement has already been issued for % or later — a price cannot start in a statemented month',
      to_char(v_month, 'Mon YYYY');
  end if;

  insert into scheme_tariffs (scheme_id, service_id, bucket, price_cents, effective_from, note, set_by)
  values (p_scheme_id, p_service_id, p_bucket, p_price_cents, v_from,
          nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  on conflict (scheme_id, service_id, effective_from) do update
    set bucket = excluded.bucket,
        price_cents = excluded.price_cents,
        note = excluded.note,
        set_by = excluded.set_by,
        created_at = now()
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function set_scheme_tariff(uuid, uuid, text, integer, date, text) from public, anon;
grant execute on function set_scheme_tariff(uuid, uuid, text, integer, date, text) to authenticated;

-- ── Remove one ────────────────────────────────────────────────────────────
-- The correction for a mistyped row. Withdrawing a service from a contract
-- going forward is a new row at a new date, not a delete — deleting would
-- rewrite what past visits were billed at.
create or replace function remove_scheme_tariff(p_tariff_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_scheme_id uuid;
  v_site_id uuid;
  v_from date;
  v_issued integer;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'only an administrator can remove a scheme price';
  end if;

  select t.scheme_id, s.site_id, t.effective_from
    into v_scheme_id, v_site_id, v_from
  from scheme_tariffs t join schemes s on s.id = t.scheme_id
  where t.id = p_tariff_id;
  if v_scheme_id is null then
    raise exception 'unknown scheme price';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  select count(*) into v_issued
  from scheme_statements st
  where st.scheme_id = v_scheme_id and st.status = 'ISSUED'
    and st.period >= date_trunc('month', v_from)::date;
  if v_issued > 0 then
    raise exception
      'a statement has already been issued for % or later — that price is part of a document that has gone out',
      to_char(date_trunc('month', v_from)::date, 'Mon YYYY');
  end if;

  delete from scheme_tariffs where id = p_tariff_id;
end;
$$;
revoke execute on function remove_scheme_tariff(uuid) from public, anon;
grant execute on function remove_scheme_tariff(uuid) to authenticated;

-- ── The contract price list ───────────────────────────────────────────────
-- One list serving two readers, like list_encounter_services. The
-- administrator setting prices sees every billable service with the farm's
-- price beside it; a null price IS the review list — the services this
-- contract does not yet cover, which 0038 will refuse to bill.
create or replace function list_scheme_tariffs(
  p_scheme_id uuid,
  p_on date default null,
  p_covered_only boolean default false
)
returns table (
  service_id uuid, code text, name text, category text, module text, unit text,
  cash_price_cents integer, insurance_price_cents integer,
  tariff_id uuid, price_cents integer, bucket text,
  effective_from date, note text, set_by_name text
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_on date := coalesce(p_on, (now() at time zone 'Africa/Nairobi')::date);
begin
  -- `null in (subquery)` is NULL, and PL/pgSQL's IF treats NULL as false, so a
  -- negated site guard would fall straight through on a null argument and
  -- return an empty list — which on a pricing screen reads as "this farm has
  -- no prices" rather than as a refusal. Same fix as 0032's.
  if p_scheme_id is null then
    raise exception 'a scheme is required';
  end if;

  select s.site_id into v_site_id from schemes s where s.id = p_scheme_id;
  if v_site_id is null then
    raise exception 'unknown scheme';
  end if;
  if not (
    has_role(auth.uid(), 'AUDITOR')
    or v_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized for this site';
  end if;

  return query
    select sc.id, sc.code, sc.name, sc.category, sc.module, sc.unit,
           sc.cash_price_cents, sc.insurance_price_cents,
           t.id, t.price_cents, t.bucket,
           t.effective_from, t.note, u.full_name
    from service_catalog sc
    left join lateral (
      select tt.* from scheme_tariffs tt
      where tt.scheme_id = p_scheme_id
        and tt.service_id = sc.id
        and tt.effective_from <= v_on
      order by tt.effective_from desc
      limit 1
    ) t on true
    left join users u on u.id = t.set_by
    where sc.site_id = v_site_id
      and sc.billable
      and sc.active
      and (not p_covered_only or t.id is not null)
    order by sc.category, sc.code;
end;
$$;
revoke execute on function list_scheme_tariffs(uuid, date, boolean) from public, anon;
grant execute on function list_scheme_tariffs(uuid, date, boolean) to authenticated;

-- ── One charge per visit ──────────────────────────────────────────────────
-- scheme_charges.encounter_id has been nullable and unconstrained since 0030,
-- which was harmless while the desk was the only thing posting. It stops being
-- harmless the moment a clinician can post too: the same visit would go on the
-- farm's statement twice, once from each screen.
--
-- This index has to land BEFORE the two paths meet, not after — afterwards it
-- is a data-cleaning exercise on a customer's bill. VOID charges are excluded
-- so a mistake can be voided and the visit re-posted.
create unique index if not exists scheme_charges_one_per_encounter
  on scheme_charges (encounter_id)
  where encounter_id is not null and status <> 'VOID';

-- ── Starting a visit for someone already on the register ──────────────────
-- The clinical spine could only begin a visit two ways: register_patient(),
-- which always INSERTs a new patient, and arrive_appointment(), which needs a
-- booked slot against a named clinician. Neither fits a returning patient
-- walking in — and every one of the 1,191 corporate members is, by definition,
-- already registered. Using register_patient() on one would create a duplicate
-- record under a new MRN, unlinked from scheme_members, and that visit could
-- never be billed to the farm.
--
-- Idempotent for the same reason arrive_appointment() is: "patient is here" is
-- a button a busy desk presses twice, and the second press must not split the
-- visit in half.
create or replace function start_encounter(
  p_patient_id uuid,
  p_chief_complaint text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
  v_encounter_id uuid;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'NURSE')
          or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to start a visit';
  end if;

  select p.site_id into v_site_id from patients p where p.id = p_patient_id;
  if v_site_id is null then
    raise exception 'unknown patient';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  -- Clinic-local day, not UTC: at 01:00 in Nairobi a UTC date is still
  -- yesterday, and the desk would open a second visit for a patient who is
  -- standing in front of them from the one they opened an hour ago.
  select e.id into v_encounter_id
  from encounters e
  where e.patient_id = p_patient_id
    and e.site_id = v_site_id
    and e.status in ('TRIAGE', 'IN_CONSULT')
    and (e.created_at at time zone 'Africa/Nairobi')::date = v_today
  order by e.created_at desc
  limit 1;

  if v_encounter_id is not null then
    -- A complaint typed on the second press is a correction, not noise —
    -- but only when there is something to correct with. Same reasoning as
    -- open_invoice_for_encounter's payer.
    if nullif(btrim(coalesce(p_chief_complaint, '')), '') is not null then
      update encounters
      set chief_complaint = btrim(p_chief_complaint), updated_at = now()
      where id = v_encounter_id;
    end if;
    return v_encounter_id;
  end if;

  insert into encounters (patient_id, site_id, status, chief_complaint, created_by)
  values (p_patient_id, v_site_id, 'TRIAGE',
          nullif(btrim(coalesce(p_chief_complaint, '')), ''), auth.uid())
  returning id into v_encounter_id;

  return v_encounter_id;
end;
$$;
revoke execute on function start_encounter(uuid, text) from public, anon;
grant execute on function start_encounter(uuid, text) to authenticated;
