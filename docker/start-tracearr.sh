#!/bin/bash
# Wrapper script for starting Tracearr after dependencies are ready
# Used by supervisord to ensure PostgreSQL and Redis are available

set -e

# Supervised mode ALWAYS uses internal database/redis
# If you need an external database, use the regular tracearr image instead
INTERNAL_DB="postgresql://tracearr:tracearr@127.0.0.1:5432/tracearr"
INTERNAL_REDIS="redis://127.0.0.1:6379"

# Warn if user tried to set external DATABASE_URL (they should use regular image)
if [ -n "$DATABASE_URL" ] && [ "$DATABASE_URL" != "$INTERNAL_DB" ]; then
    echo "[Tracearr] WARNING: Custom DATABASE_URL detected in supervised mode"
    echo "[Tracearr] The supervised image includes its own PostgreSQL - external databases are not supported"
    echo "[Tracearr] If you need an external database, please use the regular 'tracearr:latest' image instead"
    echo "[Tracearr] Your DATABASE_URL will be ignored. Using internal database."
fi

export DATABASE_URL="$INTERNAL_DB"
export REDIS_URL="$INTERNAL_REDIS"

MAX_RETRIES=30
RETRY_INTERVAL=2

# Wait for PostgreSQL
echo "[Tracearr] Waiting for PostgreSQL..."
for i in $(seq 1 $MAX_RETRIES); do
    if pg_isready -h 127.0.0.1 -p 5432 -U tracearr -q; then
        echo "[Tracearr] PostgreSQL is ready"
        # Ensure tracearr is a superuser (needed for backup/restore extension operations).
        # Uses local socket (trust auth) to connect as postgres superuser.
        psql -U postgres -c "ALTER USER tracearr WITH SUPERUSER;" 2>/dev/null || true
        break
    fi
    if [ $i -eq $MAX_RETRIES ]; then
        echo "[Tracearr] ERROR: PostgreSQL failed to become ready after $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
        exit 1
    fi
    sleep $RETRY_INTERVAL
done

# Wait for Redis
echo "[Tracearr] Waiting for Redis..."
for i in $(seq 1 $MAX_RETRIES); do
    if redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; then
        echo "[Tracearr] Redis is ready"
        break
    fi
    if [ $i -eq $MAX_RETRIES ]; then
        echo "[Tracearr] ERROR: Redis failed to become ready after $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
        exit 1
    fi
    sleep $RETRY_INTERVAL
done

# Cap Node's heap to fit the container's Node/Redis reserve. Node sizes its
# default max-old-space from HOST memory (it can't see the cgroup), so on a
# big host it balloons past the reserve the entrypoint carved out of the
# limit and the whole container gets OOM-killed. Reserve math mirrors the
# entrypoint's tuning split: max(1024MB, limit/4), minus slack for Redis and
# Node's non-heap memory. A user-supplied --max-old-space-size wins.
if [[ "${NODE_OPTIONS:-}" != *"--max-old-space-size"* ]]; then
    CGROUP_MB=""
    if [ -f /sys/fs/cgroup/memory.max ]; then
        CGROUP_LIMIT=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "max")
        if [ "$CGROUP_LIMIT" != "max" ] && [ -n "$CGROUP_LIMIT" ]; then
            CGROUP_MB=$((CGROUP_LIMIT / 1024 / 1024))
        fi
    elif [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        CGROUP_LIMIT=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo "0")
        if [ -n "$CGROUP_LIMIT" ] && [ "$CGROUP_LIMIT" -gt 0 ] && [ "$CGROUP_LIMIT" -lt 9223372036854771712 ]; then
            CGROUP_MB=$((CGROUP_LIMIT / 1024 / 1024))
        fi
    fi
    if [ -n "$CGROUP_MB" ]; then
        NODE_RESERVE_MB=1024
        [ $((CGROUP_MB / 4)) -gt "$NODE_RESERVE_MB" ] && NODE_RESERVE_MB=$((CGROUP_MB / 4))
        NODE_HEAP_MB=$((NODE_RESERVE_MB - 256))
        [ "$NODE_HEAP_MB" -lt 512 ] && NODE_HEAP_MB=512
        export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${NODE_HEAP_MB}"
        echo "[Tracearr] Node heap capped at ${NODE_HEAP_MB}MB (container limit ${CGROUP_MB}MB; set --max-old-space-size in NODE_OPTIONS to override)"
    fi
fi

echo "[Tracearr] Starting application..."
exec node /app/apps/server/dist/index.js
