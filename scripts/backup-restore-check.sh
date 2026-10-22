#!/usr/bin/env bash
# Backs up the Agent Cairn database and proves the backup restores.
#
#   1. counts what is in the live database (projects, memories),
#   2. stops Neo4j briefly and writes a dump (Neo4j Community can only dump a stopped database),
#   3. restores that dump into a throwaway container with an empty volume,
#   4. compares the counts, and fails if they differ.
#
# A backup you have never restored is a hope, not a backup. Run this on a schedule (cron, an Unraid user script)
# and keep the dumps somewhere that is not the same disk.
#
# Usage:  NEO4J_PASSWORD=... ./scripts/backup-restore-check.sh
# Needs:  Docker, and the Compose project from docs/self-hosting.md running in the current folder.
# Settings (environment):
#   NEO4J_PASSWORD      required, the Neo4j password
#   NEO4J_USER          default neo4j
#   NEO4J_SERVICE       default neo4j   (the service name in your docker-compose.yml)
#   NEO4J_DATA_VOLUME   default <compose project>_neo4j-data (see `docker volume ls`)
#   NEO4J_IMAGE         default neo4j:5-community (use the same image your server runs)
#   BACKUP_DIR          default ./backups
#   KEEP                default 14  (how many dumps to keep)
set -euo pipefail

: "${NEO4J_PASSWORD:?Set NEO4J_PASSWORD}"
USER_NAME="${NEO4J_USER:-neo4j}"
SERVICE="${NEO4J_SERVICE:-neo4j}"
IMAGE="${NEO4J_IMAGE:-neo4j:5-community}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${KEEP:-14}"
PROJECT="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
VOLUME="${NEO4J_DATA_VOLUME:-${PROJECT}_neo4j-data}"
STAMP="$(date +%Y%m%d-%H%M%S)"
CHECK="cairn-restore-check-$$"

mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

counts() { # container, prints "projects memories"
  docker exec "$1" cypher-shell -u "$USER_NAME" -p "$NEO4J_PASSWORD" --format plain \
    "MATCH (p:Project) WITH count(p) AS projects OPTIONAL MATCH (m:Memory) RETURN projects, count(m) AS memories" | tail -n 1 | tr -d ',"' | tr -s ' ' ' '
}

cleanup() {
  docker rm -f "$CHECK" >/dev/null 2>&1 || true
  docker volume rm -f "${CHECK}-data" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "1/4 Counting the live database"
LIVE="$(counts "$(docker compose ps -q "$SERVICE")")"
echo "    live: $LIVE (projects memories)"

echo "2/4 Dumping (Neo4j is stopped for a moment)"
docker compose stop "$SERVICE" >/dev/null
trap 'docker compose start "$SERVICE" >/dev/null 2>&1 || true; cleanup' EXIT
docker run --rm -v "$VOLUME":/data -v "$BACKUP_DIR":/backup "$IMAGE" \
  neo4j-admin database dump neo4j --to-path=/backup --overwrite-destination=true
mv "$BACKUP_DIR/neo4j.dump" "$BACKUP_DIR/cairn-$STAMP.dump"
docker compose start "$SERVICE" >/dev/null
trap cleanup EXIT
echo "    wrote $BACKUP_DIR/cairn-$STAMP.dump"

echo "3/4 Restoring it into a throwaway container"
docker volume create "${CHECK}-data" >/dev/null
cp "$BACKUP_DIR/cairn-$STAMP.dump" "$BACKUP_DIR/neo4j.dump"
docker run --rm -v "${CHECK}-data":/data -v "$BACKUP_DIR":/backup "$IMAGE" \
  neo4j-admin database load neo4j --from-path=/backup --overwrite-destination=true
rm -f "$BACKUP_DIR/neo4j.dump"
docker run -d --name "$CHECK" -v "${CHECK}-data":/data -e NEO4J_AUTH="$USER_NAME/$NEO4J_PASSWORD" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CHECK" cypher-shell -u "$USER_NAME" -p "$NEO4J_PASSWORD" "RETURN 1" >/dev/null 2>&1 && break
  sleep 2
done

echo "4/4 Comparing"
RESTORED="$(counts "$CHECK")"
echo "    restored: $RESTORED"
if [ "$LIVE" != "$RESTORED" ]; then
  echo "FAILED: the restored database differs from the live one. Do not rely on this backup." >&2
  exit 1
fi
echo "OK: the dump restores, and holds the same projects and memories."

# keep the newest $KEEP dumps
ls -1t "$BACKUP_DIR"/cairn-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
