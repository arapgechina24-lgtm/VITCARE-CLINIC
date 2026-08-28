-- VITCARE-CLINIC — the clinician finishes the visit and the farm's bill follows
-- ---------------------------------------------------------------------------
-- 0026 established the principle this completes: recording what was done is a
-- CLINICAL act, pricing it is a FINANCIAL one, and the second derives from the
-- first so nobody retypes anything. Invoices already work that way —
-- pull_encounter_services_to_invoice reads encounter_services and prices each
-- line at the invoice's payer. Corporate visits did not, because 0030 shipped
-- the desk a form that was, honestly, the farm's spreadsheet on a screen: four
-- boxes typed by hand, by whoever had the paper.
--
-- post_scheme_charge_from_encounter is the missing half. The clinician records
-- services exactly as they already do; this turns that list into the four
-- columns the farms reconcile against, priced from the contract.
--
-- ── WHAT IT REFUSES, AND WHY THAT IS THE POINT ─────────────────────────────
-- A captured billable service with no tariff stops the whole posting and names
-- the service. It does NOT fall back to the catalogue price, and it does not
-- quietly leave the service off. Both alternatives are the August failure in a
-- new costume: the first bills Stokman KES 500 for a consultation their
-- contract prices at 100, the second is the blank pharmacy column that cost
-- the facility roughly KES 130,000 in a single month.
--
-- The fix for a refusal is to agree a price and record it (0036's
-- set_scheme_tariff), which is a two-minute administrative act, not a code
-- change.
--
-- ── WHY THE PHARMACY COLUMN COMES OUT EMPTY, FOR NOW ───────────────────────
-- Medicines are PHA-005 in the catalogue, and PHA-005 is marked NOT BILLABLE
-- with the note "PRICED IN VITCARE-POS - not in this catalogue. Do not
-- double-maintain." Non-billable services are skipped here for the same reason
-- pull_encounter_services_to_invoice skips them, so drugs cannot reach a farm's
-- statement through this path.
--
-- That is deliberate and it is the safe state. The facility has decided that
-- the clinic should eventually price drugs onto the farm's statement and tell
-- the POS "settled by scheme — dispense, don't collect". Until the POS side of
-- that exists, putting drugs on the statement here would leave the till still
-- asking the patient to pay: one dispensing, two bills. So the PHARMACY bucket
-- exists in the tariff table and stays unused by this function until the
-- prescription contract carries the instruction that makes it safe.
--
-- ── ONE VISIT, ONE CHARGE, RE-RUNNABLE ─────────────────────────────────────
-- A clinician will press "post" and then remember the dressing. So a second
-- call recomputes the existing OPEN charge rather than raising or duplicating
-- — the same idempotent-correction shape record_encounter_service already uses.
-- 0036's unique index is what makes that safe rather than merely intended.

create or replace function post_scheme_charge_from_encounter(p_encounter_id uuid)
returns table (
  charge_id uuid, total_cents integer, over_limit boolean,
  cap_cents integer, spent_cents integer, remaining_cents integer,
  priced_count integer, skipped_count integer
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_member uuid;
  v_patient uuid;
  v_date date;
  v_period date;
  v_scheme uuid;
  v_active boolean;
  v_fee integer;
  v_covered_from date;
  v_covered_to date;
  v_name text;
  v_statemented integer;
  v_existing uuid;
  v_existing_status text;
  v_missing text;
  v_cons integer := 0;
  v_lab integer := 0;
  v_surg integer := 0;
  v_pharm integer := 0;
  v_labd text;
  v_surgd text;
  v_pharmd text;
  v_priced integer := 0;
  v_skipped integer := 0;
  v_total integer;
  v_cap integer;
  v_spent integer;
  v_over boolean;
  v_id uuid;
  r record;
begin
  if not (has_role(auth.uid(), 'CLINICIAN') or has_role(auth.uid(), 'NURSE')
          or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'only clinical staff can post a visit to a scheme';
  end if;

  select e.site_id, e.scheme_member_id, e.patient_id,
         (e.created_at at time zone 'Africa/Nairobi')::date
    into v_site_id, v_member, v_patient, v_date
  from encounters e where e.id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_member is null then
    raise exception 'this visit is not on a scheme — it is billed to the patient';
  end if;

  select m.scheme_id, s.active, s.consultation_fee_cents,
         m.covered_from, m.covered_to, m.full_name
    into v_scheme, v_active, v_fee, v_covered_from, v_covered_to, v_name
  from scheme_members m join schemes s on s.id = m.scheme_id
  where m.id = v_member;
  if not v_active then
    raise exception 'that scheme is not active';
  end if;
  -- Cover is checked against the DAY OF THE VISIT, not today, so a visit
  -- posted the morning after still bills. Same rule as post_scheme_charge.
  if v_covered_from > v_date or (v_covered_to is not null and v_covered_to < v_date) then
    raise exception '% was not covered on % — cover ran from %',
      v_name,
      to_char(v_date, 'DD Mon YYYY'),
      to_char(v_covered_from, 'DD Mon YYYY')
        || coalesce(' to ' || to_char(v_covered_to, 'DD Mon YYYY'), ' onwards');
  end if;

  v_period := date_trunc('month', v_date)::date;

  select count(*) into v_statemented
  from scheme_statements st
  where st.scheme_id = v_scheme and st.period = v_period and st.status = 'ISSUED';
  if v_statemented > 0 then
    raise exception
      'the % statement has already been issued — post this visit as a correction to the current month',
      to_char(v_period, 'Mon YYYY');
  end if;

  select c.id, c.status into v_existing, v_existing_status
  from scheme_charges c
  where c.encounter_id = p_encounter_id and c.status <> 'VOID'
  limit 1;
  if v_existing_status = 'STATEMENTED' then
    raise exception 'this visit is already on an issued statement and cannot be repriced';
  end if;

  -- ── Everything billable must have a price ───────────────────────────────
  -- Collected and reported together rather than one at a time: an
  -- administrator who has to set four prices should be told all four now.
  select string_agg(sc.code || ' (' || sc.name || ')', ', ' order by sc.code)
    into v_missing
  from encounter_services es
  join service_catalog sc on sc.id = es.service_id
  left join lateral scheme_tariff(v_scheme, es.service_id, v_date) t on true
  where es.encounter_id = p_encounter_id
    and sc.billable
    and t.price_cents is null;
  if v_missing is not null then
    raise exception
      'this scheme has no agreed price for %. Set one under the scheme''s price list, then post again',
      v_missing;
  end if;

  -- ── Sum the buckets ─────────────────────────────────────────────────────
  -- The catalogue's `active` flag is deliberately NOT consulted. A service is
  -- refused at capture time if it is inactive (0026), so anything here was
  -- available when it was performed; the contract price is what governs
  -- afterwards, not whether the facility still offers the service today.
  for r in
    select sc.code, sc.name, sc.billable, es.quantity,
           t.price_cents, t.bucket
    from encounter_services es
    join service_catalog sc on sc.id = es.service_id
    left join lateral scheme_tariff(v_scheme, es.service_id, v_date) t on true
    where es.encounter_id = p_encounter_id
    order by sc.code
  loop
    -- Statutory, programme-funded and POS-priced services stay recorded and
    -- unbilled. This is what keeps immunisations and HIV testing out of a
    -- farm's invoice while leaving them in the clinical record and in the SHA
    -- capitation count — and what keeps medicines off the statement until the
    -- POS can be told not to collect for them.
    if not r.billable then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_priced := v_priced + 1;
    if r.bucket = 'CONSULTATION' then
      v_cons := v_cons + r.price_cents * r.quantity;
    elsif r.bucket = 'LAB' then
      v_lab := v_lab + r.price_cents * r.quantity;
      v_labd := concat_ws('; ', v_labd, r.name || case when r.quantity > 1 then ' x' || r.quantity else '' end);
    elsif r.bucket = 'SURGICAL' then
      v_surg := v_surg + r.price_cents * r.quantity;
      v_surgd := concat_ws('; ', v_surgd, r.name || case when r.quantity > 1 then ' x' || r.quantity else '' end);
    elsif r.bucket = 'PHARMACY' then
      v_pharm := v_pharm + r.price_cents * r.quantity;
      v_pharmd := concat_ws('; ', v_pharmd, r.name || case when r.quantity > 1 then ' x' || r.quantity else '' end);
    end if;
  end loop;

  -- The contract consultation fee applies to the visit unless the clinician
  -- captured a consultation service the contract prices itself — which is how
  -- an after-hours surcharge or a specialist rate gets on the bill.
  if v_cons = 0 then
    v_cons := greatest(coalesce(v_fee, 0), 0);
  end if;

  -- A bucket that priced to nothing carries no description. The table's
  -- description-implies-a-price CHECK is two-directional, and a contract that
  -- covers something at no charge is a real thing — the farm's column shows
  -- nothing to pay, and the clinical record still holds what was done.
  if v_lab = 0 then v_labd := null; end if;
  if v_surg = 0 then v_surgd := null; end if;
  if v_pharm = 0 then v_pharmd := null; end if;

  v_total := v_cons + v_lab + v_surg + v_pharm;
  if v_total <= 0 then
    raise exception
      'nothing on this visit is chargeable to the scheme — record a service the contract prices, or bill the patient';
  end if;

  -- ── Cap ─────────────────────────────────────────────────────────────────
  -- Serialised per scheme per month so two desks cannot both read a figure
  -- under the cap and both post over it. Same lock as post_scheme_charge, and
  -- deliberately the same key, so the two paths queue behind each other.
  perform pg_advisory_xact_lock(hashtext(v_scheme::text || v_period::text));

  v_cap := scheme_cap_cents(v_scheme, v_period);
  -- This charge's own current total is excluded, so recomputing an existing
  -- charge measures the month without double-counting the visit being repriced.
  select coalesce(sum(c.total_cents), 0)::integer into v_spent
  from scheme_charges c
  where c.scheme_id = v_scheme and c.period = v_period and c.status <> 'VOID'
    and (v_existing is null or c.id <> v_existing);

  v_over := v_cap is not null and (v_spent + v_total) > v_cap;

  if v_existing is not null then
    update scheme_charges
    set member_id = v_member,
        patient_id = v_patient,
        service_date = v_date,
        consultation_cents = v_cons,
        lab_description = v_labd, lab_cents = v_lab,
        surgical_description = v_surgd, surgical_cents = v_surg,
        pharmacy_description = v_pharmd, pharmacy_cents = v_pharm,
        over_limit = v_over,
        cap_at_post_cents = v_cap,
        spent_before_cents = v_spent
    where id = v_existing;
    v_id := v_existing;
  else
    insert into scheme_charges (
      scheme_id, member_id, patient_id, site_id, encounter_id, service_date,
      consultation_cents, lab_description, lab_cents,
      surgical_description, surgical_cents,
      pharmacy_description, pharmacy_cents,
      over_limit, cap_at_post_cents, spent_before_cents, created_by
    )
    values (
      v_scheme, v_member, v_patient, v_site_id, p_encounter_id, v_date,
      v_cons, v_labd, v_lab, v_surgd, v_surg, v_pharmd, v_pharm,
      v_over, v_cap, v_spent, auth.uid()
    )
    returning id into v_id;
  end if;

  return query select v_id, v_total, v_over, v_cap, v_spent + v_total,
                      case when v_cap is null then null else v_cap - (v_spent + v_total) end,
                      v_priced, v_skipped;
end;
$$;
revoke execute on function post_scheme_charge_from_encounter(uuid) from public, anon;
grant execute on function post_scheme_charge_from_encounter(uuid) to authenticated;

-- ── A scheme visit does not also get a patient invoice ────────────────────
-- Without this the trap is quiet and expensive: the desk raises a cash invoice
-- out of habit, the clinician posts the visit to the farm, and the same
-- consultation is charged to the patient at the window and to their employer
-- at the end of the month. Nothing on either document would look wrong.
--
-- Refused rather than steered, because there is no correct invoice to open
-- here: the money is owed by the company on a statement, not by the person in
-- front of the desk. If the visit was attached to a scheme in error, the fix
-- is at the visit, not at the till.
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
  v_scheme_member uuid;
  v_scheme_name text;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to raise invoices';
  end if;
  if p_payer not in ('CASH','SHA','INSURER') then
    raise exception 'unsupported payer %', p_payer;
  end if;

  select e.site_id, e.patient_id, e.scheme_member_id
    into v_site_id, v_patient_id, v_scheme_member
  from encounters e where e.id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  if v_scheme_member is not null then
    select s.name into v_scheme_name
    from scheme_members m join schemes s on s.id = m.scheme_id
    where m.id = v_scheme_member;
    raise exception
      'this visit is on %''s account and is billed on their monthly statement — it cannot also be invoiced to the patient',
      v_scheme_name;
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
revoke execute on function open_invoice_for_encounter(uuid, text, text) from public, anon;
grant execute on function open_invoice_for_encounter(uuid, text, text) to authenticated;
