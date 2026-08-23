#!/bin/sh
# Nightly online backup of the sync database, from the host's crontab:
#
#   17 3 * * * /opt/sapling/server/deploy/backup.sh
#
# The image ships no sqlite3 CLI, but better-sqlite3's backup() is the same
# online-backup API — safe against a live WAL database, no downtime. Backups
# land on the same /data volume; ship them off-box too (rclone/restic/rsync
# of the volume's backups/ directory) or a dead disk takes both copies.
set -eu

docker exec sapling-sync mkdir -p /data/backups

# node -e evaluates as CommonJS regardless of the package's "type", so
# require() resolves better-sqlite3 from the server's node_modules.
docker exec sapling-sync node -e '
const Database = require("better-sqlite3");
const db = new Database("/data/sapling.db", { readonly: true });
const stamp = new Date().toISOString().slice(0, 10);
db.backup("/data/backups/sapling-" + stamp + ".db")
  .then(() => db.close())
  .catch((err) => { console.error(err); process.exit(1); });
'

# Keep the newest 14, drop the rest.
docker exec sapling-sync sh -c 'ls -1t /data/backups/sapling-*.db 2>/dev/null | tail -n +15 | xargs -r rm --'
