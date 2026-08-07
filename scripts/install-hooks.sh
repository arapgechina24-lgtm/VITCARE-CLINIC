#!/bin/sh
# Run once after cloning: wires the Phase 0 guardrails as a git pre-commit hook,
# so neither a table without RLS nor a broken prescription-integration contract
# can be committed at all.
set -e
cd "$(dirname "$0")/.."
mkdir -p .git/hooks
cat > .git/hooks/pre-commit <<'HOOK'
#!/bin/sh
# Git may run hooks with a bare PATH (GUI clients, some editors), where nvm's
# shims are absent and `node` simply isn't found — which used to abort the
# commit with a confusing "command not found" rather than a real check result.
# Fall back to the nvm install the rest of this machine uses.
if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$candidate/node" ] && PATH="$candidate:$PATH" && export PATH && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "pre-commit: node not found on PATH; cannot run the RLS or contract checks." >&2
  exit 1
fi

node scripts/check-rls.mjs || exit 1

# Migrations are pasted BY HAND into a SQL editor — there is no CI step between
# this repo and the clinical database, so the syntax gate has to live here.
# Only staged .sql files are checked, which keeps it well under a second; run
# `node scripts/check-sql.mjs` with no arguments to sweep all of them.
STAGED_SQL=$(git diff --cached --name-only --diff-filter=ACM | grep "^supabase/migrations/.*\.sql$" || true)
if [ -n "$STAGED_SQL" ]; then
  PREFIXES=$(echo "$STAGED_SQL" | sed "s|.*/||" | cut -c1-4 | tr "\n" " ")
  # shellcheck disable=SC2086
  node scripts/check-sql.mjs $PREFIXES || {
    echo "pre-commit: a staged migration failed validation — it would not apply." >&2
    exit 1
  }
fi

# The prescription contract is the one piece of code both systems depend on,
# and the webhook receiver is reachable without a staff session — so its
# signature/replay/state-machine tests gate every commit too. ~1s to run.
npx --no-install tsx --test "src/**/*.test.ts" >/dev/null 2>&1 || {
  echo "pre-commit: integration contract tests failed. Run 'npm test' to see why." >&2
  exit 1
}
echo "pre-commit: RLS + SQL + contract tests passed."
HOOK
chmod +x .git/hooks/pre-commit
echo "Installed pre-commit checks (RLS + SQL syntax + contract tests) at .git/hooks/pre-commit"
