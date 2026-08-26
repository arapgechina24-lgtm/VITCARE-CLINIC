-- VITCARE-CLINIC — the scheme desk: members, eligibility, charges, the cap
-- ---------------------------------------------------------------------------
-- Every write onto the scheme tables lives here. 0030 grants the client SELECT
-- and nothing else, so these functions are the whole write surface, and each
-- one re-checks role and site rather than trusting that the screen did.

-- ── The cap in force for a period ─────────────────────────────────────────
-- The latest cap whose effective_from is on or before the period. Null when a
-- farm has no cap set yet, which is a legitimate state — a scheme can be
-- registered and start receiving patients before finance agrees a ceiling —
-- and is reported as "no cap set" rather than silently treated as zero. Zero
-- would flag every single visit as over limit.
create or replace function scheme_cap_cents(p_scheme_id uuid, p_period date)
returns integer
language sql stable
set search_path = public
as $$
  select l.monthly_cap_cents
  from scheme_limits l
  where l.scheme_id = p_scheme_id
    and l.effective_from <= date_trunc('month', p_period)::date
  order by l.effective_from desc
  limit 1;
$$;

-- ── What has been spent ───────────────────────────────────────────────────
-- VOID charges are excluded: a voided visit is not spend, and leaving it in
-- would hold a farm against a ceiling it never reached.
create or replace function scheme_spent_cents(p_scheme_id uuid, p_period date)
returns integer
language sql stable
set search_path = public
as $$
  select coalesce(sum(c.total_cents), 0)::integer
  from scheme_charges c
  where c.scheme_id = p_scheme_id
    and c.period = date_trunc('month', p_period)::date
    and c.status <> 'VOID';
$$;

-- ── Register a scheme ─────────────────────────────────────────────────────
-- Both helpers are SECURITY INVOKER: called from inside the definer functions
-- below they run with the owner's privileges, and there is no reason for a
-- client to reach them directly. Closed to anon for the same reason 0027
-- closed the rest of the surface — an anon-callable function is a decision,
-- not a default.
revoke execute on function scheme_cap_cents(uuid, date) from public, anon;
grant execute on function scheme_cap_cents(uuid, date) to authenticated;
revoke execute on function scheme_spent_cents(uuid, date) from public, anon;
grant execute on function scheme_spent_cents(uuid, date) to authenticated;

create or replace function upsert_scheme(
  p_site_id uuid,
  p_code text,
  p_name text,
  p_consultation_fee_cents integer,
  p_contact_name text default null,
  p_contact_email text default null,
  p_contact_phone text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'only an administrator can set up a scheme';
  end if;
  if p_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_code = '' then
    raise exception 'a scheme needs a short code, e.g. SRK';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'a scheme needs a name';
  end if;
  if coalesce(p_consultation_fee_cents, -1) < 0 then
    raise exception 'the consultation fee cannot be negative';
  end if;

  insert into schemes (
    site_id, code, name, consultation_fee_cents,
    contact_name, contact_email, contact_phone, created_by
  )
  values (
    p_site_id, v_code, btrim(p_name), p_consultation_fee_cents,
    nullif(btrim(coalesce(p_contact_name, '')), ''),
    nullif(btrim(coalesce(p_contact_email, '')), ''),
    nullif(btrim(coalesce(p_contact_phone, '')), ''),
    auth.uid()
  )
  on conflict (site_id, code) do update
    set name = excluded.name,
        consultation_fee_cents = excluded.consultation_fee_cents,
        contact_name = excluded.contact_name,
        contact_email = excluded.contact_email,
        contact_phone = excluded.contact_phone,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function upsert_scheme(uuid, text, text, integer, text, text, text) from public, anon;
grant execute on function upsert_scheme(uuid, text, text, integer, text, text, text) to authenticated;

-- ── Set the cap ───────────────────────────────────────────────────────────
-- Writes a dated row rather than editing one, so the ceiling that applied in
-- March keeps applying to March. Re-setting the cap for a month that is
-- already running is allowed and updates that month's row — finance revising
-- a figure mid-month is ordinary — but it cannot reach backwards past a month
-- whose statement has been issued, because that would restate a document the
-- farm has already received.
create or replace function set_scheme_limit(
  p_scheme_id uuid,
  p_effective_from date,
  p_monthly_cap_cents integer,
  p_note text default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_month date := date_trunc('month', coalesce(p_effective_from,
                    (now() at time zone 'Africa/Nairobi')::date))::date;
  v_issued integer;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'only an administrator can change a scheme limit';
  end if;
  if coalesce(p_monthly_cap_cents, -1) < 0 then
    raise exception 'a monthly limit cannot be negative';
  end if;

  select s.site_id into v_site_id from schemes s where s.id = p_scheme_id;
  if v_site_id is null then
    raise exception 'unknown scheme';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  select count(*) into v_issued
  from scheme_statements st
  where st.scheme_id = p_scheme_id and st.status = 'ISSUED' and st.period >= v_month;
  if v_issued > 0 then
    raise exception
      'a statement has already been issued for % or later — the limit for a statemented month cannot be changed',
      to_char(v_month, 'Mon YYYY');
  end if;

  insert into scheme_limits (scheme_id, effective_from, monthly_cap_cents, note, set_by)
  values (p_scheme_id, v_month, p_monthly_cap_cents,
          nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  on conflict (scheme_id, effective_from) do update
    set monthly_cap_cents = excluded.monthly_cap_cents,
        note = excluded.note,
        set_by = excluded.set_by,
        created_at = now();
end;
$$;
revoke execute on function set_scheme_limit(uuid, date, integer, text) from public, anon;
grant execute on function set_scheme_limit(uuid, date, integer, text) to authenticated;

-- ── Enrol a member ────────────────────────────────────────────────────────
-- Creates the patient record if this person has never been seen, and links it.
-- The desk enrols an employee and their dependants from one screen; each gets
-- a real patient record, because a dependant who is treated is a patient and
-- treating them off a spreadsheet row is how the clinical history gets lost.
create or replace function enrol_scheme_member(
  p_scheme_id uuid,
  p_employee_no text,
  p_relation text,
  p_full_name text,
  p_dob date default null,
  p_sex text default null,
  p_phone text default null,
  p_national_id text default null,
  p_member_no text default null,
  p_child_ref text default null,
  p_employment_type text default null,
  p_employed_on date default null,
  p_patient_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_member_id uuid;
  v_patient_id uuid := p_patient_id;
  v_mrn text;
  v_emp text := upper(regexp_replace(coalesce(p_employee_no, ''), '\s+', '', 'g'));
  v_child text := nullif(upper(btrim(coalesce(p_child_ref, ''))), '');
  v_existing uuid;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to enrol scheme members';
  end if;
  if p_relation not in ('SELF','SPOUSE','CHILD') then
    raise exception 'relation must be SELF, SPOUSE or CHILD';
  end if;
  if v_emp = '' then
    raise exception 'a member needs the employee''s payroll number';
  end if;
  if coalesce(btrim(p_full_name), '') = '' then
    raise exception 'a member needs a full name';
  end if;
  if p_relation <> 'CHILD' and v_child is not null then
    raise exception 'only a child is given an A/B/C/D reference';
  end if;

  select s.site_id into v_site_id from schemes s
  where s.id = p_scheme_id and s.active;
  if v_site_id is null then
    raise exception 'unknown or inactive scheme';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  -- One employee per payroll number. Caught here as well as by the partial
  -- unique index so the desk gets a sentence instead of a constraint name.
  if p_relation = 'SELF' then
    select m.id into v_existing from scheme_members m
    where m.scheme_id = p_scheme_id and m.employee_no = v_emp and m.relation = 'SELF';
    if v_existing is not null then
      raise exception 'payroll number % is already enrolled — add the family to it as dependants', v_emp;
    end if;
  else
    -- A dependant hangs off an employee. Enrolling one without the employee
    -- would produce a household nobody can bill or trace.
    if not exists (
      select 1 from scheme_members m
      where m.scheme_id = p_scheme_id and m.employee_no = v_emp and m.relation = 'SELF'
    ) then
      raise exception 'no employee is enrolled under payroll number % yet — enrol the employee first', v_emp;
    end if;
  end if;

  if v_patient_id is null then
    v_mrn := 'VC-' || to_char(now() at time zone 'Africa/Nairobi', 'YYYYMMDD')
             || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    insert into patients (mrn, full_name, dob, sex, phone, national_id, site_id, created_by)
    values (v_mrn, btrim(p_full_name), p_dob,
            case when p_sex in ('M','F','OTHER') then p_sex end,
            nullif(btrim(coalesce(p_phone, '')), ''),
            nullif(btrim(coalesce(p_national_id, '')), ''),
            v_site_id, auth.uid())
    returning id into v_patient_id;
  else
    if not exists (select 1 from patients p where p.id = v_patient_id and p.site_id = v_site_id) then
      raise exception 'unknown patient for this site';
    end if;
  end if;

  insert into scheme_members (
    scheme_id, employee_no, member_no, relation, child_ref, patient_id, full_name,
    employment_type, employed_on, note, created_by
  )
  values (
    p_scheme_id, v_emp,
    nullif(btrim(coalesce(p_member_no, '')), ''),
    p_relation, v_child, v_patient_id, btrim(p_full_name),
    case when p_employment_type in ('PERMANENT','CONTRACT','SEASONAL') then p_employment_type end,
    p_employed_on,
    nullif(btrim(coalesce(p_note, '')), ''),
    auth.uid()
  )
  returning id into v_member_id;

  return v_member_id;
end;
$$;
revoke execute on function enrol_scheme_member(uuid, text, text, text, date, text, text, text, text, text, text, date, uuid, text) from public, anon;
grant execute on function enrol_scheme_member(uuid, text, text, text, date, text, text, text, text, text, text, date, uuid, text) to authenticated;

-- ── End a membership ──────────────────────────────────────────────────────
-- A leaver is dated out, never deleted: last month's statement has to keep
-- explaining why last month's visit was covered. Ending an employee's own
-- membership ends the household's, because the family's entitlement was the
-- employee's in the first place.
create or replace function end_scheme_membership(
  p_member_id uuid,
  p_covered_to date default null,
  p_note text default null
)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_scheme uuid;
  v_emp text;
  v_relation text;
  v_from date;
  v_to date := coalesce(p_covered_to, (now() at time zone 'Africa/Nairobi')::date);
  v_n integer;
begin
  if not (has_role(auth.uid(), 'RECEPTIONIST') or has_role(auth.uid(), 'ADMIN')) then
    raise exception 'not authorized to change scheme membership';
  end if;

  select s.site_id, m.scheme_id, m.employee_no, m.relation, m.covered_from
    into v_site_id, v_scheme, v_emp, v_relation, v_from
  from scheme_members m join schemes s on s.id = m.scheme_id
  where m.id = p_member_id;
  if v_site_id is null then
    raise exception 'unknown member';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_to < v_from then
    raise exception 'a membership cannot end before it started (%)', to_char(v_from, 'DD Mon YYYY');
  end if;

  if v_relation = 'SELF' then
    update scheme_members m
    set covered_to = v_to,
        note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), m.note),
        updated_at = now()
    where m.scheme_id = v_scheme and m.employee_no = v_emp
      and m.covered_to is null and m.covered_from <= v_to;
    get diagnostics v_n = row_count;
  else
    update scheme_members m
    set covered_to = v_to,
        note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), m.note),
        updated_at = now()
    where m.id = p_member_id;
    get diagnostics v_n = row_count;
  end if;

  return v_n;
end;
$$;
revoke execute on function end_scheme_membership(uuid, date, text) from public, anon;
grant execute on function end_scheme_membership(uuid, date, text) to authenticated;

-- ── Eligibility, at the point of care ─────────────────────────────────────
-- What the desk needs before it treats: is this person covered, whose account
-- do they draw on, and how much of the farm's month is left. Returns rows
-- rather than raising, because "not covered" is an answer the desk has to
-- read, not an error it has to interpret.
create or replace function lookup_scheme_member(
  p_scheme_id uuid,
  p_query text
)
returns table (
  member_id uuid, patient_id uuid, employee_no text, member_no text,
  relation text, child_ref text, full_name text, mrn text,
  dob date, sex text, employment_type text,
  covered_from date, covered_to date, covered boolean,
  employee_name text, household_size integer,
  month_spend_cents integer
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
  v_period date := date_trunc('month', (now() at time zone 'Africa/Nairobi')::date)::date;
  v_q text := btrim(coalesce(p_query, ''));
  v_emp text := upper(regexp_replace(coalesce(p_query, ''), '\s+', '', 'g'));
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
      p.dob, p.sex, m.employment_type,
      m.covered_from, m.covered_to,
      (m.covered_from <= v_today and (m.covered_to is null or m.covered_to >= v_today)),
      emp.full_name,
      (select count(*)::integer from scheme_members h
        where h.scheme_id = m.scheme_id and h.employee_no = m.employee_no),
      -- The household's spend this month. Informational: the cap the facility
      -- agreed is the company's, so this never blocks. It is here because the
      -- desk asked to see repeat attenders, and SRK 646 made 11 visits in
      -- August.
      (select coalesce(sum(c.total_cents), 0)::integer
         from scheme_charges c join scheme_members hm on hm.id = c.member_id
        where c.scheme_id = m.scheme_id and hm.employee_no = m.employee_no
          and c.period = v_period and c.status <> 'VOID')
    from scheme_members m
    join patients p on p.id = m.patient_id
    left join scheme_members emp
      on emp.scheme_id = m.scheme_id and emp.employee_no = m.employee_no and emp.relation = 'SELF'
    where m.scheme_id = p_scheme_id
      and (
        v_q = ''
        or m.employee_no = v_emp
        or upper(coalesce(m.member_no, '')) = v_emp
        or m.full_name ilike '%' || v_q || '%'
        or p.mrn ilike '%' || v_q || '%'
      )
    order by m.employee_no, (m.relation <> 'SELF'), m.child_ref nulls first, m.full_name
    limit 200;
end;
$$;
revoke execute on function lookup_scheme_member(uuid, text) from public, anon;
grant execute on function lookup_scheme_member(uuid, text) to authenticated;
