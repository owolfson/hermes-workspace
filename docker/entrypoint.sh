#!/bin/bash
set -e

WORKSPACE_USER=workspace
WORKSPACE_GROUP=workspace
WORKSPACE_HOME="$(getent passwd "$WORKSPACE_USER" | cut -d: -f6)"
TARGET_UID="${HERMES_UID:-}"
TARGET_GID="${HERMES_GID:-}"

fix_owner_if_needed() {
  local path="$1"
  if [ ! -e "$path" ]; then
    return
  fi

  local actual_uid
  actual_uid=$(id -u "$WORKSPACE_USER")
  local current_uid
  current_uid=$(stat -c %u "$path" 2>/dev/null || true)
  if [ -n "$current_uid" ] && [ "$current_uid" != "$actual_uid" ]; then
    chown -R "$WORKSPACE_USER:$WORKSPACE_GROUP" "$path" 2>/dev/null || \
      echo "Warning: chown failed for $path (rootless container or restricted mount?) — continuing anyway"
  fi
}

if [ "$(id -u)" = "0" ]; then
  current_uid=$(id -u "$WORKSPACE_USER")
  current_gid=$(id -g "$WORKSPACE_USER")

  if [ -n "$TARGET_GID" ] && [ "$TARGET_GID" != "$current_gid" ]; then
    echo "Changing workspace GID to $TARGET_GID"
    groupmod -o -g "$TARGET_GID" "$WORKSPACE_GROUP" 2>/dev/null || true
  fi

  if [ -n "$TARGET_UID" ] && [ "$TARGET_UID" != "$current_uid" ]; then
    echo "Changing workspace UID to $TARGET_UID"
    usermod -o -u "$TARGET_UID" "$WORKSPACE_USER"
  fi

  mkdir -p "$WORKSPACE_HOME/.hermes" /workspace
  fix_owner_if_needed "$WORKSPACE_HOME"
  fix_owner_if_needed /workspace

  echo "Dropping root privileges"
  exec gosu "$WORKSPACE_USER:$WORKSPACE_GROUP" "$0" "$@"
fi

# Harness Hub companion. The server reaches it at 127.0.0.1:25808 (or
# AIONCORE_URL when an external companion is configured). --local disables
# AionCore's auth, so it is bound to loopback only and supervised here.
start_aioncore() {
  [ "${AIONCORE_ENABLED:-1}" = "1" ] || return 0
  [ -z "${AIONCORE_URL:-}" ] || return 0
  command -v aioncore >/dev/null 2>&1 || return 0

  local data_dir="${AIONCORE_DATA_DIR:-/app/.runtime/aioncore}"
  local work_dir="${AIONCORE_WORK_DIR:-$HOME/workspace}"
  if ! mkdir -p "$data_dir/logs" "$work_dir"; then
    echo "Warning: AionCore dirs not writable ($data_dir, $work_dir) — Harness Hub disabled"
    return 0
  fi

  (
    while true; do
      aioncore --local --host 127.0.0.1 --port 25808 \
        --data-dir "$data_dir" --work-dir "$work_dir" --log-dir "$data_dir/logs" \
        >>"$data_dir/logs/supervisor.log" 2>&1
      echo "$(date -Is) aioncore exited with $?, restarting in 5s" >>"$data_dir/logs/supervisor.log"
      sleep 5
    done
  ) &
  echo "AionCore companion started on 127.0.0.1:25808 (data: $data_dir)"
}

start_aioncore

exec "$@"
