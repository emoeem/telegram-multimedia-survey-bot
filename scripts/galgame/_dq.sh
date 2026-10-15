#!/usr/bin/env bash
# Read-only remote D1 query helper: extracts the JSON payload wrangler prints
# after its npm-notice preamble and pretty-prints the rows.
set -euo pipefail
cd /home/emo/code/telegram-bot
timeout 120 npx wrangler d1 execute DB --remote --json --command "$1" 2>&1 \
  | awk 'f{print} /^\[$/{f=1; print}' \
  | python3 -c '
import sys, json
raw = sys.stdin.read().strip()
if not raw.startswith("["):
    print("NOJSON:", raw[-500:]); sys.exit(0)
data = json.loads(raw)
for block in data:
    if not block.get("success"):
        print("ERR:", json.dumps(block.get("error"), ensure_ascii=False)); continue
    print(json.dumps(block["results"], ensure_ascii=False, indent=1))
'
