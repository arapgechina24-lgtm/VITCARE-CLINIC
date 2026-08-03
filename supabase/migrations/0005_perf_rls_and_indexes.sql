-- VITCARE-CLINIC — performance pass on the Phase 0 security layer
-- ---------------------------------------------------------------------------
-- Three findings from Supabase's database linter, none of which change WHO can
-- see WHAT — every policy below is logically identical to the one it replaces.
-- Re-verified after applying: receptionist can register, pharmacist cannot,
-- admin still cannot prescribe, pharmacist can still read the queue.
--
-- 1. auth_rls_initplan (14 policies). `auth.uid()` inside a policy is
--    re-evaluated FOR EVERY ROW scanned. Wrapping it as `(select auth.uid())`
--    makes Postgres treat it as a one-time InitPlan instead. On a table scan
--    of N rows that is N function calls versus 1 — the single highest-leverage
--    fix available here, and it grows more important as the patient list does.
--
-- 2. unindexed_foreign_keys (17). Every FK without a covering index forces a
--    sequential scan to satisfy referential checks and makes the join side of
--    our own queries slow. `prescription_items.prescription_id` and
--    `encounters.patient_id` are on the hot path for the webhook receiver and
--    the queue view respectively.
--
-- 3. multiple_permissive_policies on `users`. Two permissive SELECT policies
--    both run for every query; merged into one with an OR.

-- ── 1 + 3. Policies rewritten with InitPlan-friendly auth calls ───────────
drop policy if exists sites_read_all on sites;
create policy sites_read_all on sites
  for select using ((select auth.role()) = 'authenticated');

-- Merged: was users_read_self + users_admin_read_all, two permissive policies
-- evaluated on every read of this table (which every page load does).
drop policy if exists users_read_self on users;
drop policy if exists users_admin_read_all on users;
create policy users_read_self_or_admin on users
  for select using (
    id = (select auth.uid())
    or has_role((select auth.uid()), 'ADMIN')
  );

drop policy if exists user_site_memberships_read_self on user_site_memberships;
create policy user_site_memberships_read_self on user_site_memberships
  for select using (user_id = (select auth.uid()));

drop policy if exists patients_site_read on patients;
create policy patients_site_read on patients
  for select using (
    site_id in (select site_id from user_sites((select auth.uid())))
    or has_role((select auth.uid()), 'AUDITOR')
  );

drop policy if exists patients_registration_write on patients;
create policy patients_registration_write on patients
  for insert with check (
    created_by = (select auth.uid())
    and (
      has_role((select auth.uid()), 'RECEPTIONIST')
      or has_role((select auth.uid()), 'NURSE')
      or has_role((select auth.uid()), 'ADMIN')
    )
  );

drop policy if exists patients_clinical_update on patients;
create policy patients_clinical_update on patients
  for update using (site_id in (select site_id from user_sites((select auth.uid()))));

drop policy if exists encounters_site_read on encounters;
create policy encounters_site_read on encounters
  for select using (
    site_id in (select site_id from user_sites((select auth.uid())))
    or has_role((select auth.uid()), 'AUDITOR')
  );

drop policy if exists encounters_site_write on encounters;
create policy encounters_site_write on encounters
  for insert with check (
    created_by = (select auth.uid())
    and site_id in (select site_id from user_sites((select auth.uid())))
  );

drop policy if exists encounters_site_update on encounters;
create policy encounters_site_update on encounters
  for update using (site_id in (select site_id from user_sites((select auth.uid()))));

drop policy if exists audit_log_admin_read on audit_log;
create policy audit_log_admin_read on audit_log
  for select using (
    has_role((select auth.uid()), 'ADMIN')
    or has_role((select auth.uid()), 'AUDITOR')
  );

drop policy if exists prescriptions_site_read on prescriptions;
create policy prescriptions_site_read on prescriptions
  for select using (
    site_id in (select site_id from user_sites((select auth.uid())))
    or has_role((select auth.uid()), 'AUDITOR')
  );

drop policy if exists prescriptions_clinician_write on prescriptions;
create policy prescriptions_clinician_write on prescriptions
  for insert with check (
    created_by = (select auth.uid())
    and has_role((select auth.uid()), 'CLINICIAN')
  );

drop policy if exists prescriptions_clinician_update on prescriptions;
create policy prescriptions_clinician_update on prescriptions
  for update using (site_id in (select site_id from user_sites((select auth.uid()))));

drop policy if exists prescription_items_read on prescription_items;
create policy prescription_items_read on prescription_items
  for select using (
    exists (
      select 1 from prescriptions p
      where p.id = prescription_items.prescription_id
        and (
          p.site_id in (select site_id from user_sites((select auth.uid())))
          or has_role((select auth.uid()), 'AUDITOR')
        )
    )
  );

drop policy if exists prescription_items_write on prescription_items;
create policy prescription_items_write on prescription_items
  for insert with check (
    exists (
      select 1 from prescriptions p
      where p.id = prescription_items.prescription_id
        and p.created_by = (select auth.uid())
    )
  );

-- ── 2. Covering indexes for every foreign key ─────────────────────────────
create index if not exists idx_audit_log_actor_id on audit_log (actor_id);
-- Not an FK, but audit_log.patient_id exists precisely to answer "who accessed
-- this patient's record" — the query a Data Protection Act audit actually asks.
-- Without this index that question is a full scan of an append-only table that
-- only ever grows.
create index if not exists idx_audit_log_patient_id on audit_log (patient_id);

create index if not exists idx_encounters_clinician_id on encounters (clinician_id);
create index if not exists idx_encounters_created_by on encounters (created_by);
create index if not exists idx_encounters_patient_id on encounters (patient_id);
create index if not exists idx_encounters_site_id on encounters (site_id);

create index if not exists idx_integration_outbox_prescription_id on integration_outbox (prescription_id);

create index if not exists idx_patients_created_by on patients (created_by);
create index if not exists idx_patients_site_id on patients (site_id);

create index if not exists idx_prescription_items_prescription_id on prescription_items (prescription_id);

create index if not exists idx_prescriptions_created_by on prescriptions (created_by);
create index if not exists idx_prescriptions_encounter_id on prescriptions (encounter_id);
create index if not exists idx_prescriptions_fulfillment_site_id on prescriptions (fulfillment_site_id);
create index if not exists idx_prescriptions_patient_id on prescriptions (patient_id);
create index if not exists idx_prescriptions_prescriber_id on prescriptions (prescriber_id);
create index if not exists idx_prescriptions_site_id on prescriptions (site_id);
create index if not exists idx_prescriptions_updated_by on prescriptions (updated_by);

create index if not exists idx_user_site_memberships_site_id on user_site_memberships (site_id);
