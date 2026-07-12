#!/usr/bin/env bash
#
# check-decrypt-confined.sh — ADR-003 §D3 decrypt-confinement CI guard.
#
# The shared credential decrypt primitive (`server/crypto.ts` `decrypt`) may be
# IMPORTED only by the credential broker (`db-crypto-provider.ts`) and by rekey /
# migration scripts under `scripts/`. Every other credential-secret decryption
# must route through the broker (accessSecret / getSecretValue) so the single
# sanctioned decrypt site stays auditable.
#
# Scope note: the federation subsystem (`federation/encryption.ts`) and the
# trigger-secret subsystem (`services/trigger-crypto.ts`) have their OWN, separate
# encryption and are NOT credential secrets — this guard matches only IMPORTS of
# `decrypt` from a `crypto` module, so those are correctly out of scope.
set -euo pipefail

cd "$(dirname "$0")/.."

# Path fragments allowed to import the crypto decrypt primitive.
ALLOW_RE='(server/credentials/db-crypto-provider\.ts|scripts/)'

violations="$(
  grep -rnE --include='*.ts' \
    "import[^;]*\bdecrypt\b[^;]*from[^;]*['\"][^'\"]*crypto" \
    server shared scripts 2>/dev/null \
    | grep -vE '\.test\.' \
    | grep -vE "$ALLOW_RE" \
    || true
)"

if [ -n "$violations" ]; then
  echo "ERROR: the crypto decrypt primitive is imported outside the credential broker (ADR-003 §D3)." >&2
  echo "Route credential-secret decryption through the broker (accessSecret / getSecretValue)." >&2
  echo "Offending imports:" >&2
  echo "$violations" >&2
  exit 1
fi

echo "decrypt-confinement OK: crypto.decrypt is imported only by the credential broker."
