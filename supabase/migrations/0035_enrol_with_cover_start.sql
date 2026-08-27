-- VITCARE-CLINIC — enrolling somebody who was already covered
-- ---------------------------------------------------------------------------
-- enrol_scheme_member defaulted covered_from to today, which is right for a new
-- hire walking up to the desk and wrong for everybody already on an employer's
-- register. Loading Stokman's and La Pieve's existing members with today's date
-- would assert that 1,192 people became covered on the day of the import, and
-- post_scheme_charge checks cover against the DATE OF THE VISIT — so every
-- August visit still to be entered would be refused for a member the farm has
-- carried since 1997.
--
-- Dropped rather than replaced: adding a defaulted parameter would leave both
-- signatures in place, and a call omitting the new one would then match either.
-- Postgres refuses that at call time, which would take the enrolment screen
-- down.
drop function if exists enrol_scheme_member(uuid, text, text, text, date, text, text, text, text, text, text, date, uuid, text);

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
  p_note text default null,
  -- Null keeps the old behaviour: cover starts today. A date is only accepted
  -- backwards — a membership that starts in the future would be invisible to
  -- the desk today and is more likely a typo than an intention.
  p_covered_from date default null
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
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
  v_from date;
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

  v_from := least(coalesce(p_covered_from, v_today), v_today);

  select s.site_id into v_site_id from schemes s
  where s.id = p_scheme_id and s.active;
  if v_site_id is null then
    raise exception 'unknown or inactive scheme';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  if p_relation = 'SELF' then
    select m.id into v_existing from scheme_members m
    where m.scheme_id = p_scheme_id and m.employee_no = v_emp and m.relation = 'SELF';
    if v_existing is not null then
      raise exception 'payroll number % is already enrolled — add the family to it as dependants', v_emp;
    end if;
  else
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
    employment_type, employed_on, covered_from, note, created_by
  )
  values (
    p_scheme_id, v_emp,
    nullif(btrim(coalesce(p_member_no, '')), ''),
    p_relation, v_child, v_patient_id, btrim(p_full_name),
    case when p_employment_type in ('PERMANENT','CONTRACT','SEASONAL') then p_employment_type end,
    p_employed_on,
    v_from,
    nullif(btrim(coalesce(p_note, '')), ''),
    auth.uid()
  )
  returning id into v_member_id;

  return v_member_id;
end;
$$;
revoke execute on function enrol_scheme_member(uuid, text, text, text, date, text, text, text, text, text, text, date, uuid, text, date) from public, anon;
grant execute on function enrol_scheme_member(uuid, text, text, text, date, text, text, text, text, text, text, date, uuid, text, date) to authenticated;
