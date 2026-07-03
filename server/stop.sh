#!/usr/bin/env bash
# Stop the patch-fixer daemon on the Beelink.
pkill -f 'node .*patch-fixer.mjs' 2>/dev/null && echo "[patch-fixer] stopped" || echo "[patch-fixer] was not running"
