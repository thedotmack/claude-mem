#!/bin/sh
# Rebuild what a C library change invalidates, after a Postgres data
# directory is opened by an image with a different C library (Alpine's musl to
# Debian's glibc, or one glibc to another): the indexes that order text by a
# libc collation. Vector (HNSW), tsvector (GIN) and jsonb indexes have no
# collation and are left alone, so this takes seconds where REINDEX DATABASE
# would rebuild the HNSW index too.
#
# postgres-pgvector-textsearch installs it as `reindex-collation`. Run it before the
# server and worker start, inside the postgres container:
#
#   docker compose up -d postgres
#   docker compose exec postgres reindex-collation                # rebuild
#   docker compose exec -e DRY_RUN=1 postgres reindex-collation   # list only
#   docker compose up -d
#
# or as the one-shot postgres-collation service in docker-compose.yml, which
# the server and worker wait for.
#
# Safe to run again: a database whose recorded collation version matches the
# C library's is skipped. Connects as POSTGRES_USER, over the local socket
# (which the postgres image trusts) or to PGHOST with PGPASSWORD.
set -eu
user=${POSTGRES_USER:-postgres}
err=$(mktemp)
trap 'rm -f "$err"' EXIT

# psql on one database. Until its collation version is refreshed, Postgres
# warns on every connection, before any setting could silence it; drop those
# three lines and pass every other message through.
psql_db() {
  db=$1; shift
  status=0
  psql -X -v ON_ERROR_STOP=1 -U "$user" -d "$db" -qAt "$@" 2>"$err" || status=$?
  grep -vE 'has a collation version mismatch|^DETAIL:  The database was created using collation version|^HINT:  Rebuild all objects in this database' "$err" >&2 || true
  return $status
}

# Indexes that order by a libc collation: any key column or expression whose
# collation is the database default or a libc one other than C/POSIX.
INDEXES_SQL="
SELECT DISTINCT format('%I.%I', n.nspname, ic.relname)
FROM (SELECT indexrelid, unnest(indcollation) AS coll FROM pg_index) i
JOIN pg_collation c ON c.oid = i.coll
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = ic.relnamespace
WHERE c.collprovider IN ('d', 'c') AND c.collname NOT IN ('C', 'POSIX')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1"

# libc databases whose recorded collation version differs from the C
# library's. musl reports no version, so a database created on Alpine has none
# recorded and counts as stale once glibc reports one. Builtin and ICU
# databases are skipped.
STALE_SQL="
SELECT datname FROM pg_database
WHERE datallowconn AND datlocprovider = 'c'
  AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)
ORDER BY 1"

# On a new volume the image first runs a temporary server on the local socket
# only, which can pass the healthcheck before TCP is up; when connecting over
# TCP, wait for the server itself.
if [ -n "${PGHOST:-}" ]; then
  tries=0
  until pg_isready -q -h "$PGHOST" -U "$user"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      echo "postgres at $PGHOST is not accepting connections after 60 s" >&2
      exit 1
    fi
    sleep 1
  done
fi

stale=$(psql_db postgres -c "$STALE_SQL")
if [ -z "$stale" ]; then
  echo "collation versions match the C library; nothing to do"
  exit 0
fi

# One name per line, read whole: a database or index name may hold spaces.
printf '%s\n' "$stale" | while IFS= read -r db; do
  indexes=$(psql_db "$db" -c "$INDEXES_SQL" </dev/null)
  count=$(printf '%s' "$indexes" | grep -c . || true)
  echo "$db: $count indexes order text by collation"
  if [ "${DRY_RUN:-}" = 1 ]; then
    printf '%s\n' "$indexes" | sed '/^$/d; s/^/  /'
    continue
  fi
  printf '%s\n' "$indexes" | sed '/^$/d' | while IFS= read -r index; do
    psql_db "$db" -c "REINDEX INDEX $index" </dev/null
  done
  # REFRESH COLLATION VERSION refuses to replace no version (Alpine) with one,
  # so record that case directly; either way later C library changes are caught.
  psql_db "$db" -c "
    DO \$\$ BEGIN
      IF (SELECT datcollversion IS NULL FROM pg_database WHERE datname = current_database()) THEN
        UPDATE pg_database SET datcollversion = pg_database_collation_actual_version(oid)
        WHERE datname = current_database();
      ELSE
        EXECUTE format('ALTER DATABASE %I REFRESH COLLATION VERSION', current_database());
      END IF;
    END \$\$" </dev/null
  echo "$db: rebuilt; collation version now $(psql_db "$db" -c "SELECT datcollversion FROM pg_database WHERE datname = current_database()" </dev/null)"
done
