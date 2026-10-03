#!/usr/bin/env bash
# Shared build/deploy lock. Sourced by install-app.sh and deploy-remote.sh.
#
# Why this exists: build-app.sh starts with `rm -rf "$ROOT/ProcessDetective.app"`.
# If a second build/deploy starts while a first one is still copying that bundle,
# the source is deleted mid-copy and the first run dies with a storm of
# "No such file or directory" — having already half-written the destination.
# One lock around the whole build+copy+push sequence makes that impossible.
#
# Usage:  . "$(dirname "$0")/_lock.sh"; acquire_lock "$ROOT"

LOCK_DIR=""

_release_lock() {
  [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ] && rm -rf "$LOCK_DIR"
  return 0
}

# acquire_lock <root-dir>
acquire_lock() {
  local root="$1"
  LOCK_DIR="$root/.deploy.lock"

  # mkdir is atomic on POSIX filesystems — this is the actual mutex.
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    local holder=""
    [ -f "$LOCK_DIR/pid" ] && holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"

    # Reclaim a lock whose owner is gone (killed run, reboot, crash).
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      echo "error: another build/deploy is already running (pid $holder)." >&2
      echo "  Wait for it to finish, or if you are sure it is dead:  rm -rf '$LOCK_DIR'" >&2
      LOCK_DIR=""   # do not remove someone else's lock on exit
      exit 1
    fi
    echo "› Clearing stale lock (owner pid ${holder:-unknown} is gone)"
    rm -rf "$LOCK_DIR"
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "error: could not acquire lock at $LOCK_DIR" >&2
      LOCK_DIR=""
      exit 1
    fi
  fi

  printf '%s' "$$" > "$LOCK_DIR/pid"
  trap _release_lock EXIT INT TERM
}
