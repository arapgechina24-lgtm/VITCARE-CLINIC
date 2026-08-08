# Rotating the clinic's service-role key

The service-role key bypasses RLS on every table in the project. Treat any
exposure — a chat log, a screenshot, a pasted snippet, a departing
administrator — as a reason to rotate.

## Do NOT "reset the JWT secret"

The dashboard offers that, and it is the wrong tool here. Resetting the JWT
secret regenerates the **anon key and the service-role key together** and
**invalidates every issued token** — all 12 staff signed out mid-shift, and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` needing an update everywhere at the same time.
That is a big, simultaneous, error-prone change to fix a problem with one
credential.

This project already has modern keys enabled (`sb_publishable_…` exists
alongside the legacy anon JWT), so the surgical path is available:
**create a new secret key, cut over, then disable the old one.**

## Order matters

Install the new key *before* disabling the old one. Disabling first leaves a
gap where the webhook receiver, the outbox drain and the backup are all broken
at once.

### 1. Create the new key

[Settings → API Keys](https://supabase.com/dashboard/project/xbllbyebzgnhyslhbwrz/settings/api-keys)
→ **Create new secret key**. Name it something datable, e.g. `service-2026-08`.
You will see the value once.

### 2. Install it — yourself

```
 cd ~/vitcare-clinic && node scripts/set-service-key.mjs '<paste>'
```

**Run this in your own terminal, with the leading space** (keeps it out of
shell history). Do not paste the key into a chat window, an issue, or a
commit — that is what you are rotating to undo.

The script verifies the key belongs to *this* project and actually carries
service-role privilege before writing anything, then sets the file to mode 600.

### 3. Restart — the file is not the process

launchd read `.env.local` when the service started. Changing the file changes
nothing until you restart:

```
launchctl unload ~/Library/LaunchAgents/com.vitcare.clinic.plist
launchctl load   ~/Library/LaunchAgents/com.vitcare.clinic.plist
```

Skipping this is the classic failure: every script passes, the file is
correct, and only the live webhook receiver and drain are broken — which
nobody notices until a prescription fails to arrive.

### 4. Verify before disabling anything

```
npm run key:check
```

It exercises every service-key path and, crucially, tells the difference
between *"the key on disk is wrong"* and *"the key is fine but the running
process is stale"*.

Also confirm the backup still works, since it uses the same key:

```
npm run db:backup && npm run db:backup:verify
```

### 5. Now disable the old key

Back in **Settings → API Keys**, disable the legacy `service_role` JWT.
Then re-run `npm run key:check` — everything should still pass, which proves
nothing was quietly still using the old credential.

### 6. If something breaks

Re-enable the legacy key in the dashboard. It is a toggle, not a deletion, so
the rollback is immediate.

## The pharmacy project is separate

`~/vitcare-pos` uses a **different** key for a **different** project
(`gvdyewecupdnmxywnnmj`), already a modern `sb_secret_…`. Rotating the clinic's
key has no effect on it. If that one ever needs rotating, the same steps apply
against the pharmacy project with the till's `.env.local`, followed by
`launchctl` on `com.vitcare.pos.plist`.
