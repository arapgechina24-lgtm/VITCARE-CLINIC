#!/bin/zsh
# Runs the production VITCARE-CLINIC server. Invoked by the com.vitcare.clinic
# LaunchAgent on login/boot and kept alive by launchd. Not for interactive dev
# use — use `npm run dev` for that.
#
# Port 3001. 3000 is the live pharmacy till and must not be disturbed.
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
cd "/Users/arapg/vitcare-clinic"

# Non-blocking config check, same reasoning as the till's: a clinic that
# refuses to boot sees no patients, while one with a half-configured
# integration still registers, triages and consults. Log it and carry on.
if [ -f scripts/verify-migrations.mjs ]; then
  node scripts/verify-migrations.mjs || echo "start-clinic: migration checks FAILED — starting anyway; see above."
fi

exec npx next start --port 3001
