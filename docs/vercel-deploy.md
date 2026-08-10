# Deploying the clinic to Vercel

The Mac is the system of record. The Vercel deployment is a **read-anywhere
copy** — it holds no secrets, its integration routes fail closed, and the
Mac's launchd drains do all machine-to-machine work. Nothing here changes
that.

```sh
cd ~/vitcare-clinic
npx --yes vercel@latest deploy --prod --yes
```

## The git author must be a Vercel team member

This is the one that will waste your afternoon, because the failure is silent
and the CLI never says why.

Vercel reads the **git author of the deployed commit** and refuses to build
if that author is not a member of the team. On 2026-08-10 two deployments sat
at status `UNKNOWN` for 25 minutes with a 0 ms build and **no build logs at
all**. The CLI printed `Building…` and nothing else. The real state was only
visible through the API:

```
readyState:       BLOCKED
readyStateReason: Git author arapg@ARAPs-MacBook-Pro.local must have access
                  to the team MOJEZ on Vercel to create deployments.
seatBlock:        { blockCode: 'TEAM_ACCESS_REQUIRED' }
```

The cause was mundane: `user.email` was never set — not globally, not in the
repo — so git generated `arapg@<hostname>.local` from the machine name, and
every commit carried an address Vercel had never heard of.

Both repos now pin the identity locally:

```sh
git config user.name  "ARAP GECHINA"
git config user.email "arapgechina25@gmail.com"   # the VERCEL account address
```

Note this is deliberately the **Vercel** account address
(`arapgechina25@gmail.com`), which is not the same address used elsewhere on
this machine. If the Vercel account ever changes, this has to change with it.

### Diagnosing it again

`vercel ls` and `vercel inspect` both report `UNKNOWN`, which tells you
nothing. Ask the API directly:

```sh
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/com.vercel.cli/auth.json'))['token'])")
curl -s "https://api.vercel.com/v13/deployments/<dpl_id>?teamId=<team_id>" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | grep -iE "readyState|reason|block"
```

`BLOCKED` means the platform refused it before building — a permissions or
account condition, never your code. Distinguish it from `ERROR`, which means
the build ran and failed, and does come with logs.

## Two more things that have bitten this project

**Pin the CLI.** A cached `npx vercel` resolved to 55.0.0 and hung without
output; `npx --yes vercel@latest` (58.9.0) behaved correctly. Always pin.

**`.vercelignore` patterns must be ANCHORED.** An unanchored `supabase/` also
matches `src/lib/supabase/`, which silently strips the Supabase client from
the upload and fails the build with 19 module-not-found errors. Use
`/supabase/`.

## Environment

Production carries exactly two variables, both public:

| Variable | Why it is safe |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The `sb_publishable_…` key shipped to every browser anyway |

**Never add `SUPABASE_SERVICE_ROLE_KEY`, `POS_SIGNING_SECRET`, or
`OUTBOX_DRAIN_SECRET` here.** The cloud copy is not supposed to be able to
sign a prescription or drain an outbox; those live only on the Mac.

`src/lib/env.ts` validates configuration at boot and only *requires* those two
values, precisely so this secretless deployment still starts. There is a test
pinning that (`the secretless Vercel deployment still boots`) — if someone
makes a secret mandatory, it fails there rather than at 3am on Vercel.
