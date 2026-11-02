#!/usr/bin/env bash
# Run this script with the user's active bash environment.

set -euo pipefail
# Stop on command errors, unset variables, and failed pipeline commands.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve the absolute directory containing this script.
REPO_ROOT="$SCRIPT_DIR"
# Treat the script directory as the MetaHuman repository root.
SERVER_ENTRY="$REPO_ROOT/apps/site/dist/server/entry.mjs"
RUNTIME_CHECK="$REPO_ROOT/apps/site/dist/server/check-runtime.mjs"
# Point to the prebuilt Astro/Node production server entrypoint.
NODE_VERSION_FILE="$REPO_ROOT/.nvmrc"
# Pin the supported Node.js line for interactive and desktop launches.
NODE_VERSION_CHECK="$REPO_ROOT/scripts/check-node-runtime.mjs"
# Keep the executable runtime check shared with pnpm installs and CI.
LOG_DIR="$REPO_ROOT/logs"
# Store general runtime logs under logs/.
RUN_LOG_DIR="$LOG_DIR/run"
# Store launcher and PID-style runtime logs under logs/run/.
START_LOCK_FILE="$RUN_LOG_DIR/start.lock"
# Prevent overlapping launcher instances with a kernel lock that survives PID namespaces.
START_LOCK_FD=9
# Keep the lock on a dedicated file descriptor for the lifetime of this launcher.
SERVER_LOG="$LOG_DIR/server.log"
# Mirror web server output into this file for the in-app service console.
STARTED=false
# Track whether this script has started services and should clean them up.
CLEANING_UP=false
# Prevent the shutdown handler from running more than once.
START_LOCK_HELD=false
# Track whether this launcher owns the startup lock.
APP_ONLY=false
APP_RESTART=false
WEB_PID=""
SERVICES_PID=""
LAUNCHER_PID_FILE="$RUN_LOG_DIR/web-launcher.pid"
LAUNCH_MODE="${1:-}"
case "$LAUNCH_MODE" in
  ""|--restart-app) ;;
  --app-only) APP_ONLY=true ;;
  *) echo "Usage: ./start.sh [--app-only|--restart-app]" >&2; exit 2 ;;
esac

RED='\033[0;31m'
# Terminal color for errors.
GREEN='\033[0;32m'
# Terminal color for success/status messages.
YELLOW='\033[1;33m'
# Terminal color for warnings.
BLUE='\033[0;34m'
# Terminal color for the startup banner.
NC='\033[0m'
# Reset terminal color.

print_status() {
  # Print a successful status line.
  echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
  # Print a warning status line.
  echo -e "${YELLOW}!${NC} $1"
}

print_error() {
  # Print an error status line.
  echo -e "${RED}✗${NC} $1"
}

command_exists() {
  # Return success when the named executable is available on PATH.
  command -v "$1" >/dev/null 2>&1
}

append_csv_setting() {
  local current="$1"
  local value="$2"

  case ",$current," in
    *,"$value",*) printf '%s' "$current" ;;
    *,) printf '%s' "$value" ;;
    *) printf '%s,%s' "$current" "$value" ;;
  esac
}

configure_exposure_mode() {
  local tunnel_config="$REPO_ROOT/etc/cloudflare.json"
  local tunnel_hostname=""

  if [ -z "${MH_EXPOSURE_MODE+x}" ] && [ -r "$tunnel_config" ]; then
    tunnel_hostname="$(
      node -e '
        const fs = require("node:fs")
        try {
          const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
          const hostname = String(config.hostname || "").trim().toLowerCase()
          if (
            config.enabled === true
            && config.autoStart === true
            && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?$/.test(hostname)
          ) process.stdout.write(hostname)
        } catch {}
      ' "$tunnel_config"
    )"
  fi

  if [ -n "$tunnel_hostname" ]; then
    export MH_EXPOSURE_MODE="shared"
    export MH_EXPOSURE_SOURCE="cloudflare-tunnel"
    export HOST="${HOST:-127.0.0.1}"
    export MH_ALLOWED_HOSTS
    MH_ALLOWED_HOSTS="$(append_csv_setting "${MH_ALLOWED_HOSTS:-}" "$tunnel_hostname")"
    export MH_ALLOWED_ORIGINS
    MH_ALLOWED_ORIGINS="$(append_csv_setting "${MH_ALLOWED_ORIGINS:-}" "https://$tunnel_hostname")"
    print_warning "Cloudflare tunnel enabled; shared request mode is active on the loopback listener"
    return
  fi

  export MH_EXPOSURE_MODE="${MH_EXPOSURE_MODE:-local}"
  if [ "$MH_EXPOSURE_MODE" = "shared" ]; then
    export HOST="${HOST:-0.0.0.0}"
    print_warning "Shared exposure mode enabled; configure MH_ALLOWED_HOSTS and MH_ALLOWED_ORIGINS for browser access"
  else
    export HOST="${HOST:-127.0.0.1}"
  fi
}

activate_repo_node_runtime() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local requested_version=""

  if command_exists node && node "$NODE_VERSION_CHECK" --quiet >/dev/null 2>&1; then
    node "$NODE_VERSION_CHECK"
    return
  fi

  if [ ! -r "$NODE_VERSION_FILE" ]; then
    print_error "Node.js version file is missing: $NODE_VERSION_FILE"
    exit 1
  fi

  requested_version="$(tr -d '[:space:]' < "$NODE_VERSION_FILE")"
  if [ ! -s "$nvm_dir/nvm.sh" ]; then
    print_error "MetaHuman OS requires Node.js >=22.3.0 <23"
    if command_exists node; then
      print_warning "Found $(node --version) at $(command -v node)"
    else
      print_warning "Node.js was not found on PATH"
    fi
    print_warning "Install Node.js $requested_version or install NVM at $nvm_dir"
    exit 1
  fi

  print_warning "Activating MetaHuman OS Node.js $requested_version with NVM"
  set +u
  # shellcheck disable=SC1090
  source "$nvm_dir/nvm.sh"
  set -u

  if ! nvm use --silent "$requested_version" >/dev/null; then
    print_error "Node.js $requested_version is not installed in NVM"
    print_warning "Run: nvm install $requested_version"
    exit 1
  fi

  hash -r
  if ! node "$NODE_VERSION_CHECK"; then
    exit 1
  fi
}

process_command() {
  local pid="$1"

  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true
  fi
}

process_cwd() {
  local pid="$1"

  readlink "/proc/$pid/cwd" 2>/dev/null || true
}

is_repo_process() {
  local pid="$1"
  local cmd=""
  local cwd=""

  [ "$pid" != "$$" ] || return 1

  cmd="$(process_command "$pid")"
  cwd="$(process_cwd "$pid")"

  case "$cmd" in
    *"$REPO_ROOT"*) return 0 ;;
  esac

  case "$cwd" in
    "$REPO_ROOT"|"$REPO_ROOT"/*) return 0 ;;
  esac

  return 1
}

release_start_lock() {
  if [ "$START_LOCK_HELD" != true ]; then
    return
  fi

  flock -u "$START_LOCK_FD" 2>/dev/null || true
  exec 9>&-
  START_LOCK_HELD=false
}

acquire_start_lock() {
  local legacy_pid=""

  if ! command_exists flock; then
    print_error "The flock command is required for safe MetaHuman startup locking"
    exit 1
  fi

  # Migrate the older PID-directory lock only after the HTTP preflight has
  # established that no MetaHuman web server is responding.
  if [ -d "$START_LOCK_FILE" ]; then
    legacy_pid="$(cat "$START_LOCK_FILE/pid" 2>/dev/null || true)"
    if [ -n "$legacy_pid" ]; then
      print_warning "Removing legacy MetaHuman startup lock (recorded PID $legacy_pid)"
    else
      print_warning "Removing legacy MetaHuman startup lock"
    fi
    rm -f "$START_LOCK_FILE/pid"
    if ! rmdir "$START_LOCK_FILE" 2>/dev/null; then
      print_error "Legacy startup lock contains unexpected files: $START_LOCK_FILE"
      exit 1
    fi
  fi

  exec 9>"$START_LOCK_FILE"
  if ! flock -n "$START_LOCK_FD"; then
    exec 9>&-
    print_error "Another MetaHuman OS launcher is starting or running"
    print_warning "Use ./stop.sh before starting another MetaHuman OS launcher"
    exit 1
  fi

  START_LOCK_HELD=true
}

verify_site_runtime() {
  if [ ! -f "$SERVER_ENTRY" ] || [ ! -f "$RUNTIME_CHECK" ]; then
    print_error "A verified production server build is required"
    echo "Run: pnpm --dir apps/site build"
    return 1
  fi
  node "$RUNTIME_CHECK" "$REPO_ROOT"
}

cleanup() {
  if [ "$STARTED" != true ] || [ "$CLEANING_UP" = true ]; then
    release_start_lock
    return
  fi
  CLEANING_UP=true
  trap '' INT TERM HUP USR2
  if [ -n "${SERVICES_PID:-}" ]; then
    local child
    for child in $(jobs -pr); do
      if [ "$child" = "$SERVICES_PID" ]; then kill -TERM "$child" 2>/dev/null || true; fi
    done
    wait "$SERVICES_PID" 2>/dev/null || true
  fi
  if [ -n "${WEB_PID:-}" ]; then
    kill -TERM "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
  if [ -n "${LAUNCHER_PID_FILE:-}" ]; then rm -f "$LAUNCHER_PID_FILE"; fi
  if [ "${APP_ONLY:-false}" = true ]; then
    print_status "MetaHuman application stopped; background services unchanged"
  elif "$REPO_ROOT/stop.sh" --services-only >> "$RUN_LOG_DIR/startup-shutdown.log" 2>&1; then
    print_status "MetaHuman services stopped"
  else
    print_warning "Some MetaHuman services failed to stop. See $RUN_LOG_DIR/startup-shutdown.log"
  fi
  release_start_lock
}

start_background_services() {
  (exec 9>&-; exec "$REPO_ROOT/bin/start-services" --background) &
  SERVICES_PID=$!
}

request_app_restart() {
  verify_site_runtime || return 0
  APP_RESTART=true
  if [ -n "$WEB_PID" ]; then kill -TERM "$WEB_PID"; fi
}

run_web_server() {
  local status=0
  while true; do
    APP_RESTART=false
    (exec 9>&-; exec node "$(readlink -f "$SERVER_ENTRY")") > >(exec 9>&-; tee "$SERVER_LOG") 2>&1 &
    WEB_PID=$!
    status=0
    wait "$WEB_PID" || status=$?
    if [ "$APP_RESTART" != true ]; then return "$status"; fi
    # A trapped signal interrupts wait before the terminated child is reaped.
    wait "$WEB_PID" 2>/dev/null || true
    WEB_PID=""
    print_status "Restarting application; background services unchanged"
  done
}

trap cleanup EXIT
# Run cleanup when the shell exits normally or because the web server exits.
trap 'cleanup; exit 130' INT
# Run cleanup on Ctrl+C and exit with the conventional interrupt code.
trap 'cleanup; exit 143' TERM HUP
# Run cleanup on termination/hangup and exit with a signal-style code.
trap request_app_restart USR1
# Full stop owns service shutdown; this signal only releases the application.
trap 'APP_ONLY=true; cleanup; exit 0' USR2

if [ "$LAUNCH_MODE" = --restart-app ]; then
  launcher_pid="$(cat "$LAUNCHER_PID_FILE")"
  if ! is_repo_process "$launcher_pid" || [[ "$(process_command "$launcher_pid")" != *start.sh* ]]; then
    print_error "No repository launcher owns the saved application PID"
    exit 1
  fi
  kill -USR1 "$launcher_pid"
  print_status "Application restart requested"
  exit 0
fi

echo -e "${BLUE}================================${NC}"
# Print banner top border.
echo -e "${BLUE}  MetaHuman OS                  ${NC}"
# Print banner title.
echo -e "${BLUE}================================${NC}"
# Print banner bottom border.
echo
# Add a blank line after the banner.

START_CONFIG_FILE="$REPO_ROOT/.start-config"
# Optional local startup preferences live here.
if [ -f "$START_CONFIG_FILE" ]; then
  # Only load the local startup config when it exists.
  # shellcheck disable=SC1090
  source "$START_CONFIG_FILE"
  # Import local shell variables from .start-config.
fi

ENV_FILE="$REPO_ROOT/.env"
# Main environment variables live here.
if [ -f "$ENV_FILE" ]; then
  # Only load .env when it exists.
  set -a
  # Automatically export sourced variables to child processes.
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  # Import environment variables for the server and services.
  set +a
  # Stop auto-exporting newly assigned variables.
fi

export PORT="${PORT:-4321}"
# Resolve the web port before lock and listener checks.

activate_repo_node_runtime
# Never let a desktop or non-interactive launch fall back to an unsupported system Node.

if ! command_exists pnpm; then
  # Full-system launchers call the workspace CLI, so pnpm is required even when
  # the prebuilt web entrypoint itself can run with node alone.
  print_error "pnpm is required to start MetaHuman OS background services"
  print_warning "Enable the repository-pinned pnpm release with: corepack enable pnpm"
  exit 1
fi

mkdir -p "$LOG_DIR" "$RUN_LOG_DIR"
# Ensure log folders exist before background launchers or cleanup write logs.

if command_exists curl && curl --max-time 2 --silent --show-error --output /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
  # A direct HTTP response is more reliable than lsof in constrained runtimes.
  print_error "MetaHuman OS is already responding on port $PORT"
  print_warning "Use ./stop.sh before starting another server"
  exit 1
fi

acquire_start_lock
# Refuse overlapping launcher instances before starting background services.

verify_site_runtime
# The compiled validator and source workers must agree before either starts.

if command_exists lsof && lsof -n -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  # Refuse to start if another process already owns the web port.
  print_error "Port $PORT is already in use"
  lsof -n -i ":$PORT" -sTCP:LISTEN
  # Show the process currently listening on the web port.
  exit 1
fi

configure_exposure_mode
# Resolve the request boundary before background services and the web server
# inherit their environment. Tunnel-derived sharing remains loopback-bound.

STARTED=true
if [ "$APP_ONLY" != true ]; then
  print_status "Starting background services"
  start_background_services
fi
printf '%s\n' "$$" > "$LAUNCHER_PID_FILE"
# Mark that cleanup should run when this launcher exits.

print_status "Starting web server"
# Announce the foreground web server.
print_status "Exposure mode: $MH_EXPOSURE_MODE"
print_status "Web interface: http://localhost:$PORT"
# Show the URL without opening a browser automatically.
print_warning "Use ./stop.sh to stop MetaHuman services"
# Tell the operator how to stop everything if not using Ctrl+C.
echo
# Add a blank line before server output begins.

cd "$REPO_ROOT/apps/site"
# Run the server from the site package directory.
run_web_server
# Start the web server in the foreground and mirror output to logs/server.log.
