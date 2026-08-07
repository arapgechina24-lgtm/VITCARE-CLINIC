-- VITCARE-CLINIC — deactivating a staff member must actually revoke their access
-- ---------------------------------------------------------------------------
-- THE BUG
-- has_role() checks `active`. user_sites() did not. Every site-scoped
-- authorization path in the system — get_patient_record, list_patients_summary,
-- the patients/encounters/prescriptions RLS policies — authorizes on site
-- membership, so setting users.active = false revoked a user's ROLE-specific
-- powers (prescribing, admin reads) while leaving their ability to open any
-- patient chart at their site completely intact.
--
-- The practical consequence: dismiss a receptionist, deactivate the account,
-- and they keep full read access to every medical record at that site. Their
-- Supabase session also survives — deactivating a row in `users` does not
-- invalidate an issued JWT — so the access continues silently for as long as
-- the refresh token keeps renewing. Under the Data Protection Act 2019 that is
-- unauthorised processing of health data by someone the controller believes
-- has been offboarded.
--
-- THE FIX
-- One join. Membership now means "member AND still employed here".
--
-- NOTE on the alias: user_sites RETURNS TABLE(site_id uuid), and a RETURNS
-- TABLE column name becomes an implicit variable across the whole function
-- body. An unqualified `site_id` in the select list would be ambiguous against
-- it — the exact bug that broke list_encounters in 0003. Hence `m.site_id`.
create or replace function user_sites(p_user uuid)
returns table(site_id uuid)
language sql security definer stable
set search_path = public
as $$
  select m.site_id
  from user_site_memberships m
  join users u on u.id = m.user_id
  where m.user_id = p_user
    and u.active;
$$;

revoke execute on function user_sites(uuid) from anon;
grant execute on function user_sites(uuid) to authenticated;

-- Deactivation still does not invalidate an already-issued access token, which
-- Supabase caps at one hour by default. This closes the database side; the
-- session side needs an explicit sign-out of that user from the Supabase Auth
-- admin API as part of the offboarding routine. Both are required — see the
-- offboarding note in README.md.
