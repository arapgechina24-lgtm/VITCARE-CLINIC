#!/bin/zsh
# Drains BOTH integration outboxes. Run every 60s by com.vitcare.drains.
#
# Why one script for two systems: they are two halves of one loop, and a
# prescription stuck in either direction has the same symptom at the counter —
# the pharmacist never sees the script, or the clinician never learns it was
# dispensed. Failing them together makes that one alarm instead of two.
#
# Secrets travel in an Authorization header, never a query string: query
# strings are written to access logs and shell history. Read straight from
# .env.local so there is no second copy to drift.
set -u

get() { awk -F= -v k="$2" '$1==k {sub(/^[^=]*=/,""); print; exit}' "$1"; }

CLINIC_ENV=/Users/arapg/vitcare-clinic/.env.local
TILL_ENV=/Users/arapg/vitcare-pos/.env.local

OUTBOX_SECRET=$(get "$CLINIC_ENV" OUTBOX_DRAIN_SECRET)
STATUS_SECRET=$(get "$TILL_ENV" STATUS_DRAIN_SECRET)

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

# clinic -> till : deliver newly written prescriptions
if [ -n "$OUTBOX_SECRET" ]; then
  out=$(curl -sS --max-time 25 -X POST http://localhost:3001/api/prescriptions/outbox-drain \
        -H "Authorization: Bearer $OUTBOX_SECRET" 2>&1)
  echo "$(stamp) clinic->till  $out"
else
  echo "$(stamp) clinic->till  SKIPPED: OUTBOX_DRAIN_SECRET not set"
fi

# till -> clinic : deliver status changes (priced, dispensed, collected)
if [ -n "$STATUS_SECRET" ]; then
  out=$(curl -sS --max-time 25 -X POST http://localhost:3000/api/prescriptions/status-drain \
        -H "Authorization: Bearer $STATUS_SECRET" 2>&1)
  echo "$(stamp) till->clinic  $out"
else
  echo "$(stamp) till->clinic  SKIPPED: STATUS_DRAIN_SECRET not set"
fi

# clinic -> till, PULL : collect anything the push above could not deliver.
#
# Not a replacement for the push. The push is better when it works — it fires
# on the clinician's action instead of on a timer, and it needs no internet at
# all. But it only works while a clinic process is running HERE, on port 3001,
# and a prescription written on the public clinic while this machine is asleep
# has nothing to push it. Until this ran, the whole loop quietly depended on a
# local dev server that is not part of the deployed design.
#
# Safe to run beside the push: the clinic retires an outbox row only when we
# ack it, and storePrescription is keyed on prescriptionId, so a row that
# arrives both ways is stored once and acked once.
#
# 503 is the not-configured answer (no CLINIC_API_BASE_URL) and is normal on a
# LAN deployment, so it is reported plainly rather than as a failure.
if [ -n "$STATUS_SECRET" ]; then
  out=$(curl -sS --max-time 25 -X POST http://localhost:3000/api/prescriptions/pull \
        -H "Authorization: Bearer $STATUS_SECRET" 2>&1)
  echo "$(stamp) clinic->till(pull)  $out"
else
  echo "$(stamp) clinic->till(pull)  SKIPPED: STATUS_DRAIN_SECRET not set"
fi
