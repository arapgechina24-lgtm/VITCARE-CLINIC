-- VITCARE-CLINIC — corporate schemes: the flower farms, billed properly
-- ---------------------------------------------------------------------------
-- ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
-- Two workbooks kept by hand, one per farm, with the same seven columns:
--
--     DATE | NAME | PAYROLL | CONS | LAB | SURGICAL | PHARMACY
--
-- and a description column paired with a money column for each of the last
-- three. That shape is preserved below and in the exports, because the farms'
-- finance offices reconcile against it and a statement they cannot tie back to
-- their own sheet is a statement they will not pay.
--
-- What the workbooks cannot do, and this does:
--
--   1. PRICE WHAT WAS DISPENSED. In the August 2026 Stokman sheet, 163 rows
--      carry a pharmacy description and exactly one carries a pharmacy price;
--      58 rows request lab work and one is priced. The invoice that sheet
--      produces is KES 18,200 — consultations only. La Pieve, at comparable
--      volume, prices its pharmacy column and invoices KES 117,150. The
--      difference is not clinical, it is a blank cell. Here a dispensing
--      cannot be recorded without a price (see scheme_charges' CHECK), so the
--      column cannot silently go to zero.
--
--   2. KNOW WHO IS A MEMBER. 54 of 173 Stokman visits that month are against
--      payroll numbers that appear nowhere in the employer's own register.
--      A membership here is a row with a start date and an end date, and the
--      desk is told at the point of care whether the person in front of it is
--      covered.
--
--   3. RECONCILE A NAME TO A PERSON. The sheets contain CALVIN CLEIN and
--      CALVIN KLEIN, ROSELYN and ROSELINE KHISA SANJA, ZAKIUS OWINO and
--      ZAKIUS OWINO ABIERO — 146 spellings across 107 payroll numbers.
--      Members point at patients, so a person is one record however their name
--      was typed on any given morning.
--
--   4. STOP BEFORE THE CAP. The farms agree a monthly ceiling. Today it is
--      discovered by adding the sheet up at month end, which is after the
--      money has been spent.
--
-- ── DECISIONS TAKEN, AND BY WHOM ───────────────────────────────────────────
-- These four were put to the facility and answered; they are recorded here
-- because each one is visible in the schema and none is recoverable from it.
--   · The cap is per company per calendar month.
--   · Crossing it warns and flags — it never refuses care. The flagged lines
--     are totalled separately on the statement for the farm to approve.
--   · A spouse and children draw on the employee's account, which is how the
--     payroll number already behaves on the sheets: SRK 646 is six people.
--   · Stokman's blank pharmacy column is a data-entry gap, not a contract
--     term. Pharmacy and lab are chargeable to both farms.
--
-- ── WHY THIS IS NOT service_catalog ────────────────────────────────────────
-- The facility's 237-line catalogue is governed: priced by the Head of
-- Operations, ratified by the Board, revised quarterly, and changed only
-- through a dated migration. The farms are billed off a different instrument —
-- a negotiated contract with its own consultation fee (SRK 100, LPL 50 against
-- a catalogue rate that is neither) and pharmacy priced from what was actually
-- dispensed on the day. Forcing the farms through the catalogue would either
-- corrupt the catalogue's prices or require 237 overrides per farm. The
-- facility asked for manual pricing here, and manual pricing is what a
-- negotiated contract with a per-dispensing drug list actually is.

-- ── The schemes ───────────────────────────────────────────────────────────
create table if not exists schemes (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id),
  code text not null,                             -- SRK, LPL
  name text not null,
  -- The flat consultation fee the contract fixes. Held on the scheme rather
  -- than typed per visit because it is the one price on these sheets that
  -- never varies: 100 at Stokman and 50 at La Pieve, on every one of the 310
  -- August rows.
  consultation_fee_cents integer not null default 0 check (consultation_fee_cents >= 0),
  contact_name text,
  contact_email text,
  contact_phone text,
  active boolean not null default true,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, code)
);
alter table schemes enable row level security;
create policy schemes_site_read on schemes
  for select using (site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'));
create policy schemes_admin_write on schemes
  for all using (has_role(auth.uid(), 'ADMIN')) with check (has_role(auth.uid(), 'ADMIN'));
grant select on schemes to authenticated;

-- ── The cap, dated ────────────────────────────────────────────────────────
-- Not a column on schemes. A cap is a term of a contract that gets
-- renegotiated, and last March's utilisation report has to keep reporting
-- against last March's cap. Overwriting one number would rewrite every report
-- that came before it.
create table if not exists scheme_limits (
  id uuid primary key default gen_random_uuid(),
  scheme_id uuid not null references schemes(id) on delete cascade,
  -- First day of the first month this cap applies to. It stays in force until
  -- a later row supersedes it, so a cap set once needs no maintenance.
  effective_from date not null,
  monthly_cap_cents integer not null check (monthly_cap_cents >= 0),
  note text,
  set_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique (scheme_id, effective_from),
  -- A cap that starts mid-month cannot be compared against a month's spend.
  constraint scheme_limits_starts_on_the_first
    check (effective_from = date_trunc('month', effective_from)::date)
);
alter table scheme_limits enable row level security;
create policy scheme_limits_site_read on scheme_limits
  for select using (exists (
    select 1 from schemes s where s.id = scheme_id
      and (s.site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'))
  ));
create policy scheme_limits_admin_write on scheme_limits
  for all using (has_role(auth.uid(), 'ADMIN')) with check (has_role(auth.uid(), 'ADMIN'));
grant select on scheme_limits to authenticated;

-- ── The members ───────────────────────────────────────────────────────────
-- Mirrors the columns the farms already keep, so their existing register
-- imports without a mapping exercise: employee number, relation, names, DOB,
-- gender, national ID, employment type and dates, mobile.
create table if not exists scheme_members (
  id uuid primary key default gen_random_uuid(),
  scheme_id uuid not null references schemes(id),
  -- The farm's own identifier for the household. Every member of a family
  -- carries the EMPLOYEE's number, which is exactly how the sheets bill:
  -- LP 9883 is Lawrence, Karen, Benedict and Brighter Moseti.
  employee_no text not null,
  -- The individual's own card number where the farm issues one — LPO9836-A.
  -- Distinct from employee_no because dependants share the latter.
  member_no text,
  relation text not null default 'SELF'
    check (relation in ('SELF','SPOUSE','CHILD')),
  -- A, B, C, D on the farms' sheets. Null for the employee and the spouse.
  child_ref text check (child_ref is null or child_ref ~ '^[A-Z]$'),
  -- The clinical record. One person, one patient row, regardless of how the
  -- name was spelled on the day.
  patient_id uuid not null references patients(id),
  full_name text not null,                        -- as the employer records it
  employment_type text check (employment_type in ('PERMANENT','CONTRACT','SEASONAL')),
  employed_on date,
  -- Membership window. Ending a membership never deletes it: last month's
  -- statement must keep explaining why last month's visit was covered.
  covered_from date not null default (now() at time zone 'Africa/Nairobi')::date,
  covered_to date,
  note text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One membership row per person per scheme. The patient is the identity.
  unique (scheme_id, patient_id),
  constraint scheme_members_child_ref_shape check (
    case when relation = 'CHILD' then true else child_ref is null end
  ),
  constraint scheme_members_window_sane check (covered_to is null or covered_to >= covered_from)
);
alter table scheme_members enable row level security;
create policy scheme_members_site_read on scheme_members
  for select using (exists (
    select 1 from schemes s where s.id = scheme_id
      and (s.site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'))
  ));
grant select on scheme_members to authenticated;

create index if not exists scheme_members_employee_idx on scheme_members (scheme_id, employee_no);
create index if not exists scheme_members_patient_idx on scheme_members (patient_id);

-- Exactly one SELF per employee number per scheme. A partial unique index
-- rather than a CHECK, because the rule spans rows.
create unique index if not exists scheme_members_one_employee_per_number
  on scheme_members (scheme_id, employee_no) where relation = 'SELF';

-- ── The charges ───────────────────────────────────────────────────────────
-- One row per visit, holding the farms' four columns. Deliberately NOT
-- invoice_items: an invoice_items row is a snapshot of a catalogue price and
-- is constrained to be one, whereas these are four negotiated buckets, three
-- of which pair a free-text description with a hand-entered amount.
create table if not exists scheme_charges (
  id uuid primary key default gen_random_uuid(),
  scheme_id uuid not null references schemes(id),
  member_id uuid not null references scheme_members(id),
  patient_id uuid not null references patients(id),
  site_id uuid not null references sites(id),
  encounter_id uuid references encounters(id),
  -- Clinic-local, not UTC. At 01:00 in Nairobi a UTC date is still yesterday,
  -- which would file a visit into the previous month's statement.
  service_date date not null default (now() at time zone 'Africa/Nairobi')::date,
  -- The period this charge is billed in, derived once and stored. Deriving it
  -- at query time would let a corrected service_date silently move a charge
  -- out of a statement that has already been sent.
  period date not null,

  consultation_cents integer not null default 0 check (consultation_cents >= 0),
  lab_description text,
  lab_cents integer not null default 0 check (lab_cents >= 0),
  surgical_description text,
  surgical_cents integer not null default 0 check (surgical_cents >= 0),
  pharmacy_description text,
  pharmacy_cents integer not null default 0 check (pharmacy_cents >= 0),

  total_cents integer not null default 0 check (total_cents >= 0),

  -- Set by the server when this charge took the scheme past its monthly cap.
  -- The desk is warned; the charge is still recorded, because a patient in
  -- front of a clinician is not a budgeting problem. The farm approves these
  -- separately, so they are totalled apart on the statement.
  over_limit boolean not null default false,
  -- What the cap and the running total were when this was posted. Kept so an
  -- over_limit flag can be explained months later without replaying the month.
  cap_at_post_cents integer,
  spent_before_cents integer,

  status text not null default 'OPEN'
    check (status in ('OPEN','STATEMENTED','VOID')),
  void_reason text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- THE GAP THIS MODULE EXISTS TO CLOSE. A description without a price is the
  -- blank cell that cost Stokman roughly KES 130,000 in August alone. If work
  -- was recorded, it carries a price; if there was no work, there is no
  -- description. Both directions are enforced, on all three columns.
  constraint scheme_charges_lab_priced check (
    (nullif(btrim(coalesce(lab_description, '')), '') is null) = (lab_cents = 0)
  ),
  constraint scheme_charges_surgical_priced check (
    (nullif(btrim(coalesce(surgical_description, '')), '') is null) = (surgical_cents = 0)
  ),
  constraint scheme_charges_pharmacy_priced check (
    (nullif(btrim(coalesce(pharmacy_description, '')), '') is null) = (pharmacy_cents = 0)
  ),
  -- A visit that charged nothing at all is a data-entry accident, not a visit.
  constraint scheme_charges_not_empty check (
    status = 'VOID' or total_cents > 0
  ),
  constraint scheme_charges_period_is_month check (period = date_trunc('month', period)::date),
  constraint scheme_charges_void_has_reason check (
    status <> 'VOID' or nullif(btrim(coalesce(void_reason, '')), '') is not null
  )
);
alter table scheme_charges enable row level security;
create policy scheme_charges_site_read on scheme_charges
  for select using (site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'));
grant select on scheme_charges to authenticated;

create index if not exists scheme_charges_period_idx on scheme_charges (scheme_id, period, status);
create index if not exists scheme_charges_date_idx on scheme_charges (scheme_id, service_date);
create index if not exists scheme_charges_member_idx on scheme_charges (member_id);

-- Derived, never client-supplied — the same discipline invoices already use.
-- A total the client sends is a total the client can get wrong.
create or replace function trg_scheme_charge_derive()
returns trigger
language plpgsql
as $$
begin
  new.period := date_trunc('month', new.service_date)::date;
  new.total_cents := coalesce(new.consultation_cents, 0)
                   + coalesce(new.lab_cents, 0)
                   + coalesce(new.surgical_cents, 0)
                   + coalesce(new.pharmacy_cents, 0);
  new.updated_at := now();
  return new;
end;
$$;

-- Postgres checks EXECUTE on a trigger function at CREATE TRIGGER time, not
-- when the trigger fires, so closing it here does not stop the trigger below
-- from running for an ordinary signed-in user. It stops it being called
-- directly, which nothing legitimate does.
revoke execute on function trg_scheme_charge_derive() from public, anon, authenticated;

drop trigger if exists trg_scheme_charges_derive on scheme_charges;
create trigger trg_scheme_charges_derive
  before insert or update on scheme_charges
  for each row execute function trg_scheme_charge_derive();

-- ── Statements ────────────────────────────────────────────────────────────
-- The month's invoice to the farm. Issuing one freezes the period: the charges
-- it covers move to STATEMENTED and can no longer be edited, because a
-- document has left the building with those figures on it.
create table if not exists scheme_statements (
  id uuid primary key default gen_random_uuid(),
  scheme_id uuid not null references schemes(id),
  period date not null,
  statement_no text unique,
  status text not null default 'DRAFT' check (status in ('DRAFT','ISSUED','VOID')),
  visits integer not null default 0 check (visits >= 0),
  consultation_cents integer not null default 0 check (consultation_cents >= 0),
  lab_cents integer not null default 0 check (lab_cents >= 0),
  surgical_cents integer not null default 0 check (surgical_cents >= 0),
  pharmacy_cents integer not null default 0 check (pharmacy_cents >= 0),
  total_cents integer not null default 0 check (total_cents >= 0),
  -- The portion the farm has to approve because it fell past the cap.
  over_limit_cents integer not null default 0 check (over_limit_cents >= 0),
  cap_cents integer,
  issued_at timestamptz,
  issued_by uuid references users(id),
  void_reason text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheme_statements_period_is_month check (period = date_trunc('month', period)::date)
);
alter table scheme_statements enable row level security;
create policy scheme_statements_site_read on scheme_statements
  for select using (exists (
    select 1 from schemes s where s.id = scheme_id
      and (s.site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'))
  ));
grant select on scheme_statements to authenticated;

-- One live statement per farm per month. VOID ones are excluded so a mistaken
-- statement can be voided and re-cut, which the unique constraint alone would
-- forbid.
create unique index if not exists scheme_statements_one_live_per_period
  on scheme_statements (scheme_id, period) where status <> 'VOID';

-- Which charges a statement covers. A link table rather than a column on
-- scheme_charges, so a voided statement releases its charges without
-- rewriting them.
create table if not exists scheme_statement_lines (
  statement_id uuid not null references scheme_statements(id) on delete cascade,
  charge_id uuid not null references scheme_charges(id),
  primary key (statement_id, charge_id)
);
alter table scheme_statement_lines enable row level security;
create policy scheme_statement_lines_site_read on scheme_statement_lines
  for select using (exists (
    select 1 from scheme_statements st join schemes s on s.id = st.scheme_id
    where st.id = statement_id
      and (s.site_id in (select site_id from user_sites(auth.uid())) or has_role(auth.uid(), 'AUDITOR'))
  ));
grant select on scheme_statement_lines to authenticated;

-- A charge belongs to at most one live statement. Without this a re-cut could
-- bill the same visit twice.
create unique index if not exists scheme_statement_lines_charge_once
  on scheme_statement_lines (charge_id);

-- ── Counter for statement numbers ────────────────────────────────────────
create table if not exists scheme_statement_counters (
  site_id uuid not null references sites(id),
  period date not null,
  next_seq integer not null default 1,
  primary key (site_id, period)
);
alter table scheme_statement_counters enable row level security;
-- No policy on purpose: the counter is written only by issue_scheme_statement(),
-- which is SECURITY DEFINER and bypasses RLS. RLS with no policies denies every
-- row to anon and authenticated, which is the correct posture here.

-- ── Audit ─────────────────────────────────────────────────────────────────
-- Money moves through these tables, so they get the same append-only audit
-- trail patients and encounters already have. audit_row_change() reads every
-- non-universal field through to_jsonb(...)->>'field' precisely so it can be
-- attached to tables with unrelated column sets; `id` is the PK on all four
-- below, which is the one direct reference it makes.
drop trigger if exists trg_audit_scheme_charges on scheme_charges;
create trigger trg_audit_scheme_charges after insert or update or delete on scheme_charges
  for each row execute function audit_row_change();

drop trigger if exists trg_audit_scheme_members on scheme_members;
create trigger trg_audit_scheme_members after insert or update or delete on scheme_members
  for each row execute function audit_row_change();

drop trigger if exists trg_audit_scheme_limits on scheme_limits;
create trigger trg_audit_scheme_limits after insert or update or delete on scheme_limits
  for each row execute function audit_row_change();

drop trigger if exists trg_audit_scheme_statements on scheme_statements;
create trigger trg_audit_scheme_statements after insert or update or delete on scheme_statements
  for each row execute function audit_row_change();

-- ── Nothing is client-writable ────────────────────────────────────────────
-- Every write below goes through a SECURITY DEFINER RPC in 0031. The grants
-- above are SELECT only, and these revokes make that explicit rather than
-- implicit, including TRUNCATE — which RLS does not police at all, so the
-- grant is the entire control for that verb.
revoke insert, update, delete, truncate on schemes from authenticated, anon;
revoke insert, update, delete, truncate on scheme_limits from authenticated, anon;
revoke insert, update, delete, truncate on scheme_members from authenticated, anon;
revoke insert, update, delete, truncate on scheme_charges from authenticated, anon;
revoke insert, update, delete, truncate on scheme_statements from authenticated, anon;
revoke insert, update, delete, truncate on scheme_statement_lines from authenticated, anon;
revoke all on scheme_statement_counters from authenticated, anon;
