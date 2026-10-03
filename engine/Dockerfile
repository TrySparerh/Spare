# oven/bun 1.3.14-slim, pinned by digest (multi-arch index). Keep the tag in step
# with package.json `packageManager`; bump both together and re-resolve the digest.
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
# --ignore-scripts: no dependency lifecycle script runs in the image, including
# those on Bun's default-trusted list (msgpackr-extract's native build). msgpackr
# then uses its prebuilt platform package, or its pure-JS codec without one.
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY . .
ENV NODE_ENV=production
# The image's unprivileged `bun` user (uid 1000). Code and node_modules stay
# root-owned, so the process can read but never rewrite them.
USER bun
# Migrations are idempotent. The address book is not in this image (it lives in
# contracts/addresses/): set ADDRESSES_JSON (or ADDRESSES_FILE) on the service.
# START_WORKERS is an explicit environment choice; the keeper runs as its own
# service with `bun run workers`.
CMD ["sh", "-c", "bun run src/db/migrate.ts && bun run src/index.ts"]
