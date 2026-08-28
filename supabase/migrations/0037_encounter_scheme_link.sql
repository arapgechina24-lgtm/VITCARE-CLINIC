-- VITCARE-CLINIC — the visit knows which farm is paying
-- ---------------------------------------------------------------------------
-- One nullable column on `encounters`, and the screens that read it. When it is
-- null nothing behaves differently, which is every visit the clinic has ever
-- recorded.
--
-- ── WHY THE LINK LIVES ON THE ENCOUNTER ────────────────────────────────────
-- The alternative was to leave it where 0030 already put it — scheme_charges
-- carries an encounter_id — and let the charge be the only place the two
-- worlds meet. That is enough to BILL a corporate visit and not enough to
-- TREAT one, which is what was actually asked for. The clinician has to see
-- the cover before they decide what to do, the desk has to see it before it
-- raises an invoice, and both of those happen long before a charge exists.
-- A fact needed at the start of the visit belongs on the visit.
--
-- ── PROTECTING ONE COLUMN WITHOUT REWRITING THE TABLE ──────────────────────
-- `encounters` grants UPDATE to `authenticated`, and its RLS update policy is
-- `using (site_id in (select site_id from user_sites(auth.uid())))` with no
-- WITH CHECK. That is survivable for the clinical columns, which is why it has
-- stood since 0000: every real write already goes through a SECURITY DEFINER
-- RPC, and a colleague retyping a chief complaint is not a threat model.
--
-- It is NOT survivable for this column. scheme_member_id decides which company
-- gets invoiced for the visit, so a client able to set it freely could move a
-- visit onto another farm's account, or attach a farm to a visit that was
-- never theirs. Neither would look wrong on any screen.
--
-- Revoking the table-level UPDATE and re-granting per column would fix it and
-- would also change the write surface of the clinical spine, which is audited
-- code outside what this change is for. Postgres will not let a column-level
-- revoke bite while a table-level grant stands, so the narrow fix is a trigger:
-- the two client roles may not change this column, and everything reaching it
-- through a definer function (where current_user is the function's owner) is
-- unaffected. No existing behaviour moves; nothing else about `encounters`
-- changes.
--
-- Verified before writing this: all three client references to `encounters`
-- (triage, consult, prescribe) are .select() reads. Nothing in the application
-- updates the table directly.

alter table encounters
  add column if not exists scheme_member_id uuid references scheme_members(id);

comment on column encounters.scheme_member_id is
  'Set at check-in when the visit is on a corporate scheme''s account. Null for every ordinary visit. Not client-writable — see trg_encounters_protect_scheme_link.';

create index if not exists encounters_scheme_member_idx
  on encounters (scheme_member_id) where scheme_member_id is not null;

create or replace function trg_encounters_guard_scheme_link()
returns trigger
language plpgsql
as $$
begin
  if new.scheme_member_id is distinct from old.scheme_member_id
     and current_user in ('authenticated', 'anon') then
    raise exception
      'the paying scheme is set when the visit is started, not by editing the visit';
  end if;
  return new;
end;
$$;
-- Postgres checks EXECUTE on a trigger function at CREATE TRIGGER time, not
-- when it fires, so closing it here does not stop the trigger below from
-- running for an ordinary signed-in user. Same note as 0030's derive trigger.
revoke execute on function trg_encounters_guard_scheme_link() from public, anon, authenticated;

drop trigger if exists trg_encounters_protect_scheme_link on encounters;
create trigger trg_encounters_protect_scheme_link
  before update on encounters
  for each row execute function trg_encounters_guard_scheme_link();

-- ── Starting a visit, now with the payer attached ─────────────────────────
-- Dropped and recreated rather than given a defaulted third parameter: leaving
-- both would make every existing two-argument call ambiguous and Postgres
-- would refuse it at runtime. Same lesson as 0035.
drop function if exists start_encounter(uuid, text);
create or replace function start_encounter(
  p_patient_id uuid,
  p_chief_complaint text default null,
  p_scheme_member_id uuid default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
  v_encounter_id uuid;
  v_member_patient uuid;
  v_scheme_site uuid;
  v_scheme_active boolean;
  v_scheme_name text;
  v_from date;
  v_to date;
  v_member_name text;
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

  if p_scheme_member_id is not null then
    select m.patient_id, s.site_id, s.active, s.name,
           m.covered_from, m.covered_to, m.full_name
      into v_member_patient, v_scheme_site, v_scheme_active, v_scheme_name,
           v_from, v_to, v_member_name
    from scheme_members m join schemes s on s.id = m.scheme_id
    where m.id = p_scheme_member_id;

    if v_member_patient is null then
      raise exception 'unknown scheme member';
    end if;
    -- The check that stops one person's visit being billed to another
    -- household. A member row and a patient row are separate records and the
    -- desk picks them on separate controls; nothing else would catch a mismatch.
    if v_member_patient <> p_patient_id then
      raise exception 'that scheme membership belongs to a different patient';
    end if;
    if v_scheme_site <> v_site_id then
      raise exception 'that scheme is not run at this site';
    end if;
    if not v_scheme_active then
      raise exception '% is not an active scheme', v_scheme_name;
    end if;
    -- Refused rather than merely flagged. Attaching a lapsed membership would
    -- produce a visit that post_scheme_charge_from_encounter will not bill and
    -- that open_invoice_for_encounter will not invoice either — a patient
    -- treated with no way to charge anyone. Better to say so at the desk,
    -- where the visit can simply be started as an ordinary cash visit.
    if v_from > v_today or (v_to is not null and v_to < v_today) then
      raise exception '% is not covered today — cover ran from %',
        v_member_name,
        to_char(v_from, 'DD Mon YYYY')
          || coalesce(' to ' || to_char(v_to, 'DD Mon YYYY'), ' onwards');
    end if;
  end if;

  select e.id into v_encounter_id
  from encounters e
  where e.patient_id = p_patient_id
    and e.site_id = v_site_id
    and e.status in ('TRIAGE', 'IN_CONSULT')
    and (e.created_at at time zone 'Africa/Nairobi')::date = v_today
  order by e.created_at desc
  limit 1;

  if v_encounter_id is not null then
    update encounters
    set chief_complaint = coalesce(nullif(btrim(coalesce(p_chief_complaint, '')), ''),
                                   chief_complaint),
        -- Idempotent, and a correction when the desk means one: the second
        -- press is how "this one is on Stokman's account after all" gets
        -- recorded. Never cleared by a second press that simply omits it.
        scheme_member_id = coalesce(p_scheme_member_id, scheme_member_id),
        updated_at = now()
    where id = v_encounter_id;
    return v_encounter_id;
  end if;

  insert into encounters (patient_id, site_id, status, chief_complaint,
                          scheme_member_id, created_by)
  values (p_patient_id, v_site_id, 'TRIAGE',
          nullif(btrim(coalesce(p_chief_complaint, '')), ''),
          p_scheme_member_id, auth.uid())
  returning id into v_encounter_id;

  return v_encounter_id;
end;
$$;
revoke execute on function start_encounter(uuid, text, uuid) from public, anon;
grant execute on function start_encounter(uuid, text, uuid) to authenticated;

-- ── What the clinician needs to see ───────────────────────────────────────
-- Reads like the allergy banner it sits next to: the facts that change what
-- the person in the room decides, and nothing else. The month's figures are
-- the COMPANY's, not the patient's, so they are informational — the cap never
-- blocks care, which is the rule 0030 recorded.
create or replace function encounter_scheme_context(p_encounter_id uuid)
returns table (
  member_id uuid, scheme_id uuid, scheme_code text, scheme_name text,
  employee_no text, relation text, child_ref text, member_name text,
  employee_name text, household_size integer,
  covered_from date, covered_to date, covered boolean,
  cap_cents integer, spent_cents integer, remaining_cents integer,
  household_month_cents integer,
  charge_id uuid, charge_total_cents integer, charge_status text
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_member uuid;
  v_scheme uuid;
  v_date date;
  v_period date;
  v_cap integer;
  v_spent integer;
begin
  if p_encounter_id is null then
    raise exception 'a visit is required';
  end if;

  select e.site_id, e.scheme_member_id,
         (e.created_at at time zone 'Africa/Nairobi')::date
    into v_site_id, v_member, v_date
  from encounters e where e.id = p_encounter_id;
  if v_site_id is null then
    raise exception 'unknown encounter';
  end if;
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or v_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  -- An ordinary visit returns no rows rather than an error. The banner asks
  -- this of every encounter it renders; a cash patient is not an exception.
  if v_member is null then
    return;
  end if;

  select m.scheme_id into v_scheme from scheme_members m where m.id = v_member;
  v_period := date_trunc('month', v_date)::date;
  v_cap := scheme_cap_cents(v_scheme, v_period);
  v_spent := scheme_spent_cents(v_scheme, v_period);

  return query
    select m.id, s.id, s.code, s.name,
           m.employee_no, m.relation, m.child_ref, m.full_name,
           emp.full_name,
           (select count(*)::integer from scheme_members h
             where h.scheme_id = m.scheme_id and h.employee_no = m.employee_no),
           m.covered_from, m.covered_to,
           (m.covered_from <= v_date and (m.covered_to is null or m.covered_to >= v_date)),
           v_cap, v_spent,
           -- Null cap is "no limit agreed", which is not the same as a limit of
           -- zero and must not render as one.
           case when v_cap is null then null else v_cap - v_spent end,
           (select coalesce(sum(c.total_cents), 0)::integer
              from scheme_charges c join scheme_members hm on hm.id = c.member_id
             where c.scheme_id = m.scheme_id and hm.employee_no = m.employee_no
               and c.period = v_period and c.status <> 'VOID'),
           ch.id, ch.total_cents, ch.status
    from scheme_members m
    join schemes s on s.id = m.scheme_id
    left join scheme_members emp
      on emp.scheme_id = m.scheme_id and emp.employee_no = m.employee_no
     and emp.relation = 'SELF'
    left join scheme_charges ch
      on ch.encounter_id = p_encounter_id and ch.status <> 'VOID'
    where m.id = v_member;
end;
$$;
revoke execute on function encounter_scheme_context(uuid) from public, anon;
grant execute on function encounter_scheme_context(uuid) to authenticated;

-- ── The worklist says which visits are corporate ──────────────────────────
-- Dropped and recreated: the return type gains three columns and
-- CREATE OR REPLACE cannot change one.
drop function if exists list_encounters(uuid, text);
create or replace function list_encounters(p_site_id uuid, p_status text default null)
returns table (
  id uuid,
  patient_id uuid,
  patient_full_name text,
  patient_mrn text,
  site_id uuid,
  clinician_id uuid,
  status text,
  chief_complaint text,
  vitals jsonb,
  triage_priority text,
  clinical_notes text,
  created_at timestamptz,
  scheme_member_id uuid,
  scheme_code text,
  scheme_name text
)
language plpgsql security definer
set search_path = public
as $$
begin
  -- `site_id` is also this function's own RETURNS TABLE output column, which
  -- PL/pgSQL treats as an implicit local variable for the whole function body
  -- — `select site_id from user_sites(...)` would be ambiguous between that
  -- and user_sites()'s own site_id column. The `us` alias disambiguates it.
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  insert into audit_log(actor_id, action, table_name, details)
  values (auth.uid(), 'SELECT', 'patients', jsonb_build_object('fn', 'list_encounters', 'site_id', p_site_id, 'status', p_status));

  return query
    select e.id, e.patient_id, p.full_name, p.mrn, e.site_id, e.clinician_id,
           e.status, e.chief_complaint, e.vitals, e.triage_priority,
           e.clinical_notes, e.created_at,
           e.scheme_member_id, s.code, s.name
    from encounters e
    join patients p on p.id = e.patient_id
    left join scheme_members m on m.id = e.scheme_member_id
    left join schemes s on s.id = m.scheme_id
    where e.site_id = p_site_id
      and (p_status is null or e.status = p_status)
    order by e.created_at desc;
end;
$$;
revoke execute on function list_encounters(uuid, text) from public, anon;
grant execute on function list_encounters(uuid, text) to authenticated;
