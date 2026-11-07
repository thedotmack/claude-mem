FROM oven/bun:1.4-debian

# This service is internet-facing, so run it unprivileged: a code-execution path
# in a dependency or in the runtime must not land as root inside the container.
# A dedicated account (rather than the base image's) keeps the uid stable if the
# base image ever changes its own user layout. The code tree stays root-owned,
# so that path also cannot rewrite the code; the runtime writes no files.
RUN groupadd --system --gid 1001 cmem \
 && useradd --system --uid 1001 --gid cmem --no-create-home --shell /usr/sbin/nologin cmem

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

USER cmem

CMD ["bun", "run", "src/index.ts"]
