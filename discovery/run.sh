#!/bin/sh
# Runs the Claude discovery job on a loop. Configure with environment variables:
#   PRICEWATCH_URL, PRICEWATCH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN,
#   DISCOVERY_REGION (default "New Zealand"), DISCOVERY_INTERVAL_HOURS (default 24),
#   DISCOVERY_MODEL (optional, e.g. a cheaper model name)
set -eu

: "${PRICEWATCH_URL:?PRICEWATCH_URL is required}"
: "${PRICEWATCH_TOKEN:?PRICEWATCH_TOKEN is required}"
: "${CLAUDE_CODE_OAUTH_TOKEN:?CLAUDE_CODE_OAUTH_TOKEN is required (run: claude setup-token)}"
REGION="${DISCOVERY_REGION:-New Zealand}"
HOURS="${DISCOVERY_INTERVAL_HOURS:-24}"
DIR="$(cd "$(dirname "$0")" && pwd)"

run_once() {
  echo "$(date -u +%FT%TZ) discovery: starting"
  PROMPT="$(sed "s/__REGION__/${REGION}/g" "$DIR/prompt.md")"
  set -- -p "$PROMPT" --allowedTools "WebSearch,WebFetch,Bash(pw:*)" --output-format text
  if [ -n "${DISCOVERY_MODEL:-}" ]; then set -- "$@" --model "$DISCOVERY_MODEL"; fi
  claude "$@" || echo "$(date -u +%FT%TZ) discovery: run failed"
  echo "$(date -u +%FT%TZ) discovery: done"
}

if [ "${1:-}" = "--once" ]; then
  run_once
  exit 0
fi

while true; do
  run_once
  sleep "$((HOURS * 3600))"
done
