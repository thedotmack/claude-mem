FROM oven/bun:1.4-debian

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
