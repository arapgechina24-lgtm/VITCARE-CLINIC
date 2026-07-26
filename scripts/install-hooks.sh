#!/bin/sh
# Run once after cloning: wires scripts/check-rls.mjs as a git pre-commit hook
# so a migration adding a table without RLS can't be committed at all.
set -e
cd "$(dirname "$0")/.."
mkdir -p .git/hooks
cat > .git/hooks/pre-commit <<'HOOK'
#!/bin/sh
node scripts/check-rls.mjs || exit 1
HOOK
chmod +x .git/hooks/pre-commit
echo "Installed pre-commit RLS check at .git/hooks/pre-commit"
