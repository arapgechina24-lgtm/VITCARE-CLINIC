-- VITCARE-CLINIC — schema drift detection
-- ---------------------------------------------------------------------------
-- Three times now, a function running in this database has differed from the
-- migration file that supposedly defines it (submit_prescription twice,
-- save_consult_notes once). Every instance was found by hand, and each one
-- would have caused a silent regression on a rebuild.
--
-- "Remember to check" is not a control. This RPC makes drift MEASURABLE, so
-- scripts/check-drift.mjs can fail a check instead of relying on someone
-- recalling a rule at the right moment.
--
-- WHY FINGERPRINTS AND NOT SOURCE
-- It returns md5 digests, never the function bodies. A digest is enough to
-- answer "has this changed since the last known-good state", which is the only
-- question being asked, and it means the endpoint cannot be turned into a way
-- to read out the security-definer functions that enforce authorization.
--
-- Comparing normalised digests rather than raw file text also side-steps a
-- false-positive problem: Postgres reformats a function when it stores it, so
-- the file and pg_get_functiondef never match byte for byte even when nothing
-- has drifted. The baseline is captured FROM the database after a known-good
-- migration, and compared against the database later.

create or replace function function_fingerprints()
returns table (function_name text, fingerprint text)
language sql
security definer
stable
set search_path = public
as $$
  select p.proname::text, md5(pg_get_functiondef(p.oid))::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
  order by p.proname;
$$;

-- Service role only. Ordinary staff have no reason to enumerate the database's
-- functions, and `authenticated` is the role an attacker reaches first.
revoke execute on function function_fingerprints() from anon, authenticated;
