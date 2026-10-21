# postgres-pgvector-textsearch: Postgres with pgvector (search by meaning) and
# pg_textsearch (bm25 keyword ranking), both from the PostgreSQL project's apt
# repository (apt.postgresql.org), which the official postgres image already
# uses. Published as ghcr.io/rich-murphey/postgres-pgvector-textsearch, built
# from rich-murphey/claude-mem-search-eval; docker-compose.yml pulls that image,
# and `docker compose up --build` builds this file instead.
ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}-trixie
ARG PG_MAJOR

# Version prefixes rather than exact versions: PGDG keeps only the last few
# builds of a package, so an exact pin stops building within months.
ARG PGVECTOR_VERSION=0.8.*
ARG PG_TEXTSEARCH_VERSION=1.5.*

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      "postgresql-${PG_MAJOR}-pgvector=${PGVECTOR_VERSION}" \
      "postgresql-${PG_MAJOR}-pg-textsearch=${PG_TEXTSEARCH_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

# Rebuilds text indexes after a C library change (an Alpine volume, or a glibc
# upgrade). docker-compose.yml runs it before the server starts.
COPY --chmod=755 reindex-collation.sh /usr/local/bin/reindex-collation

# New databases use Postgres's builtin locale, which does not depend on the C
# library, so later glibc changes cannot reorder their text indexes.
ENV POSTGRES_INITDB_ARGS="--locale-provider=builtin --locale=C.UTF-8"

# pg_textsearch must be loaded at server start. Passed on the command line so
# it applies to an existing data directory too; a compose `command:` replaces it.
CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]
