-- ⚠️ TEMPORARY TESTING CONCESSION — REVERT BEFORE REAL PATIENTS ⚠️
-- ---------------------------------------------------------------------------
-- Filename says TEMPORARY on purpose: this is the one migration in the project
-- that deliberately WEAKENS an access rule, and it should be obvious in a
-- directory listing.
--
-- WHY: prescribing and consult notes are restricted to CLINICIAN because
-- prescribing is a regulated clinical act. No real clinical officer exists on
-- the system yet, so nobody could walk the full Register → Triage → Consult →
-- Prescribe loop, which made the system impossible to demo or test end to end.
-- This lets ADMIN do it too, so one account can exercise the whole flow.
--
-- HOW TO REVERT — one line, nothing else:
--   create or replace function can_prescribe(p_user uuid)
--   returns boolean language sql security definer stable set search_path = public
--   as $$ select has_role(p_user, 'CLINICIAN'); $$;
-- Do that as soon as a real clinician has a CLINICIAN account.
--
-- Expressing it as a single function rather than an `or has_role(..., 'ADMIN')`
-- repeated across three call sites is the point: the whole concession is
-- visible in one place, and undoing it cannot miss a site.
--
-- WHAT THIS DOES NOT WEAKEN:
--   * Attribution. audit_log records actor_id and prescriptions.prescriber_id
--     is set from auth.uid(), so an admin-written prescription stays
--     permanently identifiable as theirs — verified after applying.
--   * Everyone else. PHARMACIST and RECEPTIONIST are still refused, verified
--     after applying.
--   * Note that an ADMIN has no licence_no, so the prescriber licence sent to
--     the pharmacy is null. Fine for testing; not something to dispense real
--     controlled medicines against.

create or replace function can_prescribe(p_user uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select has_role(p_user, 'CLINICIAN') or has_role(p_user, 'ADMIN');
$$;

revoke execute on function can_prescribe(uuid) from anon;
grant execute on function can_prescribe(uuid) to authenticated;

-- save_consult_notes and submit_prescription are recreated in the live
-- database to call can_prescribe() instead of has_role(..., 'CLINICIAN').
-- Their bodies are otherwise unchanged from 0004 and 0002 respectively — only
-- the authorisation predicate on the first line of each body differs.
-- See the applied migration `admin_can_prescribe_testing_concession`.

drop policy if exists prescriptions_clinician_write on prescriptions;
create policy prescriptions_clinician_write on prescriptions
  for insert with check (
    created_by = (select auth.uid())
    and can_prescribe((select auth.uid()))
  );
