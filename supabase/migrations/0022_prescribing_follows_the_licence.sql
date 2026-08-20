-- VITCARE-CLINIC — prescribing follows the licence, not the job title
-- ---------------------------------------------------------------------------
-- SUPERSEDES 0007_admin_can_prescribe_TEMPORARY.sql, which said of itself:
-- "REVERT BEFORE REAL PATIENTS". This is that revert — but not a straight one,
-- because a straight revert would have been wrong for this clinic.
--
-- ── WHY NOT JUST GO BACK TO CLINICIAN-ONLY ─────────────────────────────────
-- 0007 existed because no clinical officer had an account, so nobody could
-- walk Register → Triage → Consult → Prescribe. Four now do. But the clinic
-- also has an administrator who genuinely treats patients, and the schema
-- allows exactly one role per person (users.role has a CHECK constraint).
-- Reverting to CLINICIAN-only would have stopped a real prescriber
-- prescribing; leaving 0007 alone lets EVERY admin prescribe, including ones
-- hired to do books rather than medicine.
--
-- ── THE RULE ───────────────────────────────────────────────────────────────
-- Prescribing follows the thing that actually authorises it: a practitioner
-- licence. A CLINICIAN prescribes by virtue of the role. An ADMIN prescribes
-- only while users.license_no holds something — which is a fact about the
-- person, revocable by clearing one column, and visible in the same row an
-- auditor is already reading.
--
-- This also closes the hole 0007 documented and then lived with: "an ADMIN has
-- no licence_no, so the prescriber licence sent to the pharmacy is null. Fine
-- for testing; not something to dispense real controlled medicines against."
-- Under this rule an admin with a null licence cannot prescribe at all, so the
-- pharmacy can no longer receive a null prescriber licence from an admin.
--
-- Deliberately unchanged: CLINICIAN does not require a licence here. Adding
-- that would lock out the four clinicians onboarded today, none of whom has a
-- licence number recorded yet — a change that silently stops a clinic working
-- is worse than one that leaves a known gap visible. Record the numbers, then
-- tighten this to require a licence for every prescriber.

create or replace function can_prescribe(p_user uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from users u
    where u.id = p_user
      and u.active                        -- same liveness check has_role() applies
      and (
        u.role = 'CLINICIAN'
        or (u.role = 'ADMIN' and coalesce(btrim(u.license_no), '') <> '')
      )
  );
$$;

revoke execute on function can_prescribe(uuid) from anon;
grant execute on function can_prescribe(uuid) to authenticated;

-- The write policy from 0007 already routes through can_prescribe(), as do
-- save_consult_notes and submit_prescription, so nothing else needs touching:
-- changing the predicate in one function changes every call site at once.
-- That was the stated reason 0007 was written as a function rather than as
-- `or has_role(..., 'ADMIN')` repeated across three places.
