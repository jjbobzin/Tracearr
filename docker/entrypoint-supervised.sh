#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[Tracearr]${NC} $1"; }
warn() { echo -e "${YELLOW}[Tracearr]${NC} $1"; }
error() { echo -e "${RED}[Tracearr]${NC} $1"; }

# Create log directory
mkdir -p /var/log/supervisor

# =============================================================================
# Increase file descriptor limit for TimescaleDB
# =============================================================================
# TimescaleDB creates many chunks (each a separate table with multiple files).
# The default soft limit (1024) can be exhausted with large datasets.
# Docker's default hard limit is typically 1048576, so this should succeed.
if ulimit -n 65536 2>/dev/null; then
    log "File descriptor limit set to 65536"
else
    warn "Could not increase file descriptor limit (current: $(ulimit -n))"
fi

# =============================================================================
# Timezone configuration
# =============================================================================
if [ -n "$TZ" ] && [ "$TZ" != "UTC" ]; then
    if [ -f "/usr/share/zoneinfo/$TZ" ]; then
        ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
        echo "$TZ" > /etc/timezone
        log "Timezone set to $TZ"
    else
        warn "Invalid timezone '$TZ', using UTC"
    fi
fi

# =============================================================================
# Resolve _FILE env vars (Docker Secrets support)
# =============================================================================
for var in DATABASE_URL REDIS_URL JWT_SECRET COOKIE_SECRET ENCRYPTION_KEY; do
    file_var="${var}_FILE"
    file_path=$(printenv "$file_var" 2>/dev/null) || file_path=''
    current_val=$(printenv "$var" 2>/dev/null) || current_val=''

    [ -z "$file_path" ] && continue

    if [ -n "$current_val" ]; then
        warn "Both $var and ${file_var} are set; using $var"
    elif [ ! -f "$file_path" ]; then
        error "${file_var}=${file_path} but file not found"
        exit 1
    elif [ ! -r "$file_path" ]; then
        error "${file_var}=${file_path} exists but is not readable"
        exit 1
    else
        val=$(tr -d '\r' < "$file_path")
        if [ -z "$val" ]; then
            error "${file_var} file is empty: ${file_path}"
            exit 1
        fi
        export "$var=$val"
        log "Loaded $var from ${file_var}"
    fi
done

# =============================================================================
# Generate secrets if not provided
# =============================================================================
mkdir -p /data/tracearr

if [ -z "$JWT_SECRET" ]; then
    if [ -f /data/tracearr/.jwt_secret ]; then
        export JWT_SECRET=$(cat /data/tracearr/.jwt_secret)
        log "Loaded JWT_SECRET from persistent storage"
    else
        export JWT_SECRET=$(openssl rand -hex 32)
        echo "$JWT_SECRET" > /data/tracearr/.jwt_secret
        chmod 600 /data/tracearr/.jwt_secret
        log "Generated new JWT_SECRET"
    fi
fi

if [ -z "$COOKIE_SECRET" ]; then
    if [ -f /data/tracearr/.cookie_secret ]; then
        export COOKIE_SECRET=$(cat /data/tracearr/.cookie_secret)
        log "Loaded COOKIE_SECRET from persistent storage"
    else
        export COOKIE_SECRET=$(openssl rand -hex 32)
        echo "$COOKIE_SECRET" > /data/tracearr/.cookie_secret
        chmod 600 /data/tracearr/.cookie_secret
        log "Generated new COOKIE_SECRET"
    fi
fi

# ENCRYPTION_KEY is optional - only needed for migrating existing encrypted tokens
# Load existing key if present (for backward compatibility), but don't generate new ones
if [ -z "$ENCRYPTION_KEY" ] && [ -f /data/tracearr/.encryption_key ]; then
    export ENCRYPTION_KEY=$(cat /data/tracearr/.encryption_key)
    log "Loaded ENCRYPTION_KEY from persistent storage (for token migration)"
fi

# =============================================================================
# Initialize PostgreSQL if needed
# =============================================================================
init_postgres_db() {
    # Configure PostgreSQL
    cat >> /data/postgres/postgresql.conf <<EOF
shared_preload_libraries = 'timescaledb'
listen_addresses = '127.0.0.1'
port = 5432
log_timezone = 'UTC'
timezone = 'UTC'
# Enable Timescale License
timescaledb.license = timescale
# Disable TimescaleDB telemetry
timescaledb.telemetry_level = off
# Cap tuple decompression per DML transaction (TimescaleDB's default, set
# explicitly because earlier releases wrote 0 = unlimited here, which let one
# UPDATE decompress unbounded history into memory and OOM the container).
# Migrations and imports that need more grant it per-session/per-transaction.
timescaledb.max_tuples_decompressed_per_dml_transaction = 100000
# Increase lock table size for TimescaleDB hypertables with many chunks
# Default (64) is far too low - hypertables with 1000+ chunks need locks on each chunk + indexes
# Memory cost: 4096 * max_connections * ~256 bytes = ~100MB at 100 connections (trivial)
max_locks_per_transaction = 4096
EOF

    # Allow local connections
    cat > /data/postgres/pg_hba.conf <<EOF
local all all trust
host all all 127.0.0.1/32 md5
EOF

    # Start PostgreSQL temporarily to create database and user
    gosu postgres /usr/lib/postgresql/15/bin/pg_ctl -D /data/postgres -w start

    log "Creating tracearr database and user..."
    gosu postgres psql -c "CREATE USER tracearr WITH PASSWORD 'tracearr' SUPERUSER;" 2>/dev/null || true
    gosu postgres psql -c "CREATE DATABASE tracearr OWNER tracearr;" 2>/dev/null || true
    gosu postgres psql -d tracearr -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
    gosu postgres psql -d tracearr -c "CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;"
    gosu postgres psql -d tracearr -c "GRANT ALL PRIVILEGES ON DATABASE tracearr TO tracearr;"
    gosu postgres psql -d tracearr -c "GRANT ALL ON SCHEMA public TO tracearr;"

    # Stop PostgreSQL (supervisord will start it)
    gosu postgres /usr/lib/postgresql/15/bin/pg_ctl -D /data/postgres -w stop

    log "PostgreSQL initialized successfully"
}

if [ ! -f /data/postgres/PG_VERSION ]; then
    log "Initializing PostgreSQL database..."

    # Ensure data directory exists (may not if bind mount path is new)
    mkdir -p /data/postgres

    # Check if this looks like an existing installation (secrets exist)
    # If secrets exist but postgres is empty, volumes may have been disconnected
    EXISTING_INSTALL=false
    if [ -f /data/tracearr/.jwt_secret ] || [ -f /data/tracearr/.cookie_secret ]; then
        EXISTING_INSTALL=true
    fi

    # Handle corrupt/partial initialization (has files but no PG_VERSION)
    if [ "$(ls -A /data/postgres 2>/dev/null)" ]; then
        # Check if this looks like a real database (has pg_control)
        if [ -f /data/postgres/global/pg_control ]; then
            # Database files exist but PG_VERSION is missing - try to recover
            warn "PG_VERSION missing but database files exist - attempting recovery"
            warn "This can happen after filesystem issues or interrupted shutdowns"
            echo "15" > /data/postgres/PG_VERSION
            chown postgres:postgres /data/postgres/PG_VERSION
            log "Created PG_VERSION file, will attempt to start existing database"
        else
            # No pg_control - could be corrupt or volume mount issue
            if [ "$EXISTING_INSTALL" = true ] && [ "$FORCE_DB_REINIT" != "true" ]; then
                error "=========================================================="
                error "DATA LOSS PREVENTION: Database appears corrupt or missing"
                error "=========================================================="
                error ""
                error "Found existing secrets but PostgreSQL data is invalid."
                error "This usually means:"
                error "  1. Volume was not properly mounted after container update"
                error "  2. Database was corrupted"
                error ""
                error "If this is a FRESH INSTALL, set: FORCE_DB_REINIT=true"
                error "If this is an UPDATE, check your volume mounts!"
                error ""
                error "Your data may still exist in a Docker volume."
                error "Run: docker volume ls | grep tracearr"
                error "=========================================================="
                exit 1
            fi
            warn "Data directory has no valid database (missing global/pg_control)"
            warn "Initializing fresh database..."
            rm -rf /data/postgres/*
            chown -R postgres:postgres /data/postgres
            gosu postgres /usr/lib/postgresql/15/bin/initdb -D /data/postgres -E UTF8 --locale=C.UTF-8
            init_postgres_db
        fi
    else
        # Empty directory - initialize fresh
        # Note: Existing secrets (JWT/cookie) don't indicate data loss risk since
        # they only affect auth sessions, not actual data. If postgres is empty,
        # there's no user data to protect anyway.
        if [ "$EXISTING_INSTALL" = true ]; then
            warn "Found existing secrets but empty database - initializing fresh"
            warn "Previous sessions will be invalidated (users will need to log in again)"
        fi
        chown -R postgres:postgres /data/postgres
        gosu postgres /usr/lib/postgresql/15/bin/initdb -D /data/postgres -E UTF8 --locale=C.UTF-8
        init_postgres_db
    fi
else
    log "PostgreSQL data directory exists, skipping initialization"
fi

# Ensure data directories exist and have correct ownership and permissions
# This handles fresh installs, upgrades, and bind mounts to new paths
mkdir -p /data/postgres /data/redis /data/tracearr
# Only recurse if ownership is wrong (avoids slow walk on large data dirs)
if [ "$(stat -c %U /data/postgres 2>/dev/null)" != "postgres" ]; then
    log "Fixing PostgreSQL data directory ownership..."
    chown -R postgres:postgres /data/postgres
fi
# PostgreSQL requires data directory to be 0700 or 0750 - some filesystems
# (especially Unraid's FUSE-based mounts) may not preserve these permissions
chmod 700 /data/postgres

# =============================================================================
# Clean up stale PostgreSQL lock files from unclean shutdowns
# =============================================================================
# If the container crashed or was killed during operation, postmaster.pid may
# be left behind, preventing PostgreSQL from starting. This is safe in containers
# due to PID namespace isolation - old PIDs from previous container runs cannot
# match real processes in the new container.
if [ -f /data/postgres/postmaster.pid ]; then
    PG_PID=$(head -1 /data/postgres/postmaster.pid 2>/dev/null || echo "")
    if [ -z "$PG_PID" ]; then
        # Empty or corrupted pid file - safe to remove
        warn "Removing empty/corrupted postmaster.pid file"
        rm -f /data/postgres/postmaster.pid
    elif ! kill -0 "$PG_PID" 2>/dev/null; then
        # PID doesn't exist - stale from previous container run
        warn "Removing stale postmaster.pid (PID $PG_PID not running)"
        rm -f /data/postgres/postmaster.pid
    fi
fi
if [ "$(stat -c %U /data/redis 2>/dev/null)" != "redis" ]; then
    log "Fixing Redis data directory ownership..."
    chown -R redis:redis /data/redis
fi
if [ "$(stat -c %U /data/tracearr 2>/dev/null)" != "tracearr" ]; then
    log "Fixing Tracearr data directory ownership..."
    chown -R tracearr:tracearr /data/tracearr
fi
if [ "$(stat -c %U /app 2>/dev/null)" != "tracearr" ]; then
    log "Fixing application directory ownership..."
    chown -R tracearr:tracearr /app
else
    # always chown the /app/data directory
    chown -R tracearr:tracearr /app/data
fi

# =============================================================================
# Tune PostgreSQL for available resources (runs every startup)
# =============================================================================
# timescaledb-tune automatically optimizes PostgreSQL settings based on
# available RAM and CPU. Safe to run repeatedly - recalculates if resources change.
#
# IMPORTANT: timescaledb-tune reads /proc/meminfo which shows HOST memory,
# not container limits. We detect container memory limits and pass them explicitly.
if command -v timescaledb-tune &> /dev/null; then
    TUNE_MEMORY=""
    MEMORY_SOURCE=""
    CGROUP_MB=""

    # Priority 1: User-specified memory limit via environment variable
    if [ -n "${PG_MAX_MEMORY:-}" ]; then
        TUNE_MEMORY="$PG_MAX_MEMORY"
        MEMORY_SOURCE="PG_MAX_MEMORY"
    # Priority 2: Detect container cgroup v2 memory limit (modern Docker/Kubernetes)
    elif [ -f /sys/fs/cgroup/memory.max ]; then
        CGROUP_LIMIT=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "max")
        if [ "$CGROUP_LIMIT" != "max" ] && [ -n "$CGROUP_LIMIT" ]; then
            # Convert bytes to MB
            CGROUP_MB=$((CGROUP_LIMIT / 1024 / 1024))
            CGROUP_VER="v2"
        fi
    # Priority 3: Detect container cgroup v1 memory limit (older systems)
    elif [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        CGROUP_LIMIT=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo "0")
        # Check if it's not the "unlimited" value (very large number ~9 exabytes)
        if [ -n "$CGROUP_LIMIT" ] && [ "$CGROUP_LIMIT" -gt 0 ] && [ "$CGROUP_LIMIT" -lt 9223372036854771712 ]; then
            CGROUP_MB=$((CGROUP_LIMIT / 1024 / 1024))
            CGROUP_VER="v1"
        fi
    fi

    # Postgres shares this cgroup with Node and Redis, and Node's sync-time
    # spike lands exactly when postgres works hardest - tuning for the full
    # limit left no reserve when the OOM killer fired under sync load.
    # Reserve a quarter of the limit (at least 1GB) for Node and Redis and
    # tune postgres for the rest: 3/4 on containers >=4G, half at 2G.
    # PG_MAX_MEMORY overrides this split entirely.
    if [ -n "$CGROUP_MB" ]; then
        PG_RESERVE_MB=1024
        [ $((CGROUP_MB / 4)) -gt "$PG_RESERVE_MB" ] && PG_RESERVE_MB=$((CGROUP_MB / 4))
        PG_TUNE_MB=$((CGROUP_MB - PG_RESERVE_MB))
        # 0 or negative makes timescaledb-tune exit non-zero and silently skip
        # tuning, leaving a stale larger config in place - floor it instead.
        [ "$PG_TUNE_MB" -lt 256 ] && PG_TUNE_MB=256
        TUNE_MEMORY="${PG_TUNE_MB}MB"
        MEMORY_SOURCE="cgroup ${CGROUP_VER} limit ${CGROUP_MB}MB minus ${PG_RESERVE_MB}MB reserved for Node/Redis"
        log "PostgreSQL is tuned for the container limit minus a Node/Redis reserve. Set PG_MAX_MEMORY to override."
    fi

    if [ -n "$TUNE_MEMORY" ]; then
        log "Tuning PostgreSQL for $TUNE_MEMORY ($MEMORY_SOURCE)..."
        timescaledb-tune --pg-config=/usr/lib/postgresql/15/bin/pg_config \
            --conf-path=/data/postgres/postgresql.conf \
            --memory="$TUNE_MEMORY" \
            --yes --quiet 2>/dev/null || warn "timescaledb-tune failed (non-fatal)"
    else
        # No container limit detected - use host memory (default behavior)
        # This may over-allocate if container has mem_limit set but cgroup detection failed
        warn "No container memory limit detected - tuning for host memory"
        warn "If using mem_limit in compose, set PG_MAX_MEMORY to about three-quarters of it (e.g. PG_MAX_MEMORY=3GB for a 4g limit)"
        timescaledb-tune --pg-config=/usr/lib/postgresql/15/bin/pg_config \
            --conf-path=/data/postgres/postgresql.conf \
            --yes --quiet 2>/dev/null || warn "timescaledb-tune failed (non-fatal)"
    fi
fi

# =============================================================================
# Floor max_connections when the postgres memory budget affords it
# =============================================================================
# The Node/Redis reserve shrinks the budget timescaledb-tune sees, and its
# tuned max_connections can dip below the stock 100. At a 2GB+ postgres
# budget 100 backends are affordable, so restore the floor; smaller
# containers keep tune's value.
PG_BUDGET_MB=""
if [ -n "${PG_TUNE_MB:-}" ]; then
    PG_BUDGET_MB="$PG_TUNE_MB"
elif [ -n "${PG_MAX_MEMORY:-}" ]; then
    PG_MEM_NUM=$(printf '%s' "$PG_MAX_MEMORY" | grep -oE '[0-9]+' | head -1 || echo "")
    case "$PG_MAX_MEMORY" in
        *[Gg]*) [ -n "$PG_MEM_NUM" ] && PG_BUDGET_MB=$((PG_MEM_NUM * 1024)) ;;
        *) PG_BUDGET_MB="$PG_MEM_NUM" ;;
    esac
fi

if [ -n "$PG_BUDGET_MB" ] && [ "$PG_BUDGET_MB" -ge 2048 ] 2>/dev/null && [ -f /data/postgres/postgresql.conf ]; then
    TUNED_MAX_CONN=$(grep -E "^max_connections\s*=" /data/postgres/postgresql.conf | tail -1 | grep -oE '[0-9]+' | head -1 || echo "")
    if [ -n "$TUNED_MAX_CONN" ] && [ "$TUNED_MAX_CONN" -lt 100 ] 2>/dev/null; then
        log "Raising max_connections from $TUNED_MAX_CONN to 100 (postgres budget ${PG_BUDGET_MB}MB affords it)"
        sed -i "s/^max_connections\s*=.*/max_connections = 100/" /data/postgres/postgresql.conf
    fi
fi

# =============================================================================
# Configure database connection pool to match PostgreSQL max_connections
# =============================================================================
# After timescaledb-tune runs, read the configured max_connections and set
# DATABASE_POOL_MAX accordingly. This prevents pool exhaustion on high-memory
# systems while avoiding connection conflicts on low-memory systems.
PG_MAX_CONN=""

# Try to read max_connections from postgresql.conf
if [ -f /data/postgres/postgresql.conf ]; then
    PG_MAX_CONN=$(grep -E "^max_connections\s*=" /data/postgres/postgresql.conf 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo "")
fi

# Reserve connections for superuser, maintenance, and replication
# - 3 for superuser reserved connections
# - 2 for maintenance/backup operations
# Both branches below treat "safe" as leaving this many connections free.
RESERVED_CONN=5

if [ -z "${DATABASE_POOL_MAX:-}" ]; then
    # Fallback: use a safe default if we couldn't read the config
    if [ -z "$PG_MAX_CONN" ] || [ "$PG_MAX_CONN" -eq 0 ] 2>/dev/null; then
        PG_MAX_CONN=100
        warn "Could not read max_connections from postgresql.conf, assuming $PG_MAX_CONN"
    fi

    POOL_MAX=$((PG_MAX_CONN - RESERVED_CONN))

    # Enforce minimum and maximum bounds
    if [ "$POOL_MAX" -lt 10 ]; then
        POOL_MAX=10
        warn "Calculated pool max too low, using minimum of $POOL_MAX"
    elif [ "$POOL_MAX" -gt 100 ]; then
        # Cap at 100 - more than enough for a single-user self-hosted app
        POOL_MAX=100
    fi

    export DATABASE_POOL_MAX="$POOL_MAX"
    log "Database pool configured: max=$POOL_MAX (PostgreSQL max_connections=$PG_MAX_CONN)"
else
    if [ -n "$PG_MAX_CONN" ] && [ "$DATABASE_POOL_MAX" -gt "$((PG_MAX_CONN - RESERVED_CONN))" ] 2>/dev/null; then
        warn "DATABASE_POOL_MAX=$DATABASE_POOL_MAX exceeds PostgreSQL max_connections=$PG_MAX_CONN minus $RESERVED_CONN reserved for superuser/maintenance - expect \"sorry, too many clients already\" errors under load"
    fi

    log "Using user-specified DATABASE_POOL_MAX=$DATABASE_POOL_MAX"
fi

# The supervised image bundles its own postgres, so the extension owner is the
# app user and updates always match the bundled binaries: safe to auto-update.
# Image bumps would otherwise leave the extension version behind silently.
export TIMESCALEDB_AUTO_UPDATE="${TIMESCALEDB_AUTO_UPDATE:-true}"

# =============================================================================
# Ensure the TimescaleDB decompression cap is at its default (existing installs)
# =============================================================================
# Earlier releases forced this to 0 (unlimited) on every boot, which removed
# TimescaleDB's per-transaction memory guard from all runtime DML and let the
# session identity backfill OOM postgres. Rewrite those installs back to the
# default; migrations and imports grant themselves unlimited per-session
# (migrations) or per-transaction (imports).
if [ -f /data/postgres/postgresql.conf ]; then
    if grep -q "^timescaledb\.max_tuples_decompressed_per_dml_transaction" /data/postgres/postgresql.conf; then
        # Postgres applies the LAST occurrence in the file, so read that one -
        # a stale "= 0" below a newer "= 100000" is the case that needs repair.
        current_value=$(grep "^timescaledb\.max_tuples_decompressed_per_dml_transaction" /data/postgres/postgresql.conf | grep -oE '[0-9]+' | tail -1)
        # Only rewrite the dangerous value. 0 means unlimited (the setting that
        # OOM-crashed postgres) and empty means malformed; an operator who
        # deliberately raised the cap to e.g. 1000000 keeps it.
        if [ "$current_value" = "0" ] || [ -z "$current_value" ]; then
            log "Updating timescaledb.max_tuples_decompressed_per_dml_transaction from ${current_value:-unset} to 100000..."
            # set -e is on and this runs as PID 1: a bind-mounted or :ro conf
            # makes sed fail, which would kill the container before postgres
            # ever starts. Warn and carry on instead.
            if ! sed -i "s/^timescaledb\.max_tuples_decompressed_per_dml_transaction.*/timescaledb.max_tuples_decompressed_per_dml_transaction = 100000/" /data/postgres/postgresql.conf; then
                warn "Could not rewrite postgresql.conf (read-only?) - set timescaledb.max_tuples_decompressed_per_dml_transaction = 100000 manually"
            fi
        fi
    else
        log "Adding TimescaleDB decompression cap setting..."
        {
            echo ""
            echo "# Cap tuple decompression per DML transaction (TimescaleDB default)"
            echo "timescaledb.max_tuples_decompressed_per_dml_transaction = 100000"
        } >> /data/postgres/postgresql.conf || warn "Could not append to postgresql.conf (read-only?)"
    fi
fi

# =============================================================================
# Ensure max_locks_per_transaction is set (for existing databases)
# =============================================================================
# This setting increases the lock table size for TimescaleDB hypertables.
# Default (64) is far too low - hypertables with 1000+ chunks need locks on each chunk + indexes.
# Without sufficient locks, queries fail with "out of shared memory" errors
# Memory cost: 4096 * max_connections * ~256 bytes = ~100MB at 100 connections (trivial)
if [ -f /data/postgres/postgresql.conf ]; then
    if grep -q "^max_locks_per_transaction" /data/postgres/postgresql.conf; then
        # Setting exists (uncommented) - update if below 4096. Postgres applies
        # the LAST occurrence in the file, so read that one.
        current_value=$(grep "^max_locks_per_transaction" /data/postgres/postgresql.conf | grep -oE '[0-9]+' | tail -1)
        if [ -n "$current_value" ] && [ "$current_value" -lt 4096 ]; then
            log "Updating max_locks_per_transaction from $current_value to 4096..."
            if ! sed -i "s/^max_locks_per_transaction.*/max_locks_per_transaction = 4096/" /data/postgres/postgresql.conf; then
                warn "Could not rewrite postgresql.conf (read-only?) - set max_locks_per_transaction = 4096 manually"
            fi
        fi
    elif ! grep -q "^max_locks_per_transaction" /data/postgres/postgresql.conf; then
        # Setting doesn't exist or is commented out - add active setting
        log "Adding max_locks_per_transaction setting for TimescaleDB..."
        {
            echo ""
            echo "# Increase lock table size for TimescaleDB hypertables with many chunks"
            echo "max_locks_per_transaction = 4096"
        } >> /data/postgres/postgresql.conf || warn "Could not append to postgresql.conf (read-only?)"
    fi
fi

# =============================================================================
# Link GeoIP database if exists
# =============================================================================
mkdir -p /app/data

if [ -f /data/tracearr/GeoLite2-City.mmdb ]; then
    ln -sf /data/tracearr/GeoLite2-City.mmdb /app/data/GeoLite2-City.mmdb
    log "GeoIP City database linked from /data/tracearr/"
elif [ -f /app/data/GeoLite2-City.mmdb ]; then
    log "Using bundled GeoIP City database"
else
    warn "GeoIP City database not found - geolocation features will be limited"
    warn "Place GeoLite2-City.mmdb in /data/tracearr/ for full functionality"
fi

if [ -f /data/tracearr/GeoLite2-ASN.mmdb ]; then
    ln -sf /data/tracearr/GeoLite2-ASN.mmdb /app/data/GeoLite2-ASN.mmdb
    log "GeoIP ASN database linked from /data/tracearr/"
elif [ -f /app/data/GeoLite2-ASN.mmdb ]; then
    log "Using bundled GeoIP ASN database"
else
    warn "GeoIP ASN database not found - geolocation features will be limited"
    warn "Place GeoLite2-ASN.mmdb in /data/tracearr/ for full functionality"
fi

# =============================================================================
# Start supervisord
# =============================================================================
log "Starting Tracearr services..."
log "  - PostgreSQL 15 with TimescaleDB"
log "  - Redis"
log "  - Tracearr application"
exec "$@"
