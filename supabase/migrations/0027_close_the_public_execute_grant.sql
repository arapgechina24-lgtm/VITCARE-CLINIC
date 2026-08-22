-- VITCARE-CLINIC — close the PUBLIC execute grant on SECURITY DEFINER functions
-- ---------------------------------------------------------------------------
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
-- Twenty SECURITY DEFINER functions were callable by the `anon` role over the
-- public internet, at /rest/v1/rpc/<name>, despite every one of them carrying a
-- `revoke execute ... from anon` line.
--
-- The revoke was real. It was also, for these functions, a no-op — and the
-- reason is worth writing down because the codebase already contains a comment
-- that gets it half right.
--
-- 0000's header explains that Supabase's project template grants EXECUTE on new
-- public-schema functions to `anon` and `authenticated` explicitly, and that
-- "revoke ... from public does nothing against it". Both true. What it misses is
-- that there is a SECOND grant in play: PostgreSQL itself grants EXECUTE to
-- PUBLIC on every function at CREATE time, and `anon` — like every role —
-- inherits PUBLIC. So revoking the named `anon` grant removes one of two doors
-- and leaves the other standing.
--
-- It is visible in pg_proc.proacl as an entry with an empty grantee. The
-- unaffected functions from 0000 and 0008 look like this:
--
--     postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres
--
-- and the twenty affected ones looked like this — note the leading `=X`:
--
--     =X/postgres | postgres=X/postgres | authenticated=X/postgres | ...
--
-- ── HOW BAD WAS IT ─────────────────────────────────────────────────────────
-- Not a patient-data breach, and this file should not pretend otherwise. Every
-- function that RETURNS anything checks auth.uid() through has_role() or
-- user_sites(), and for an anon caller auth.uid() is null, so those calls raise
-- 'not authorized' before touching a row. The defence in depth held.
--
-- One function was a genuine hole. billing_recalc_invoice(uuid) has no
-- authorization check at all — by design, it is an internal derivation helper
-- called from inside other definer functions and from a trigger. Reachable by
-- anon, it became an UNAUTHENTICATED WRITE against the invoices table: anyone
-- who could guess an invoice UUID could force a recalculation and move that
-- invoice's status. It only ever writes values derived from the invoice's own
-- lines and payments, so it cannot forge a total, and a v4 UUID is not
-- realistically guessable — but an unauthenticated write path into a billing
-- table is not something to leave standing on the strength of "they would have
-- to guess a UUID".
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Enumerated rather than listed by name, deliberately. A hand-written list is a
-- list that goes stale the next time someone adds a function and copies the
-- `revoke ... from anon` line that did not work here either. This walks every
-- SECURITY DEFINER function in the schema, so it is correct for the twenty that
-- are wrong today and for any that were already right.
--
-- Explicit `authenticated` grants are untouched, so the application is
-- unaffected. Verified before writing this file: the whole billing flow — open,
-- charge, re-price at a different payer, issue, take payment — was run inside a
-- transaction with these revokes applied and completed normally, ending PAID
-- with correct derived totals. Two functions lose access they were relying on
-- PUBLIC for, and both are fine:
--
--   · billing_items_changed() is a trigger function. Postgres checks EXECUTE on
--     a trigger function at CREATE TRIGGER time, not at fire time, so the
--     triggers keep firing.
--   · billing_recalc_invoice(uuid) is only ever called from inside SECURITY
--     DEFINER functions owned by postgres, where current_user is the owner.
--
-- Neither is called directly by the application. That was confirmed against
-- pg_proc.proacl rather than assumed: they were the only two functions in the
-- schema where `authenticated` had EXECUTE without an explicit grant entry.

do $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prosecdef
  loop
    -- Both doors: the PUBLIC grant Postgres adds at CREATE time, and the named
    -- anon grant Supabase's default privileges add.
    execute format('revoke execute on function %s from public, anon', r.sig);
    v_n := v_n + 1;
  end loop;
  raise notice 'closed PUBLIC/anon execute on % security definer function(s)', v_n;
end;
$$;

-- 0000 already stops a NEW function from acquiring the named anon grant. This
-- is the matching half for the PUBLIC grant, so the next function added to this
-- schema does not quietly reopen what the block above just closed.
alter default privileges in schema public revoke execute on functions from public;

-- ── search_path on the two pricing helpers ────────────────────────────────
-- Flagged by Supabase's own advisor. Every other function in this schema pins
-- `set search_path = public`; 0025 added these two without it because they are
-- pure arithmetic over their arguments and read no tables.
--
-- That reasoning is not good enough for a SQL function that will be inlined
-- into queries running as other roles: an unqualified name resolved through a
-- caller-controlled search_path is the standard shape of a definer-function
-- escalation, and "this one happens to have nothing to resolve" is a property
-- of today's body, not a guarantee about tomorrow's. Pinned to match everything
-- else, so the rule is uniform rather than case-by-case.
--
-- ALTER FUNCTION, not CREATE OR REPLACE: the bodies are unchanged and rewriting
-- them here would put a second, drifting copy of the pricing rule in the
-- migrations folder.
alter function billing_price_cents(text, text, integer, integer) set search_path = public;
alter function billing_price_basis(text, text) set search_path = public;
