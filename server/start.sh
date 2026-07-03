#!/usr/bin/env bash
# Start the patch-fixer daemon on the Beelink (idempotent). Mirrors Port's launch.
set -e
cd "$(dirname "$0")"
pkill -f 'node .*patch-fixer.mjs' 2>/dev/null || true
for i in $(seq 1 50); do pgrep -f 'node .*patch-fixer.mjs' >/dev/null || break; sleep 0.2; done
set -a; . ./patch-fixer.env; set +a
nohup node patch-fixer.mjs >> patchfix.log 2>&1 &
sleep 2
if pgrep -f 'node .*patch-fixer.mjs' >/dev/null; then
  echo "[patch-fixer] up (pid $(pgrep -f 'node .*patch-fixer.mjs' | head -1)). ENABLED=${ENABLED}"
else
  echo "[patch-fixer] ERROR: failed to start — see patchfix.log"; tail -5 patchfix.log
fi
