-- VITCARE-CLINIC — the two flower farms
-- ---------------------------------------------------------------------------
-- Consultation fees are read straight off the farms' own August 2026 daily
-- sales sheets, where they are the one figure that never varies: 100 on all
-- 173 Stokman rows, 50 on all 137 La Pieve rows. They are held on the scheme
-- rather than typed per visit for that reason.
--
-- No monthly cap is seeded. The ceiling is a term of each contract, and
-- inventing one here — even a generous one — would put a number on a screen
-- that finance never agreed to, which is worse than an honest blank. Until it
-- is set from Settings, the tracker reads "no limit set" and nothing is
-- flagged; post_scheme_charge treats a null cap as "no ceiling" rather than
-- as zero, precisely so an unset limit does not flag every visit and train the
-- desk to ignore the warning.
--
-- No members are seeded either. The employers' registers need reconciling
-- before they become the entitlement list the desk treats people from: of the
-- 173 Stokman visits in August, 54 are against payroll numbers that appear
-- nowhere in the register the employer supplied, and that register was last
-- revised in 2021. Loading it as-is would encode the discrepancy rather than
-- surface it.
--
-- created_by is resolved rather than hardcoded: the seed must not carry a
-- particular administrator's id into a database it did not come from.

insert into schemes (site_id, code, name, consultation_fee_cents, created_by)
select s.id, v.code, v.name, v.fee,
       (select u.id from users u
         join user_site_memberships m on m.user_id = u.id
        where m.site_id = s.id and u.role = 'ADMIN' and u.active
        order by u.created_at limit 1)
from sites s
cross join (values
  ('SRK', 'Stokman Rozen Kenya Ltd', 10000),
  ('LPL', 'La Pieve Ltd',             5000)
) as v(code, name, fee)
-- Replaying this must not reset a fee the facility has since renegotiated.
on conflict (site_id, code) do nothing;
