#!/usr/bin/env bash
# Canonical shutdown dispatcher; each service owns its process and state cleanup.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"
status=0

stop_service() {
  local name="$1"
  shift
  if "$@"; then
    echo "$name shutdown checked"
  else
    echo "$name failed to stop" >&2
    status=1
  fi
}

stop_services() {
  # Stop work producers before their transports and model services.
  stop_service "Terminal sessions" "$REPO_ROOT/bin/mh" terminal stop
  stop_service "Agents" "$REPO_ROOT/bin/mh" agent stop --all
  stop_service "llama.cpp" "$REPO_ROOT/bin/llama-cpp-services" stop
  stop_service "Local models" "$REPO_ROOT/bin/stop-local-models"
  stop_service "Voice services" "$REPO_ROOT/bin/stop-voice-server"
  stop_service "Cloudflare tunnel" node --import tsx --input-type=module -e '
import { stopTunnel } from "./packages/core/src/cloudflare-tunnel.ts";
if (!await stopTunnel()) process.exitCode = 1;
'
  stop_service "Event bus" "$REPO_ROOT/bin/stop-event-bus"
}

process_running() {
  kill -0 "$1" 2>/dev/null || return 1
  local state
  state="$(ps -o stat= -p "$1")" || return 1
  [[ "$state" != Z* ]]
}

stop_application_pid() {
  local pid="$1"
  local signal attempt
  for signal in TERM KILL; do
    process_running "$pid" || return 0
    kill "-$signal" "$pid" || return 1
    for attempt in {1..50}; do
      process_running "$pid" || return 0
      sleep 0.1
    done
  done
  echo "Application process $pid has not stopped" >&2
  return 1
}

stop_application() {
  local launcher_file="$REPO_ROOT/logs/run/web-launcher.pid"
  local pid command cwd matches code attempt launcher_pid=""
  if [ -f "$launcher_file" ]; then
    pid="$(cat "$launcher_file")"
    command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ && "$command" == *"$REPO_ROOT/start.sh"* ]]; then
      # The launcher cancels unfinished starts and releases its web child.
      # This dispatcher remains the sole caller of service shutdown.
      kill -USR2 "$pid" || status=1
      launcher_pid="$pid"
    fi
  fi
  if [ -n "$launcher_pid" ]; then
    # Do not send TERM as well: it can arrive before the launcher handles USR2.
    for attempt in {1..50}; do
      process_running "$launcher_pid" || break
      sleep 0.1
    done
    if process_running "$launcher_pid"; then stop_application_pid "$launcher_pid" || status=1; fi
  fi
  # Let the application-only signal finish before PM2 sends its own stop signal.
  if command -v pm2 >/dev/null 2>&1 && pm2 describe metahuman-os >/dev/null 2>&1; then
    pm2 delete metahuman-os || status=1
  fi
  # The application owner also handles directly launched Astro dev servers and
  # production children whose launcher exited. Service processes are excluded.
  code=0
  matches="$(pgrep -f -- 'astro/astro.js.*dev|astro/bin/astro.js.*dev|apps/site/(dist|build/releases/[^/]+)/server/entry.mjs')" || code=$?
  if [ "$code" -gt 1 ]; then
    echo "Application process lookup failed" >&2
    status=1
    return
  fi
  while read -r pid; do
    [ -n "$pid" ] || continue
    command="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ "$command" == *"$REPO_ROOT/"* || "$cwd" == "$REPO_ROOT/apps/site" ]]; then
      stop_application_pid "$pid" || status=1
    fi
  done <<< "$matches"
}

case "${1:-}" in
  --services-only) stop_services ;;
  "")
    stop_application
    stop_services
    ;;
  *) echo "Usage: ./stop.sh [--services-only]" >&2; exit 2 ;;
esac
if [ "$status" -eq 0 ]; then echo "MetaHuman shutdown complete"; else echo "MetaHuman shutdown incomplete" >&2; fi
exit "$status"
