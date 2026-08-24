-- VITCARE-CLINIC — Settings: staff, licences, and which modules the clinic runs
-- ---------------------------------------------------------------------------
-- Everything an administrator has needed so far has been done by hand, in SQL,
-- by me. Onboarding seven staff, granting a role, setting a site — all of it.
-- That is fine for a build and untenable for a clinic: it means the facility
-- cannot correct its own records without a developer, and nothing an
-- administrator does leaves an audit entry, because raw SQL writes none.
--
-- These are the writes the clinic actually needs to own.
--
-- ── THE ONE THAT UNBLOCKS PRESCRIBING ──────────────────────────────────────
-- set_user_license(). 0022 made prescribing depend on holding a practitioner
-- licence rather than on a job title, which is correct — and left no way to
-- record one. So right now every prescription reaching the pharmacy carries a
-- null prescriber licence, and the administrator cannot prescribe at all. This
-- is the function that closes that, and it is why this migration exists.
--
-- ── LOCKOUT ────────────────────────────────────────────────────────────────
-- Two guards, because an administration screen that can lock the clinic out of
-- its own administration is a worse bug than anything it fixes:
--
--   1. NOBODY MAY DEMOTE OR DEACTIVATE THEMSELVES. The single most likely
--      accident on this screen, and the least recoverable.
--   2. AT LEAST ONE ACTIVE ADMIN MUST REMAIN. Guard 1 nearly implies this —
--      you always survive your own change — but two administrators acting at
--      the same moment can each deactivate the other and leave none. This is
--      checked after the write, inside the transaction, so the race loses.
--
-- ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
-- Per-service price editing. The workbook governs prices with a stated
-- process: quarterly review, priced by the Head of Operations, ratified by the
-- Board. A screen letting any administrator retype any of 237 prices at any
-- time replaces that process with a text box. Prices change through a
-- migration, where the change is reviewable and has a date. Turning a whole
-- MODULE on is different — it is an operational fact about what the facility
-- can do today — so that is here.

-- ── Who works here ────────────────────────────────────────────────────────
create or replace function list_staff()
returns table (
  id uuid,
  full_name text,
  email text,
  role text,
  active boolean,
  license_no text,
  can_prescribe boolean,
  site_count integer,
  last_sign_in_at timestamptz,
  is_self boolean
)
language plpgsql security definer
set search_path = public, auth
as $$
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'not authorized to manage staff';
  end if;

  return query
    select u.id, u.full_name, au.email::text, u.role, u.active, u.license_no,
           can_prescribe(u.id),
           (select count(*)::integer from user_site_memberships m where m.user_id = u.id),
           au.last_sign_in_at,
           u.id = auth.uid()
    from users u
    left join auth.users au on au.id = u.id
    order by u.active desc, u.role, u.full_name;
end;
$$;
revoke execute on function list_staff() from public, anon;
grant execute on function list_staff() to authenticated;

-- ── The licence ───────────────────────────────────────────────────────────
-- Blank clears it. Clearing an ADMIN's licence removes their ability to
-- prescribe, which is the correct behaviour and worth being able to do
-- deliberately — a licence that has lapsed should be removable the same day.
create or replace function set_user_license(p_user_id uuid, p_license_no text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_old text;
  v_name text;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'not authorized to manage staff';
  end if;

  select u.license_no, u.full_name into v_old, v_name from users u where u.id = p_user_id;
  if v_name is null then
    raise exception 'unknown user';
  end if;

  update users
  set license_no = nullif(btrim(coalesce(p_license_no, '')), '')
  where id = p_user_id;

  -- The licence decides who may prescribe, so every change to one is recorded
  -- with both sides of it. Raw SQL wrote nothing; this is the point of moving
  -- the operation into the application.
  insert into audit_log(actor_id, action, table_name, record_id, details)
  values (auth.uid(), 'UPDATE', 'users', p_user_id,
          jsonb_build_object('fn', 'set_user_license', 'subject', v_name,
                             'had_licence', coalesce(btrim(v_old), '') <> '',
                             'has_licence', coalesce(btrim(p_license_no), '') <> ''));
end;
$$;
revoke execute on function set_user_license(uuid, text) from public, anon;
grant execute on function set_user_license(uuid, text) to authenticated;

-- ── The role ──────────────────────────────────────────────────────────────
create or replace function set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_old text;
  v_name text;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'not authorized to manage staff';
  end if;
  if p_role not in ('ADMIN','CLINICIAN','NURSE','RECEPTIONIST','PHARMACIST','LAB_TECH','AUDITOR') then
    raise exception 'unknown role %', p_role;
  end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot change your own role — ask another administrator';
  end if;

  select u.role, u.full_name into v_old, v_name from users u where u.id = p_user_id;
  if v_name is null then
    raise exception 'unknown user';
  end if;
  if v_old = p_role then
    return;  -- idempotent
  end if;

  update users set role = p_role where id = p_user_id;

  if (select count(*) from users where role = 'ADMIN' and active) = 0 then
    raise exception 'that would leave the clinic with no active administrator';
  end if;

  insert into audit_log(actor_id, action, table_name, record_id, details)
  values (auth.uid(), 'UPDATE', 'users', p_user_id,
          jsonb_build_object('fn', 'set_user_role', 'subject', v_name,
                             'from', v_old, 'to', p_role));
end;
$$;
revoke execute on function set_user_role(uuid, text) from public, anon;
grant execute on function set_user_role(uuid, text) to authenticated;

-- ── Active / inactive ─────────────────────────────────────────────────────
-- Deactivation is this system's off switch for a person (0012): has_role() and
-- user_sites() both check `active`, so it revokes every role-specific and
-- site-scoped read in one field. It is NOT deletion — the account keeps its
-- name so past entries stay attributable, exactly as the retired demo account
-- does.
create or replace function set_user_active(p_user_id uuid, p_active boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_name text;
  v_was boolean;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'not authorized to manage staff';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot deactivate your own account — ask another administrator';
  end if;

  select u.full_name, u.active into v_name, v_was from users u where u.id = p_user_id;
  if v_name is null then
    raise exception 'unknown user';
  end if;
  if v_was = p_active then
    return;  -- idempotent
  end if;

  update users set active = p_active where id = p_user_id;

  -- Checked AFTER the write and inside the transaction, so two administrators
  -- deactivating each other at the same moment cannot both succeed.
  if (select count(*) from users where role = 'ADMIN' and active) = 0 then
    raise exception 'that would leave the clinic with no active administrator';
  end if;

  insert into audit_log(actor_id, action, table_name, record_id, details)
  values (auth.uid(), 'UPDATE', 'users', p_user_id,
          jsonb_build_object('fn', 'set_user_active', 'subject', v_name, 'active', p_active));
end;
$$;
revoke execute on function set_user_active(uuid, boolean) from public, anon;
grant execute on function set_user_active(uuid, boolean) to authenticated;

-- ── Which modules the facility runs ───────────────────────────────────────
create or replace function list_service_modules(p_site_id uuid)
returns table (
  module text,
  services integer,
  active_services integer,
  billable_services integer,
  is_active boolean
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not (
    has_role(auth.uid(), 'ADMIN') or has_role(auth.uid(), 'AUDITOR')
    or p_site_id in (select us.site_id from user_sites(auth.uid()) us)
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select s.module,
           count(*)::integer,
           count(*) filter (where s.active)::integer,
           count(*) filter (where s.billable)::integer,
           bool_or(s.active)
    from service_catalog s
    where s.site_id = p_site_id
    group by s.module
    order by (s.module = 'Core') desc, s.module;
end;
$$;
revoke execute on function list_service_modules(uuid) from public, anon;
grant execute on function list_service_modules(uuid) to authenticated;

-- Turning a Conditional module on is a statement that the licence, equipment
-- and registered personnel are in place — the catalogue says so in as many
-- words. The system cannot verify that, so it records who asserted it and when.
--
-- 'Core' cannot be switched off: it is what a Level 3 facility is licensed to
-- do by definition, and disabling it would leave a clinic that can treat
-- nobody and bill nothing.
create or replace function set_service_module_active(
  p_site_id uuid,
  p_module text,
  p_active boolean
)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  v_changed integer;
begin
  if not has_role(auth.uid(), 'ADMIN') then
    raise exception 'not authorized to change service modules';
  end if;
  if p_module = 'Core' and not p_active then
    raise exception 'the Core module cannot be switched off';
  end if;
  if not exists (select 1 from service_catalog s
                 where s.site_id = p_site_id and s.module = p_module) then
    raise exception 'no module named % at this site', p_module;
  end if;

  update service_catalog
  set active = p_active
  where site_id = p_site_id and module = p_module and active is distinct from p_active;
  get diagnostics v_changed = row_count;

  insert into audit_log(actor_id, action, table_name, details)
  values (auth.uid(), 'UPDATE', 'service_catalog',
          jsonb_build_object('fn', 'set_service_module_active', 'site_id', p_site_id,
                             'module', p_module, 'active', p_active, 'services', v_changed));

  return v_changed;
end;
$$;
revoke execute on function set_service_module_active(uuid, text, boolean) from public, anon;
grant execute on function set_service_module_active(uuid, text, boolean) to authenticated;
