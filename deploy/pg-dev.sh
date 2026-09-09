#!/usr/bin/env bash
# A throwaway local Postgres for development and tests.
#
# Why a script rather than "install Postgres and figure it out": the tests need
# a server, CI needs the same one, and the dev cluster has to live somewhere
# that is gitignored and disposable. This puts it under `data/pgdev` (already
# ignored), on a non-default port so it cannot collide with a system Postgres
# somebody is using for something else, and with `max_connections` raised —
# because the default of 100 is not enough for this app's own load test, which
# aborts outright with "sorry, too many clients already" rather than slowing
# down (measured: 100 concurrent players plus one ingest).
#
# Usage:
#   ./deploy/pg-dev.sh start|stop|status|reset|psql
#
# The connection string it prints is what FABULIST_TEST_PG and DATABASE_URL want.
set -euo pipefail

PORT="${FABULIST_PG_PORT:-5433}"
PGDATA="${FABULIST_PG_DATA:-$(cd "$(dirname "$0")/.." && pwd)/data/pgdev}"
SOCKET_DIR="${FABULIST_PG_SOCKET:-/tmp}"

# Homebrew's postgresql@18 is not on PATH by default (it is keg-only), so the
# binaries are located explicitly rather than assumed. Falling back to PATH lets
# this work on a Linux box or in CI where `initdb` is a normal command.
PGBIN="${FABULIST_PG_BIN:-/opt/homebrew/opt/postgresql@18/bin}"
if [ ! -x "$PGBIN/initdb" ]; then
  PGBIN="$(dirname "$(command -v initdb)")"
fi

CONN="postgres://postgres@localhost:$PORT/fabulist_dev?host=$SOCKET_DIR"
TEST_CONN="postgres://postgres@localhost:$PORT/fabulist_test?host=$SOCKET_DIR"

start() {
  if [ ! -d "$PGDATA/base" ]; then
    echo "initialising cluster at $PGDATA"
    # --auth=trust: this cluster listens on a unix socket in a local directory
    # and holds nothing but disposable dev data. A password here would be
    # security theatre that every developer then has to work around.
    "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
  fi

  if "$PGBIN/pg_isready" -p "$PORT" -h "$SOCKET_DIR" >/dev/null 2>&1; then
    echo "already running on port $PORT"
  else
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" \
      -o "-p $PORT -k $SOCKET_DIR -c max_connections=300" start
    # pg_ctl returns before the socket is necessarily accepting connections.
    for _ in $(seq 1 20); do
      "$PGBIN/pg_isready" -p "$PORT" -h "$SOCKET_DIR" >/dev/null 2>&1 && break
      sleep 0.3
    done
  fi

  for dbname in fabulist_dev fabulist_test; do
    if ! psql -h "$SOCKET_DIR" -p "$PORT" -U postgres -lqt | cut -d'|' -f1 | grep -qw "$dbname"; then
      createdb -h "$SOCKET_DIR" -p "$PORT" -U postgres "$dbname"
      echo "created $dbname"
    fi
  done

  echo
  echo "  DATABASE_URL=$CONN"
  echo "  FABULIST_TEST_PG=$TEST_CONN"
}

case "${1:-start}" in
  start) start ;;
  stop) "$PGBIN/pg_ctl" -D "$PGDATA" stop ;;
  status) "$PGBIN/pg_isready" -p "$PORT" -h "$SOCKET_DIR" ;;
  # Destructive on purpose, and named so nobody runs it by accident: this is
  # the "my dev data is wedged, start over" button.
  reset)
    "$PGBIN/pg_ctl" -D "$PGDATA" stop 2>/dev/null || true
    rm -rf "$PGDATA"
    start
    ;;
  psql) shift; exec psql -h "$SOCKET_DIR" -p "$PORT" -U postgres -d fabulist_dev "$@" ;;
  *) echo "usage: $0 start|stop|status|reset|psql" >&2; exit 2 ;;
esac
