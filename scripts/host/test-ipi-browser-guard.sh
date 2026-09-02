#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/ipi-browser-guard.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

TEST_HOME="$TEST_ROOT/home"
NSS_DIR="$TEST_HOME/.pki/nssdb"
mkdir -p "$NSS_DIR"
cat >"$NSS_DIR/pkcs11.txt" <<'EOF'
library=
name=NSS Internal PKCS #11 Module
parameters=configdir='sql:/tmp/example' certPrefix='' keyPrefix='' secmod='secmod.db'
NSS=Flags=internal,critical trustOrder=75 cipherOrder=100

library=/usr/lib/example/opensc-pkcs11.so
name=OpenSC smartcard framework (test)

EOF

if "$GUARD" status --home "$TEST_HOME" >/dev/null 2>&1; then
  printf 'expected unprotected status to fail\n' >&2
  exit 1
fi

"$GUARD" apply --home "$TEST_HOME" --force >/dev/null
! grep -qi opensc "$NSS_DIR/pkcs11.txt"
grep -Eqi '^Hidden=true$' "$TEST_HOME/.config/autostart/pkcs11-register.desktop"
grep -Eqi '^X-IPI-Managed=true$' "$TEST_HOME/.config/autostart/pkcs11-register.desktop"
"$GUARD" status --home "$TEST_HOME" >/dev/null

backup_count="$(find "$NSS_DIR" -maxdepth 1 -type f -name 'pkcs11.txt.ipi-browser-guard.bak-*' | wc -l)"
"$GUARD" apply --home "$TEST_HOME" --force >/dev/null
[[ "$(find "$NSS_DIR" -maxdepth 1 -type f -name 'pkcs11.txt.ipi-browser-guard.bak-*' | wc -l)" -eq "$backup_count" ]]

"$GUARD" restore --home "$TEST_HOME" --force >/dev/null
grep -qi opensc "$NSS_DIR/pkcs11.txt"
[[ ! -e "$TEST_HOME/.config/autostart/pkcs11-register.desktop" ]]

printf 'ipi-browser-guard tests passed\n'
