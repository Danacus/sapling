# Sapling sync server.
#
# The build context is the **repo root**, not `server/`, because the event
# envelope is shared with the app (`src/lib/sync/events.ts`) and the compiled
# output mirrors that layout:
#
#   docker build -f server/Dockerfile -t sapling-sync .
#
# Two stages: the first has a toolchain (better-sqlite3 compiles a native
# binding when no prebuilt matches the platform), the second has none.

FROM node:22-bookworm-slim AS build
WORKDIR /app/server

# node-gyp's fallback path, only ever used if prebuild-install finds no
# matching prebuilt binary for the target platform.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

# Pinned to the pnpm the lockfile was written by; corepack would otherwise
# fetch whatever is newest and may refuse the frozen lockfile.
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

# Dependencies first: this layer only invalidates when the manifests change.
COPY server/package.json server/pnpm-lock.yaml server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/scripts ./scripts
# The shared envelope schema, at the path the relative import expects.
COPY src/lib/sync /app/src/lib/sync

# Emits dist/server/src/*.js + dist/src/lib/sync/*.js — the repo layout,
# preserved so the relative import still resolves at runtime.
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/server

ENV NODE_ENV=production \
	SAPLING_DB=/data/sapling.db \
	PORT=8787

COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/package.json ./package.json

# The database lives on a volume, never in the image layer. SQLite in WAL mode
# writes `-wal`/`-shm` siblings, so mount the *directory*, not the file.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# Unprivileged from here on; the `node` user ships with the base image.
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/src/index.js"]
