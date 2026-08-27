-- VITCARE-CLINIC — the monthly statement to the farm
-- ---------------------------------------------------------------------------
-- One document per farm per month, cut from the visits already posted. The
-- facility asked for it to generate automatically after every month; the
-- generation is here, and it is deliberately in two steps rather than one:
--
--   build_scheme_statement()   — safe, repeatable, changes nothing that matters.
--                                Re-run it as often as you like; each run
--                                re-reads the month and restates the draft.
--   issue_scheme_statement()   — gives it a number, freezes the charges, and
--                                stamps who issued it and when.
--
-- The split exists because the month does not stop being edited at midnight on
-- the 31st. A visit gets back-entered, a price gets corrected, a charge gets
-- voided. A single "generate and send" call would either lock the month too
-- early or produce a document that quietly disagrees with the register behind
-- it. Draft is where the corrections happen; issuing is the point of no
-- return, and after it the month is closed to new charges (post_scheme_charge
-- refuses, 0032).

-- ── Build or rebuild the draft ────────────────────────────────────────────
create or replace function build_scheme_statement(p_scheme_id uuid, p_period date)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_period date := date_trunc('month', p_period)::date;
  v_id uuid;
  v_status text;
begin
  if not (has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'RECEPTIONIST')) then
    raise exception 'not authorized to prepare scheme statements';
  end if;

  select s.site_id into v_site_id from schemes s where s.id = p_scheme_id;
  if v_site_id is null then
    raise exception 'unknown scheme';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;

  select st.id, st.status into v_id, v_status
  from scheme_statements st
  where st.scheme_id = p_scheme_id and st.period = v_period and st.status <> 'VOID';

  if v_status = 'ISSUED' then
    raise exception 'the % statement has already been issued as %',
      to_char(v_period, 'Mon YYYY'),
      (select statement_no from scheme_statements where id = v_id);
  end if;

  if v_id is null then
    insert into scheme_statements (scheme_id, period, created_by)
    values (p_scheme_id, v_period, auth.uid())
    returning id into v_id;
  end if;

  -- Rebuilt from scratch every time. Adding to the existing set would double
  -- count a charge on the second run, and the link table's unique index would
  -- turn an ordinary re-run into an error the desk cannot act on.
  delete from scheme_statement_lines where statement_id = v_id;

  insert into scheme_statement_lines (statement_id, charge_id)
  select v_id, c.id
  from scheme_charges c
  where c.scheme_id = p_scheme_id and c.period = v_period and c.status <> 'VOID';

  update scheme_statements st
  set visits = t.visits,
      consultation_cents = t.cons,
      lab_cents = t.lab,
      surgical_cents = t.surg,
      pharmacy_cents = t.pharm,
      total_cents = t.total,
      over_limit_cents = t.over,
      cap_cents = scheme_cap_cents(p_scheme_id, v_period),
      updated_at = now()
  from (
    select
      count(*)::integer as visits,
      coalesce(sum(c.consultation_cents), 0)::integer as cons,
      coalesce(sum(c.lab_cents), 0)::integer as lab,
      coalesce(sum(c.surgical_cents), 0)::integer as surg,
      coalesce(sum(c.pharmacy_cents), 0)::integer as pharm,
      coalesce(sum(c.total_cents), 0)::integer as total,
      coalesce(sum(c.total_cents) filter (where c.over_limit), 0)::integer as over
    from scheme_charges c
    join scheme_statement_lines l on l.charge_id = c.id and l.statement_id = v_id
  ) t
  where st.id = v_id;

  return v_id;
end;
$$;
revoke execute on function build_scheme_statement(uuid, date) from public, anon;
grant execute on function build_scheme_statement(uuid, date) to authenticated;

-- ── Issue ─────────────────────────────────────────────────────────────────
create or replace function issue_scheme_statement(p_statement_id uuid)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_scheme uuid;
  v_code text;
  v_period date;
  v_status text;
  v_visits integer;
  v_seq integer;
  v_no text;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'only an administrator can issue a scheme statement';
  end if;

  select s.site_id, s.id, s.code, st.period, st.status, st.visits
    into v_site_id, v_scheme, v_code, v_period, v_status, v_visits
  from scheme_statements st join schemes s on s.id = st.scheme_id
  where st.id = p_statement_id;
  if v_site_id is null then
    raise exception 'unknown statement';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'that statement is already %', lower(v_status);
  end if;
  if coalesce(v_visits, 0) = 0 then
    raise exception 'there are no visits on the % statement', to_char(v_period, 'Mon YYYY');
  end if;

  -- A month cannot be invoiced before it has finished. Issuing mid-month would
  -- send the farm a document that the rest of the month then contradicts.
  if v_period >= date_trunc('month', (now() at time zone 'Africa/Nairobi')::date)::date then
    raise exception '% is not over yet — the statement can be issued from the 1st of the following month',
      to_char(v_period, 'Mon YYYY');
  end if;

  insert into scheme_statement_counters (site_id, period, next_seq)
  values (v_site_id, v_period, 2)
  on conflict (site_id, period) do update
    set next_seq = scheme_statement_counters.next_seq + 1
  returning next_seq - 1 into v_seq;

  v_no := 'VC-SCH-' || v_code || '-' || to_char(v_period, 'YYYYMM')
          || '-' || lpad(v_seq::text, 2, '0');

  update scheme_statements
  set statement_no = v_no, status = 'ISSUED',
      issued_at = now(), issued_by = auth.uid(), updated_at = now()
  where id = p_statement_id;

  -- Freeze the visits this document reports. From here they cannot be voided
  -- or edited without voiding the statement first.
  update scheme_charges c
  set status = 'STATEMENTED', updated_at = now()
  from scheme_statement_lines l
  where l.statement_id = p_statement_id and l.charge_id = c.id and c.status = 'OPEN';

  return v_no;
end;
$$;
revoke execute on function issue_scheme_statement(uuid) from public, anon;
grant execute on function issue_scheme_statement(uuid) to authenticated;

-- ── Void ──────────────────────────────────────────────────────────────────
-- Releases the charges back to OPEN so the month can be corrected and re-cut.
-- The voided statement and its number stay on the record: the farm has a copy
-- of it, and a number that vanishes is a number nobody can reconcile.
create or replace function void_scheme_statement(p_statement_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_status text;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'only an administrator can void a scheme statement';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'voiding a statement needs a reason';
  end if;

  select s.site_id, st.status into v_site_id, v_status
  from scheme_statements st join schemes s on s.id = st.scheme_id
  where st.id = p_statement_id;
  if v_site_id is null then
    raise exception 'unknown statement';
  end if;
  if v_site_id not in (select us.site_id from user_sites(auth.uid()) us) then
    raise exception 'not authorized for this site';
  end if;
  if v_status = 'VOID' then
    raise exception 'that statement is already void';
  end if;

  update scheme_charges c
  set status = 'OPEN', updated_at = now()
  from scheme_statement_lines l
  where l.statement_id = p_statement_id and l.charge_id = c.id and c.status = 'STATEMENTED';

  -- The lines go, so the charges are free to be picked up by the re-cut. The
  -- statement's own totals stay, because they are what the farm was sent.
  delete from scheme_statement_lines where statement_id = p_statement_id;

  update scheme_statements
  set status = 'VOID', void_reason = btrim(p_reason), updated_at = now()
  where id = p_statement_id;
end;
$$;
revoke execute on function void_scheme_statement(uuid, text) from public, anon;
grant execute on function void_scheme_statement(uuid, text) to authenticated;

-- ── The statement list ────────────────────────────────────────────────────
create or replace function list_scheme_statements(
  p_site_id uuid,
  p_scheme_id uuid default null,
  p_limit integer default 24
)
returns table (
  id uuid, scheme_id uuid, code text, name text, period date,
  statement_no text, status text, visits integer,
  consultation_cents integer, lab_cents integer,
  surgical_cents integer, pharmacy_cents integer,
  total_cents integer, over_limit_cents integer, cap_cents integer,
  issued_at timestamptz, issued_by_name text, void_reason text
)
language plpgsql security definer
set search_path = public
as $$
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
    select st.id, st.scheme_id, s.code, s.name, st.period,
           st.statement_no, st.status, st.visits,
           st.consultation_cents, st.lab_cents, st.surgical_cents, st.pharmacy_cents,
           st.total_cents, st.over_limit_cents, st.cap_cents,
           st.issued_at, u.full_name, st.void_reason
    from scheme_statements st
    join schemes s on s.id = st.scheme_id
    left join users u on u.id = st.issued_by
    where s.site_id = p_site_id
      and (p_scheme_id is null or st.scheme_id = p_scheme_id)
    order by st.period desc, s.code
    limit greatest(least(coalesce(p_limit, 24), 200), 1);
end;
$$;
revoke execute on function list_scheme_statements(uuid, uuid, integer) from public, anon;
grant execute on function list_scheme_statements(uuid, uuid, integer) to authenticated;

-- ── Which months are ready to invoice ─────────────────────────────────────
-- Drives the "generate after every month" prompt: any past month with visits
-- on it and no live statement. Answered by the server so the screen is not
-- deciding what is owed.
create or replace function scheme_periods_awaiting_statement(p_site_id uuid)
returns table (
  scheme_id uuid, code text, name text, period date,
  visits integer, total_cents integer, statement_id uuid, statement_status text
)
language plpgsql security definer
set search_path = public
as $$
declare
  v_this_month date := date_trunc('month', (now() at time zone 'Africa/Nairobi')::date)::date;
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
    select s.id, s.code, s.name, c.period,
           count(*)::integer, sum(c.total_cents)::integer,
           st.id, st.status
    from scheme_charges c
    join schemes s on s.id = c.scheme_id
    left join scheme_statements st
      on st.scheme_id = c.scheme_id and st.period = c.period and st.status <> 'VOID'
    where s.site_id = p_site_id
      and c.status <> 'VOID'
      and c.period < v_this_month
      and (st.id is null or st.status = 'DRAFT')
    group by s.id, s.code, s.name, c.period, st.id, st.status
    order by c.period desc, s.code;
end;
$$;
revoke execute on function scheme_periods_awaiting_statement(uuid) from public, anon;
grant execute on function scheme_periods_awaiting_statement(uuid) to authenticated;
