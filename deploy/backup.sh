#!/bin/sh
# Ежедневный бэкап Stenogram: PostgreSQL (pg_dump -Fc) + данные MinIO (tar тома).
# Ротация: удаляются копии старше RETENTION_DAYS. Запускается из cron
# (см. /etc/cron.d/voxmate-backup). Бэкапы кладутся ВНЕ git-репозитория
# (/opt/voxmate-backups), чтобы их не затронул git clean / деплой.
#
# Восстановление БД:   gunzip -c нет — формат custom, восстанавливать так:
#   docker exec -i voxmate-server-db-1 pg_restore -U postgres -d voxmate --clean \
#     --if-exists < /opt/voxmate-backups/db/voxmate_<STAMP>.dump
# Восстановление MinIO: остановить minio, распаковать tgz в том, поднять:
#   docker run --rm -v voxmate-server_minio-data:/data -v /opt/voxmate-backups/minio:/b \
#     alpine sh -c 'rm -rf /data/* && tar xzf /b/minio_<STAMP>.tgz -C /data'
set -eu

RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/voxmate-backups}"
DB_CONTAINER="${DB_CONTAINER:-voxmate-server-db-1}"
MINIO_VOLUME="${MINIO_VOLUME:-voxmate-server_minio-data}"
DB_NAME="${DB_NAME:-voxmate}"
STAMP="$(date +%F_%H%M%S)"

mkdir -p "$BACKUP_ROOT/db" "$BACKUP_ROOT/minio"

# 1. PostgreSQL — дамп в custom-формате (сжат, восстанавливается pg_restore).
DB_FILE="$BACKUP_ROOT/db/${DB_NAME}_$STAMP.dump"
docker exec "$DB_CONTAINER" pg_dump -U postgres -d "$DB_NAME" -Fc > "$DB_FILE"
if [ ! -s "$DB_FILE" ]; then
  echo "$(date -Is) backup FAILED: пустой дамп БД ($DB_FILE)" >&2
  rm -f "$DB_FILE"
  exit 1
fi

# 2. MinIO — tar тома через одноразовый alpine-контейнер (том смонтирован ro).
MINIO_FILE="$BACKUP_ROOT/minio/minio_$STAMP.tgz"
docker run --rm -v "$MINIO_VOLUME":/data:ro -v "$BACKUP_ROOT/minio":/backup alpine \
  tar czf "/backup/minio_$STAMP.tgz" -C /data .
if [ ! -s "$MINIO_FILE" ]; then
  echo "$(date -Is) backup FAILED: пустой архив MinIO ($MINIO_FILE)" >&2
  rm -f "$MINIO_FILE"
  exit 1
fi

# 3. Ротация — удаляем копии старше RETENTION_DAYS.
find "$BACKUP_ROOT/db" -name "${DB_NAME}_*.dump" -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_ROOT/minio" -name 'minio_*.tgz' -mtime +"$RETENTION_DAYS" -delete

echo "$(date -Is) backup ok: db=$(basename "$DB_FILE") ($(du -h "$DB_FILE" | cut -f1)) minio=$(basename "$MINIO_FILE") ($(du -h "$MINIO_FILE" | cut -f1)) retention=${RETENTION_DAYS}d"
