-- VITCARE-CLINIC — posting a scheme visit, and knowing how far the month has gone
-- ---------------------------------------------------------------------------
-- The four columns the farms keep — CONS, LAB, SURGICAL, PHARMACY — are posted
-- in one call, because that is one visit and one row on their sheet. The
-- consultation fee comes from the contract on the scheme; the other three are
-- priced by hand, which is what the facility asked for and what a negotiated
-- drug list actually is.

-- ── Post a visit ──────────────────────────────────────────────────────────
create or replace function post_scheme_charge(
  p_member_id uuid,
  p_service_date date default null,
  p_lab_description text default null,
  p_lab_cents integer default 0,
  p_surgical_description text default null,
  p_surgical_cents integer default 0,
  p_pharmacy_description text default null,
  p_pharmacy_cents integer default 0,
  p_encounter_id uuid default null,
  p_consultation_cents integer default null   -- null = the contract fee
)
returns table (
  charge_id uuid, total_cents integer, over_limit boolean,
  cap_cents integer, spent_cents integer, remaining_cents integer
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_scheme uuid;
  v_site_id uuid;
  v_patient uuid;
  v_active boolean;
  v_fee integer;
  v_covered_from date;
  v_covered_to date;
  v_name text;
  v_date date := coalesce(p_service_date, (now() at time zone 'Africa/Nairobi')::date);
  v_period date;
  v_cons integer;
  v_lab integer := greatest(coalesce(p_lab_cents, 0), 0);
  v_surg integer := greatest(coalesce(p_surgical_cents, 0), 0);
  v_pharm integer := greatest(coalesce(p_pharmacy_cents, 0), 0);
  v_labd text := nullif(btrim(coalesce(p_lab_description, '')), '');
  v_surgd text := nullif(btrim(coalesce(p_surgical_description, '')), '');
  v_pharmd text := nullif(btrim(coalesce(p_pharmacy_description, '')), '');
  v_total integer;
  v_cap integer;
  v_spent integer;
  v_over boolean;
  v_id uuid;
  v_statemented integer;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'CLINICIAN')
          or has_role(auth.uid(), 'NURSE') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to post scheme charges';
  end if;

  select m.scheme_id, s.site_id, m.patient_id, s.active, s.consultation_fee_cents,
         m.covered_from, m.covered_to, m.full_name
    into v_scheme, v_site_id, v_patient, v_active, v_fee,
         v_covered_from, v_covered_to, v_name
  from scheme_members m join schemes s on s.id = m.scheme_id
  where m.id = p_member_id;
  if v_scheme is null then
    raise exception 'unknown scheme member';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if not v_active then
    raise exception 'that scheme is not active';
  end if;

  -- A visit cannot be dated into the future, and cannot be dated into a month
  -- whose statement has gone out. Both would put a charge somewhere no
  -- statement will ever collect it.
  if v_date > (now() at time zone 'Africa/Nairobi')::date then
    raise exception 'a visit cannot be dated in the future';
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

  -- Cover is checked against the DAY OF THE VISIT, not today. Back-entering
  -- last Tuesday's visit for someone who left on Friday must still bill.
  if v_covered_from > v_date or (v_covered_to is not null and v_covered_to < v_date) then
    raise exception '% was not covered on % — cover ran from %',
      v_name,
      to_char(v_date, 'DD Mon YYYY'),
      to_char(v_covered_from, 'DD Mon YYYY')
        || coalesce(' to ' || to_char(v_covered_to, 'DD Mon YYYY'), ' onwards');
  end if;

  v_cons := greatest(coalesce(p_consultation_cents, v_fee), 0);

  -- The refusal that closes the August gap: work recorded without a price, or
  -- a price with nothing to explain it. The table enforces this too; it is
  -- caught here so the desk gets a sentence naming the column.
  if (v_labd is null) <> (v_lab = 0) then
    raise exception 'lab: record both what was done and what it costs, or neither';
  end if;
  if (v_surgd is null) <> (v_surg = 0) then
    raise exception 'surgical: record both what was done and what it costs, or neither';
  end if;
  if (v_pharmd is null) <> (v_pharm = 0) then
    raise exception 'pharmacy: record both what was dispensed and what it costs, or neither';
  end if;

  v_total := v_cons + v_lab + v_surg + v_pharm;
  if v_total <= 0 then
    raise exception 'nothing to charge — record the consultation, lab, surgical or pharmacy';
  end if;

  if p_encounter_id is not null then
    if not exists (
      select 1 from encounters e
      where e.id = p_encounter_id and e.patient_id = v_patient and e.site_id = v_site_id
    ) then
      raise exception 'that visit does not belong to this patient';
    end if;
  end if;

  -- Two desks posting into the same farm-month could otherwise both read the
  -- running total below the cap and both come back "within limit", and the
  -- second one would be wrong. The lock is per scheme-month, so posting for
  -- one farm never waits on the other.
  perform pg_advisory_xact_lock(hashtext(v_scheme::text || v_period::text));

  v_cap := scheme_cap_cents(v_scheme, v_period);
  v_spent := scheme_spent_cents(v_scheme, v_period);
  -- Null cap means finance has not agreed a ceiling yet. Nothing is flagged;
  -- treating "no cap" as zero would flag every visit and train the desk to
  -- ignore the warning.
  v_over := v_cap is not null and (v_spent + v_total) > v_cap;

  insert into scheme_charges (
    scheme_id, member_id, patient_id, site_id, encounter_id,
    service_date, period,
    consultation_cents, lab_description, lab_cents,
    surgical_description, surgical_cents,
    pharmacy_description, pharmacy_cents,
    over_limit, cap_at_post_cents, spent_before_cents, created_by
  )
  values (
    v_scheme, p_member_id, v_patient, v_site_id, p_encounter_id,
    v_date, v_period,
    v_cons, v_labd, v_lab, v_surgd, v_surg, v_pharmd, v_pharm,
    v_over, v_cap, v_spent, auth.uid()
  )
  returning id into v_id;

  return query select
    v_id, v_total, v_over, v_cap, v_spent + v_total,
    case when v_cap is null then null else v_cap - (v_spent + v_total) end;
end;
$$;
revoke execute on function post_scheme_charge(uuid, date, text, integer, text, integer, text, integer, uuid, integer) from public, anon;
grant execute on function post_scheme_charge(uuid, date, text, integer, text, integer, text, integer, uuid, integer) to authenticated;

-- ── Void a visit ──────────────────────────────────────────────────────────
-- Not a delete. A posted charge is a financial record; correcting one leaves
-- the original visible with a reason attached, the same way a payment is
-- corrected by a compensating entry rather than an edit.
create or replace function void_scheme_charge(p_charge_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to void a scheme charge';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'voiding a charge needs a reason';
  end if;

  select c.site_id, c.status into v_site_id, v_status
  from scheme_charges c where c.id = p_charge_id;
  if v_site_id is null then
    raise exception 'unknown charge';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status = 'VOID' then
    raise exception 'that charge is already void';
  end if;
  if v_status = 'STATEMENTED' then
    raise exception 'that charge is on an issued statement — void the statement first';
  end if;

  update scheme_charges
  set status = 'VOID', void_reason = btrim(p_reason), updated_at = now()
  where id = p_charge_id;
end;
$$;
revoke execute on function void_scheme_charge(uuid, text) from public, anon;
grant execute on function void_scheme_charge(uuid, text) to authenticated;

-- ── The tracker ───────────────────────────────────────────────────────────
-- "How far have we gone" — for one farm, one month, split into the same four
-- columns the farm's own sheet uses so the two reconcile line for line.
create or replace function scheme_utilisation(p_site_id uuid, p_period date default null)
returns table (
  scheme_id uuid, code text, name text, period date,
  visits integer, members integer,
  consultation_cents integer, lab_cents integer,
  surgical_cents integer, pharmacy_cents integer,
  spent_cents integer, cap_cents integer, remaining_cents integer,
  used_pct numeric, over_limit_cents integer, over_limit_visits integer,
  statement_status text, statement_no text
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_period date := date_trunc('month',
    coalesce(p_period, (now() at time zone 'Africa/Nairobi')::date))::date;
begin
  -- The null check is not defensive noise. `null in (subquery)` evaluates to
  -- NULL, not false, and PL/pgSQL's IF treats NULL as false — so `not (... or
  -- null)` falls straight through and the guard passes. A caller who omitted
  -- the site id would then get an empty result rather than a refusal, which on
  -- a statement screen reads as "this farm has no activity" instead of "you
  -- asked the wrong question".
  if p_site_id is null then
    raise exception 'a site is required';
  end if;
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select
      s.id, s.code, s.name, v_period,
      coalesce(t.visits, 0), coalesce(t.members, 0),
      coalesce(t.cons, 0), coalesce(t.lab, 0), coalesce(t.surg, 0), coalesce(t.pharm, 0),
      coalesce(t.spent, 0),
      cap.cap,
      case when cap.cap is null then null else cap.cap - coalesce(t.spent, 0) end,
      case when cap.cap is null or cap.cap = 0 then null
           else round(100.0 * coalesce(t.spent, 0) / cap.cap, 1) end,
      coalesce(t.over_cents, 0), coalesce(t.over_visits, 0),
      st.status, st.statement_no
    from schemes s
    cross join lateral (select scheme_cap_cents(s.id, v_period) as cap) cap
    left join lateral (
      select
        count(*)::integer as visits,
        count(distinct c.member_id)::integer as members,
        sum(c.consultation_cents)::integer as cons,
        sum(c.lab_cents)::integer as lab,
        sum(c.surgical_cents)::integer as surg,
        sum(c.pharmacy_cents)::integer as pharm,
        sum(c.total_cents)::integer as spent,
        sum(c.total_cents) filter (where c.over_limit)::integer as over_cents,
        count(*) filter (where c.over_limit)::integer as over_visits
      from scheme_charges c
      where c.scheme_id = s.id and c.period = v_period and c.status <> 'VOID'
    ) t on true
    left join lateral (
      select st2.status, st2.statement_no from scheme_statements st2
      where st2.scheme_id = s.id and st2.period = v_period and st2.status <> 'VOID'
      limit 1
    ) st on true
    where s.site_id = p_site_id
    order by s.active desc, s.code;
end;
$$;
revoke execute on function scheme_utilisation(uuid, date) from public, anon;
grant execute on function scheme_utilisation(uuid, date) to authenticated;

-- ── The charge register ───────────────────────────────────────────────────
-- Any date range, so the same call serves the live screen, the weekly PDF and
-- the monthly workbook. Returns the farms' column order exactly.
-- Dropped rather than replaced: the return type gains child_ref, and
-- CREATE OR REPLACE cannot change one.
drop function if exists list_scheme_charges(uuid, date, date, boolean);
create or replace function list_scheme_charges(
  p_scheme_id uuid,
  p_from date,
  p_to date,
  p_include_void boolean default false
)
returns table (
  charge_id uuid, service_date date, full_name text, employee_no text,
  member_no text, relation text, child_ref text, mrn text,
  consultation_cents integer,
  lab_description text, lab_cents integer,
  surgical_description text, surgical_cents integer,
  pharmacy_description text, pharmacy_cents integer,
  total_cents integer, over_limit boolean, status text, void_reason text,
  posted_by text, posted_at timestamptz
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
begin
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
  if p_from is null or p_to is null then
    raise exception 'a date range is required';
  end if;
  if p_to < p_from then
    raise exception 'the end of the range is before its start';
  end if;

  return query
    select
      c.id, c.service_date, m.full_name, m.employee_no, m.member_no, m.relation, m.child_ref, p.mrn,
      c.consultation_cents,
      c.lab_description, c.lab_cents,
      c.surgical_description, c.surgical_cents,
      c.pharmacy_description, c.pharmacy_cents,
      c.total_cents, c.over_limit, c.status, c.void_reason,
      u.full_name, c.created_at
    from scheme_charges c
    join scheme_members m on m.id = c.member_id
    join patients p on p.id = c.patient_id
    left join users u on u.id = c.created_by
    where c.scheme_id = p_scheme_id
      and c.service_date between p_from and p_to
      and (p_include_void or c.status <> 'VOID')
    -- The farms' sheets are day-blocked and read in the order the day
    -- happened; the export has to come out the same way to reconcile.
    order by c.service_date, c.created_at;
end;
$$;
revoke execute on function list_scheme_charges(uuid, date, date, boolean) from public, anon;
grant execute on function list_scheme_charges(uuid, date, date, boolean) to authenticated;

-- ── The member register ───────────────────────────────────────────────────
create or replace function list_scheme_members(
  p_scheme_id uuid,
  p_query text default null,
  p_include_ended boolean default false
)
returns table (
  member_id uuid, patient_id uuid, employee_no text, member_no text,
  relation text, child_ref text, full_name text, mrn text,
  dob date, sex text, phone text, national_id text,
  employment_type text, employed_on date,
  covered_from date, covered_to date, covered boolean,
  visits_this_month integer, spend_this_month_cents integer
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
  v_period date := date_trunc('month', (now() at time zone 'Africa/Nairobi')::date)::date;
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
begin
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
    select
      m.id, m.patient_id, m.employee_no, m.member_no,
      m.relation, m.child_ref, m.full_name, p.mrn,
      p.dob, p.sex, p.phone, p.national_id,
      m.employment_type, m.employed_on,
      m.covered_from, m.covered_to,
      (m.covered_from <= v_today and (m.covered_to is null or m.covered_to >= v_today)),
      coalesce(t.visits, 0), coalesce(t.spend, 0)
    from scheme_members m
    join patients p on p.id = m.patient_id
    left join lateral (
      select count(*)::integer as visits, sum(c.total_cents)::integer as spend
      from scheme_charges c
      where c.member_id = m.id and c.period = v_period and c.status <> 'VOID'
    ) t on true
    where m.scheme_id = p_scheme_id
      and (p_include_ended or m.covered_to is null or m.covered_to >= v_today)
      and (
        v_q is null
        or m.employee_no ilike '%' || v_q || '%'
        or coalesce(m.member_no, '') ilike '%' || v_q || '%'
        or m.full_name ilike '%' || v_q || '%'
        or p.mrn ilike '%' || v_q || '%'
      )
    -- Households stay together, employee first, then spouse, then children in
    -- their A/B/C/D order — the shape the farms' own registers are read in.
    order by m.employee_no, (m.relation <> 'SELF'), (m.relation = 'CHILD'),
             m.child_ref nulls first, m.full_name;
end;
$$;
revoke execute on function list_scheme_members(uuid, text, boolean) from public, anon;
grant execute on function list_scheme_members(uuid, text, boolean) to authenticated;

-- ── Scheme list, for the pickers ──────────────────────────────────────────
create or replace function list_schemes(p_site_id uuid, p_include_inactive boolean default false)
returns table (
  id uuid, code text, name text, consultation_fee_cents integer,
  contact_name text, contact_email text, contact_phone text, active boolean,
  members integer, cap_cents integer
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
begin
  -- The null check is not defensive noise. `null in (subquery)` evaluates to
  -- NULL, not false, and PL/pgSQL's IF treats NULL as false — so `not (... or
  -- null)` falls straight through and the guard passes. A caller who omitted
  -- the site id would then get an empty result rather than a refusal, which on
  -- a statement screen reads as "this farm has no activity" instead of "you
  -- asked the wrong question".
  if p_site_id is null then
    raise exception 'a site is required';
  end if;
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select s.id, s.code, s.name, s.consultation_fee_cents,
           s.contact_name, s.contact_email, s.contact_phone, s.active,
           (select count(*)::integer from scheme_members m
             where m.scheme_id = s.id and (m.covered_to is null or m.covered_to >= v_today)),
           scheme_cap_cents(s.id, v_today)
    from schemes s
    where s.site_id = p_site_id
      and (p_include_inactive or s.active)
    order by s.active desc, s.code;
end;
$$;
revoke execute on function list_schemes(uuid, boolean) from public, anon;
grant execute on function list_schemes(uuid, boolean) to authenticated;

-- ── Limit history ─────────────────────────────────────────────────────────
create or replace function list_scheme_limits(p_scheme_id uuid)
returns table (
  effective_from date, monthly_cap_cents integer, note text,
  set_by_name text, set_at timestamptz, in_force boolean
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_month date := date_trunc('month', (now() at time zone 'Africa/Nairobi')::date)::date;
begin
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
    select l.effective_from, l.monthly_cap_cents, l.note,
           u.full_name, l.created_at,
           l.effective_from = (
             select max(l2.effective_from) from scheme_limits l2
             where l2.scheme_id = p_scheme_id and l2.effective_from <= v_month
           )
    from scheme_limits l
    left join users u on u.id = l.set_by
    where l.scheme_id = p_scheme_id
    order by l.effective_from desc;
end;
$$;
revoke execute on function list_scheme_limits(uuid) from public, anon;
grant execute on function list_scheme_limits(uuid) to authenticated;
