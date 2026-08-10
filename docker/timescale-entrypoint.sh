#!/bin/sh
# Floors max_connections on every boot: postgresql.conf.sample edits only
# apply at initdb, so volumes from older image versions keep their old value.
# TRACEARR_PG_MAX_CONNECTIONS overrides the floor; 0 disables it. A -c flag
# in the container command still wins over postgresql.conf.
set -e

FLOOR="${TRACEARR_PG_MAX_CONNECTIONS:-150}"
CONF="${PGDATA:-/var/lib/postgresql/data}/postgresql.conf"

if [ "$FLOOR" != "0" ] && [ -f "$CONF" ]; then
    CURRENT=$(grep -E "^max_connections[[:space:]]*=" "$CONF" | tail -1 | grep -oE '[0-9]+' | head -1 || echo "")
    if [ -z "$CURRENT" ]; then
        echo "tracearr: setting max_connections = $FLOOR"
        echo "max_connections = $FLOOR" >> "$CONF"
    elif [ "$CURRENT" -lt "$FLOOR" ] 2>/dev/null; then
        echo "tracearr: raising max_connections from $CURRENT to $FLOOR"
        sed -i "s/^max_connections[[:space:]]*=.*/max_connections = $FLOOR/" "$CONF"
    fi
fi

exec docker-entrypoint.sh "$@"
