-- VITCARE-CLINIC — expose the auth identity mapping for backup
-- ---------------------------------------------------------------------------
-- WHY THIS IS NEEDED
-- public.users.id is a foreign key to auth.users.id. Restoring the public
-- schema without that mapping produces a database full of clinical records
-- attributed to staff accounts that no longer exist — every prescriber_id,
-- created_by and audit_log.actor_id dangling. Re-inviting the same people
-- would mint NEW uuids and would not reconnect anything.
--
-- PostgREST only serves the public schema, so an unattended backup job cannot
-- read auth.users directly. This is the door.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN
-- encrypted_password, and every token column. Restoring access does not need
-- them: with the id and email you can recreate the account through the Admin
-- API carrying the SAME uuid, and the person signs in again. Copying password
-- hashes onto a Mac in a backup folder would create a credential store where
-- there was none — a real liability in exchange for saving each person one
-- password reset.
--
-- Service role only. `authenticated` must never be able to enumerate staff
-- emails.

create or replace function auth_identity_export()
returns table (
  id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  email_confirmed_at timestamptz
)
language sql
security definer
stable
set search_path = auth, public
as $$
  select u.id, u.email::text, u.created_at, u.last_sign_in_at, u.email_confirmed_at
  from auth.users u
  order by u.created_at;
$$;

revoke execute on function auth_identity_export() from anon, authenticated;
