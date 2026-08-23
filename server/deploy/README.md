# Deploying the sync server on a VPS

Single-box setup: the server container plus Caddy for automatic TLS, via
docker compose. Assumes a fresh Debian/Ubuntu VPS (a Hetzner CAX11/CX22 is
plenty; better-sqlite3 has arm64 prebuilds, so ARM is fine).

## One-time setup

```sh
# 1. DNS: point sync.yourdomain at the VPS (A/AAAA record) — Caddy needs it
#    resolving before first start to fetch the certificate.

# 2. On the VPS: install Docker (https://docs.docker.com/engine/install/),
#    then clone the repo and configure:
git clone https://github.com/Danacus/sapling /opt/sapling   # adjust remote
cd /opt/sapling/server/deploy
cp .env.example .env && $EDITOR .env                        # domain + origins

# 3. Build and start:
docker compose up -d --build

# 4. Mint an API key (shown once — paste it into the app's Sync settings):
docker exec sapling-sync node dist/server/scripts/new-key.js --user daan

# 5. Smoke test from anywhere:
curl https://sync.yourdomain/v1/health    # {"ok":true}

# 6. Nightly backups:
crontab -e    # add:  17 3 * * * /opt/sapling/server/deploy/backup.sh
```

## Updating

```sh
cd /opt/sapling && git pull
cd server/deploy && docker compose up -d --build
```

## Restore

Stop the stack, copy a `backups/sapling-YYYY-MM-DD.db` over
`/data/sapling.db` inside the `sapling-data` volume (delete any stale
`-wal`/`-shm` siblings), start again. Note for a future move to hosted
Postgres: client cursors reference the server's `seq`, so a migration must
preserve `seq` values (`INSERT ... OVERRIDING SYSTEM VALUE`, then reset the
sequence) — or every device must be re-provisioned.
