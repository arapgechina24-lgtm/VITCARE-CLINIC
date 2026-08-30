-- VITCARE-CLINIC — posting a visit must not erase what the pharmacy dispensed
-- ---------------------------------------------------------------------------
-- Split from 0040 because the plpgsql validator gives up on large inputs and
-- the same bodies pass in smaller files — the reason 0021_billing_rpcs.sql
-- gives in its own header. Applies immediately after 0040 and depends on the
-- scheme_dispensings table it creates.

-- ── Posting a visit must not erase what the pharmacy dispensed ─────────────
-- THE DEFECT THIS CLOSES, which 0038 could not have had and this file creates:
-- post_scheme_charge_from_encounter recomputes an existing OPEN charge in
-- place, and it derives every bucket from encounter_services. Medicines are
-- not an encounter service — they arrive from the till — so the moment a
-- clinician pressed "post" a second time to add a forgotten dressing, the
-- recompute would set pharmacy_cents back to 0 and the farm would stop being
-- billed for medicines it had already received.
--
-- Silent, too: the charge total would simply be lower, and the only person who
-- could notice is the one reading a statement that never mentioned the drugs.
-- Exactly the shape of the KES 130,000 hole, re-created by the feature meant
-- to close it.
--
-- The fix is to derive the pharmacy bucket from the same rows
-- sync_scheme_charge_pharmacy derives it from, so both paths compute one
-- answer from one source. A PHARMACY-bucket tariff on a genuinely billable
-- service still contributes, which is why they are summed rather than
-- substituted — a facility that later prices a pharmacy SERVICE (a dispensing
-- fee, say) gets both, not whichever ran last.
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
  v_disp_cents integer := 0;
  v_disp_desc text;
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

  for r in
    select sc.code, sc.name, sc.billable, es.quantity,
           t.price_cents, t.bucket
    from encounter_services es
    join service_catalog sc on sc.id = es.service_id
    left join lateral scheme_tariff(v_scheme, es.service_id, v_date) t on true
    where es.encounter_id = p_encounter_id
    order by sc.code
  loop
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

  -- What the till has already handed over against this visit. Read from the
  -- same rows sync_scheme_charge_pharmacy reads, so the two paths cannot
  -- disagree about the farm's pharmacy column depending on which ran last.
  select coalesce(sum(d.amount_cents), 0),
         string_agg('Medicines dispensed (' || d.invoice_no || ')', '; ' order by d.dispensed_at)
    into v_disp_cents, v_disp_desc
  from scheme_dispensings d
  where d.encounter_id = p_encounter_id;

  v_pharm := v_pharm + coalesce(v_disp_cents, 0);
  v_pharmd := concat_ws('; ', v_pharmd, v_disp_desc);

  if v_cons = 0 then
    v_cons := greatest(coalesce(v_fee, 0), 0);
  end if;

  if v_lab = 0 then v_labd := null; end if;
  if v_surg = 0 then v_surgd := null; end if;
  if v_pharm = 0 then v_pharmd := null; end if;

  v_total := v_cons + v_lab + v_surg + v_pharm;
  if v_total <= 0 then
    raise exception
      'nothing on this visit is chargeable to the scheme — record a service the contract prices, or bill the patient';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_scheme::text || v_period::text));

  v_cap := scheme_cap_cents(v_scheme, v_period);
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

  -- Claim the dispensings this charge now carries, so an unbilled one stays
  -- findable and a billed one can be traced to the bill it reached.
  update scheme_dispensings
  set charge_id = v_id, updated_at = now()
  where encounter_id = p_encounter_id and charge_id is distinct from v_id;

  return query select v_id, v_total, v_over, v_cap, v_spent + v_total,
                      case when v_cap is null then null else v_cap - (v_spent + v_total) end,
                      v_priced, v_skipped;
end;
$$;
revoke execute on function post_scheme_charge_from_encounter(uuid) from public, anon;
grant execute on function post_scheme_charge_from_encounter(uuid) to authenticated;
