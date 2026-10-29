#!/usr/bin/env bash
set -euo pipefail
umask 077
agent_source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_action="${1:-status}"
agent_deploy_dir="${2:-/data/codex-agent-platform}"
# Updates run from a verified staged release; other commands follow active source.
if [[ "$agent_action" == update || ( "$agent_action" != init && "${PLATFORM_UPDATE_STAGED:-}" != 1 ) ]]; then
  command -v python3 >/dev/null || { echo 'Python 3.10+ is required (apt install python3).' >&2; exit 1; }
  agent_resolve_args=(--source "$agent_source_dir")
  if [[ -n "${2:-}" ]]; then agent_resolve_args+=(--data "$2"); fi
  if [[ -n "${PLATFORM_PROJECT:-}" ]]; then agent_resolve_args+=(--project "$PLATFORM_PROJECT"); fi
  if [[ "$agent_action" == update ]]; then exec python3 -B "$agent_source_dir/scripts/update-release.py" update "${agent_resolve_args[@]}"; fi
  agent_resolved="$(python3 -B "$agent_source_dir/scripts/update-release.py" resolve "${agent_resolve_args[@]}")"
  mapfile -t agent_paths <<< "$agent_resolved"
  agent_deploy_dir="${agent_paths[1]}"
  export PLATFORM_PROJECT="${agent_paths[2]}"
  if [[ "${agent_paths[0]}" != "$agent_source_dir" ]]; then exec bash "${agent_paths[0]}/deploy.sh" "$agent_action" "$agent_deploy_dir"; fi
fi
agent_project="${PLATFORM_PROJECT:-codex-agent-platform}"
if [[ ! "$agent_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then echo 'Invalid PLATFORM_PROJECT' >&2; exit 1; fi
agent_compose() { docker compose --project-name "$agent_project" --env-file "$agent_deploy_dir/.env" -f "$agent_source_dir/compose.yaml" "$@"; }
case "$agent_action" in
  init)
    mkdir -p -- "$agent_deploy_dir"
    agent_deploy_dir="$(cd -- "$agent_deploy_dir" && pwd)"
    if [[ "$agent_deploy_dir" == *'$'* || "$agent_deploy_dir" == *$'\n'* || "$agent_deploy_dir" == *'#'* ]]; then echo 'Unsupported deployment directory characters' >&2; exit 1; fi
    for agent_volume in data workspace codex manager; do
      if [[ -L "$agent_deploy_dir/$agent_volume" ]]; then echo 'Refusing symlink data directory' >&2; exit 1; fi
      if [[ ! -d "$agent_deploy_dir/$agent_volume" ]]; then
        mkdir -- "$agent_deploy_dir/$agent_volume"
        if [[ "$(id -u)" == 0 ]]; then chown 1000:1000 -- "$agent_deploy_dir/$agent_volume"; fi
      fi
    done
    if [[ -L "$agent_deploy_dir/updater" ]]; then echo 'Refusing symlink updater channel' >&2; exit 1; fi
    mkdir -p -- "$agent_deploy_dir/updater"
    chmod 750 -- "$agent_deploy_dir/updater"
    if [[ "$(id -u)" == 0 ]]; then chown 0:1000 -- "$agent_deploy_dir/updater"; fi
    agent_password_path="$agent_deploy_dir/manager/initial-password"
    if [[ -L "$agent_password_path" ]]; then echo 'Refusing symlink password file' >&2; exit 1; fi
    if [[ ! -e "$agent_password_path" ]]; then
      agent_password_temp="$(mktemp "$agent_deploy_dir/manager/.initial-password.XXXXXX")"
      od -An -N18 -tx1 /dev/urandom | tr -d ' \n' > "$agent_password_temp"
      chmod 600 "$agent_password_temp"
      if [[ "$(id -u)" == 0 ]]; then chown 1000:1000 -- "$agent_password_temp"; fi
      if ln -- "$agent_password_temp" "$agent_password_path" 2>/dev/null; then echo "Initial Admin password saved in $agent_password_path (used only on first manager initialization)."; fi
      rm -f -- "$agent_password_temp"
    fi
    if [[ -e "$agent_deploy_dir/.env" ]]; then echo 'Existing configuration retained.'; exit 0; fi
    agent_temp="$(mktemp "$agent_deploy_dir/.env.XXXXXX")"
    trap 'rm -f -- "$agent_temp"' EXIT
    for agent_key in RUNNER_TOKEN; do
      agent_random="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
      printf '%s=%s\n' "$agent_key" "$agent_random" >> "$agent_temp"
    done
    printf 'PLATFORM_DATA_DIR=%s\n' "$agent_deploy_dir" >> "$agent_temp"
    cat >> "$agent_temp" <<'CONFIG'
# Runtime values below seed persistent settings on first start.
PLATFORM_PORT=3004
CODEX_MODEL=gpt-6.1-sol
QUEUE_LIMIT=10000
CONCURRENCY=5
TASK_TIMEOUT_MS=2400000
TOOL_TIMEOUT_MS=180000
EXECUTION_PAUSED=false
CONFIG
    chmod 600 "$agent_temp"
    # Atomic no-overwrite creation, including concurrent init invocations.
    if ln -- "$agent_temp" "$agent_deploy_dir/.env" 2>/dev/null; then echo "Created configuration in $agent_deploy_dir/.env; build images and sign in before starting."; else echo 'Existing configuration retained.'; fi
    ;;
  enable-web-update|disable-web-update|web-update-status)
    exec python3 -B "$agent_source_dir/scripts/host-updater.py" "$agent_action" --source "$agent_source_dir" --data "$agent_deploy_dir" --project "$agent_project"
    ;;
  validate)
    agent_compose config --quiet
    agent_compose run --rm --no-deps --entrypoint node gateway scripts/validate-config.mjs
    ;;
  build)
    agent_compose config --quiet
    if [[ -n "${CODEX_PROXY_CERT:-}" ]]; then
      docker build --secret "id=proxy_ca,src=$CODEX_PROXY_CERT" --target gateway -t codex-agent-platform-gateway:1.0.1 "$agent_source_dir"
      docker build --secret "id=proxy_ca,src=$CODEX_PROXY_CERT" --target runner -t codex-agent-platform-runner:1.0.1 "$agent_source_dir"
      docker build --secret "id=proxy_ca,src=$CODEX_PROXY_CERT" --target manager -t codex-agent-platform-manager:1.0.1 "$agent_source_dir"
    else agent_compose build; fi
    ;;
  start)
    "$agent_source_dir/deploy.sh" init "$agent_deploy_dir"
    "$agent_source_dir/deploy.sh" validate "$agent_deploy_dir"
    agent_compose up -d --no-build
    ;;
  stop) agent_compose down ;;
  status) agent_compose ps ;;
  logs) agent_compose logs --tail=100 gateway runner manager ;;
  login)
    agent_compose run --rm --no-deps --entrypoint codex runner login --device-auth
    ;;
  *) echo 'Usage: ./deploy.sh init|validate|build|start|stop|status|logs|login|update|enable-web-update|disable-web-update|web-update-status [deployment-directory]' >&2; exit 2 ;;
esac
