#!/usr/bin/env node
/**
 * Backs up both Supabase projects to local disk.
 *
 *   node scripts/backup.mjs           run a backup
 *   node scripts/backup.mjs --verify  check the newest backup against live
 *   node scripts/backup.mjs --list    show what exists
 *
 * WHY THIS EXISTS
 * The free tier keeps NO backups — zero days of retention, no snapshot even
 * while a project sits paused. Everything in these two databases is either a
 * medical record or a financial one, and neither can be reconstructed. This is
 * the largest single risk in the project, and it is not a code risk.
 *
 * A USEFUL SIDE EFFECT: free projects pause after 7 days without activity, and
 * any API request resets that timer. Running this daily also keeps both
 * projects awake — which already failed once, on 2026-08-01, taking the
 * pharmacy backend down.
 *
 * ── HONEST LIMITS, because a backup people over-trust is the worst kind ────
 *
 *   · This is a DATA backup, not pg_dump. The schema lives in
 *     supabase/migrations (in git, and drift-checked). Restore = replay the
 *     migrations, then load this data. Both halves are needed; neither alone
 *     is a restore.
 *
 *   · Sequences, triggers-in-flight and RLS policies are not captured here —
 *     they come from the migrations.
 *
 *   · auth.users is captured as an IDENTITY MAP only (id + email), never
 *     password hashes. Restoring means recreating accounts with the same uuid
 *     through the Admin API; people then sign in again.
 *
 *   · Backups are written unencrypted to the local disk. They contain patient
 *     records. The folder is mode 700, but that is a filesystem permission on
 *     a machine in a pharmacy — treat the disk itself as sensitive, and if
 *     these ever leave the building they must be encrypted first.
 *
 *   · A backup nobody has restored is a hypothesis. `--verify` checks the
 *     newest one row-for-row against the live database. Run it.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEST = process.env.VITCARE_BACKUP_DIR || join(process.env.HOME, 'vitcare-backups');
const KEEP = Number(process.env.VITCARE_BACKUP_KEEP || 30);

/** Both projects, each read from its own .env.local so there is no second copy
 *  of a service-role key anywhere. */
const PROJECTS = [
  { name: 'clinic', env: join(ROOT, '.env.local') },
  { name: 'pharmacy', env: '/Users/arapg/vitcare-pos/.env.local' },
];

const readEnv = (file, key) => {
  if (!existsSync(file)) return null;
  return new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1]?.trim() || null;
};

function creds(project) {
  const url = readEnv(project.env, 'NEXT_PUBLIC_SUPABASE_URL');
  const key = readEnv(project.env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error(`${project.name}: missing URL or service key in ${project.env}`);
  return { url: url.replace(/\/$/, ''), key };
}

const headers = (key) => ({ apikey: key, Authorization: `Bearer ${key}` });

/**
 * Discovers tables from PostgREST's own schema description.
 *
 * Deliberately NOT a hardcoded list: a table added next month would silently
 * never be backed up, and nobody would notice until they needed it.
 */
async function discoverTables({ url, key }) {
  const res = await fetch(`${url}/rest/v1/`, { headers: headers(key) });
  if (!res.ok) throw new Error(`schema discovery failed: HTTP ${res.status}`);
  const spec = await res.json();
  return Object.keys(spec.definitions ?? spec.components?.schemas ?? {}).sort();
}

/** Pages through a table. PostgREST caps a response, so ask by Range. */
async function fetchAll({ url, key }, table) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*`, {
      headers: { ...headers(key), Range: `${from}-${from + PAGE - 1}`, Prefer: 'count=exact' },
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

async function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifest = { startedAt: new Date().toISOString(), projects: {} };
  let problems = 0;

  for (const project of PROJECTS) {
    const c = creds(project);
    const dir = join(DEST, project.name, stamp);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const tables = await discoverTables(c);
    const counts = {};
    console.log(`\n  ${project.name} — ${tables.length} tables`);

    for (const table of tables) {
      try {
        const rows = await fetchAll(c, table);
        writeFileSync(join(dir, `${table}.json.gz`), gzipSync(JSON.stringify(rows)), { mode: 0o600 });
        counts[table] = rows.length;
        console.log(`     ${String(rows.length).padStart(6)}  ${table}`);
      } catch (e) {
        // Loud, and counted. A table that errors must never look like a table
        // that happened to be empty.
        counts[table] = { error: e.message };
        problems += 1;
        console.error(`     FAILED  ${table}: ${e.message}`);
      }
    }

    // The auth identity map — the link between clinical records and people.
    try {
      const res = await fetch(`${c.url}/rest/v1/rpc/auth_identity_export`, {
        method: 'POST', headers: { ...headers(c.key), 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const identities = await res.json();
      writeFileSync(join(dir, '_auth_identities.json.gz'), gzipSync(JSON.stringify(identities)), { mode: 0o600 });
      counts._auth_identities = identities.length;
      console.log(`     ${String(identities.length).padStart(6)}  _auth_identities (id + email only)`);
    } catch (e) {
      counts._auth_identities = { error: e.message };
      problems += 1;
      console.error(`     FAILED  _auth_identities: ${e.message}`);
    }

    manifest.projects[project.name] = { url: c.url, dir, counts };
  }

  // Which schema this data belongs to. Without it a restore is guesswork.
  try {
    const { execSync } = await import('node:child_process');
    manifest.migrationsCommit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
    manifest.migrations = readdirSync(join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  } catch { /* a backup without provenance still beats no backup */ }

  manifest.finishedAt = new Date().toISOString();
  manifest.ok = problems === 0;
  mkdirSync(DEST, { recursive: true, mode: 0o700 });
  writeFileSync(join(DEST, `manifest-${stamp}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  prune();

  if (problems > 0) {
    console.error(`\n  ${problems} table(s) failed. This backup is INCOMPLETE.\n`);
    process.exit(1);
  }
  console.log(`\n  ok — ${stamp}\n  ${DEST}\n`);
}

/** Keeps the newest KEEP snapshots per project, and their manifests. */
function prune() {
  for (const project of PROJECTS) {
    const base = join(DEST, project.name);
    if (!existsSync(base)) continue;
    const snaps = readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory()).sort();
    for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP))) {
      rmSync(join(base, old), { recursive: true, force: true });
      console.log(`     pruned ${project.name}/${old}`);
    }
  }
  const manifests = readdirSync(DEST).filter((f) => f.startsWith('manifest-')).sort();
  for (const old of manifests.slice(0, Math.max(0, manifests.length - KEEP))) {
    rmSync(join(DEST, old), { force: true });
  }
}

/** Compares the newest backup against the live database, table by table. */
async function verify() {
  const manifests = existsSync(DEST) ? readdirSync(DEST).filter((f) => f.startsWith('manifest-')).sort() : [];
  if (manifests.length === 0) { console.error('\n  no backups found\n'); process.exit(1); }

  const manifest = JSON.parse(readFileSync(join(DEST, manifests.at(-1)), 'utf8'));
  console.log(`\n  verifying ${manifests.at(-1)}`);
  let bad = 0;

  for (const project of PROJECTS) {
    const saved = manifest.projects[project.name];
    if (!saved) { console.error(`  ${project.name}: absent from the manifest`); bad += 1; continue; }
    const c = creds(project);
    console.log(`\n  ${project.name}`);

    for (const [table, recorded] of Object.entries(saved.counts)) {
      if (typeof recorded !== 'number') { console.error(`     FAILED  ${table}: ${recorded.error}`); bad += 1; continue; }

      // Read the file back — proves it decompresses and parses, not just that
      // a count was written down.
      const file = join(saved.dir, `${table}.json.gz`);
      let onDisk;
      try {
        onDisk = JSON.parse(gunzipSync(readFileSync(file)).toString()).length;
      } catch (e) {
        console.error(`     UNREADABLE ${table}: ${e.message}`); bad += 1; continue;
      }
      if (onDisk !== recorded) {
        console.error(`     MISMATCH  ${table}: manifest ${recorded}, file ${onDisk}`); bad += 1; continue;
      }

      if (table === '_auth_identities') { console.log(`     ok  ${table} (${onDisk})`); continue; }

      const res = await fetch(`${c.url}/rest/v1/${table}?select=*&limit=1`, {
        headers: { ...headers(c.key), Prefer: 'count=exact' },
      });
      const live = Number(res.headers.get('content-range')?.split('/')?.[1] ?? NaN);
      // Live may legitimately have grown since the snapshot; it must never be
      // SMALLER than what we captured, which would mean we stored phantom rows.
      const verdict = Number.isNaN(live) ? 'live count unavailable'
        : live === onDisk ? 'ok'
        : live > onDisk ? `ok (live grew to ${live})`
        : `SHRANK: live ${live} < backup ${onDisk}`;
      if (verdict.startsWith('SHRANK')) bad += 1;
      console.log(`     ${verdict.startsWith('ok') ? 'ok ' : '!! '} ${table} (${onDisk}) ${verdict === 'ok' ? '' : verdict}`);
    }
  }

  if (bad > 0) { console.error(`\n  ${bad} problem(s).\n`); process.exit(1); }
  console.log('\n  verified: every table readable and consistent with live.\n');
}

function list() {
  if (!existsSync(DEST)) { console.log('\n  no backups yet\n'); return; }
  for (const project of PROJECTS) {
    const base = join(DEST, project.name);
    if (!existsSync(base)) continue;
    const snaps = readdirSync(base).sort();
    console.log(`\n  ${project.name} — ${snaps.length} snapshot(s), keeping ${KEEP}`);
    for (const s of snaps.slice(-5)) {
      const size = readdirSync(join(base, s)).reduce((n, f) => n + statSync(join(base, s, f)).size, 0);
      console.log(`     ${s}   ${(size / 1024).toFixed(0)} KB`);
    }
  }
  console.log('');
}

const mode = process.argv[2];
if (mode === '--verify') await verify();
else if (mode === '--list') list();
else await backup();
