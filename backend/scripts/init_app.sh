#!/usr/bin/env sh
# Script de arranque del contenedor app.
# 1. Espera a que MySQL esté listo.
# 2. Carga el schema base (docs/database.sql) si la tabla usuarios no existe.
# 3. Aplica las migraciones incrementales posteriores al schema base (007+),
#    en orden y de forma idempotente.
# 4. Crea el usuario admin inicial si la tabla está vacía.
# 5. Lanza uvicorn.

set -e

DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_NAME="${DB_NAME:-scanorder_db}"

echo "[init] Esperando a MySQL en ${DB_HOST}:${DB_PORT}..."
until mysqladmin ping -h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASSWORD}" --silent 2>/dev/null; do
  sleep 2
done
echo "[init] MySQL listo."

# Cargar schema base solo si la tabla usuarios todavía no existe
TABLE_EXISTS=$(mysql -h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASSWORD}" \
  -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}' AND table_name='usuarios';" \
  --skip-column-names 2>/dev/null || echo "0")

if [ "${TABLE_EXISTS}" = "0" ]; then
  echo "[init] Cargando schema base (docs/database.sql)..."
  # Quitar CREATE DATABASE y USE para no pisar la DB configurada
  grep -v "^CREATE DATABASE" /app/docs/database.sql \
    | grep -v "^USE " \
    | mysql -h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASSWORD}" "${DB_NAME}"
  echo "[init] Schema cargado."
else
  echo "[init] Schema ya presente — saltando carga inicial."
fi

# Migraciones incrementales (007+): docs/database.sql ya consolida 001-006
# (ver CLAUDE.md). Se aplican todas las posteriores, en orden y de forma
# idempotente, así una instalación limpia — y también un contenedor que se
# reinicia sobre un volumen ya existente al actualizar a una imagen con
# migraciones nuevas — quedan al día sin tener que listar cada archivo acá.
echo "[init] Aplicando migraciones incrementales (007+)..."
for migracion in $(ls /app/migrations/*.sql | sort); do
  archivo=$(basename "$migracion")
  case "$archivo" in
    00[1-6]_*)
      continue
      ;;
  esac
  echo "[init]   -> ${archivo}"
  if ! mysql -h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASSWORD}" "${DB_NAME}" < "$migracion"; then
    echo "[init] ERROR: falló la migración ${archivo}. Abortando arranque." >&2
    exit 1
  fi
done
echo "[init] Migraciones incrementales aplicadas."

# Crear admin inicial si no hay usuarios
echo "[init] Verificando usuario admin..."
cd /app && python scripts/create_admin.py

# Arrancar la API
echo "[init] Iniciando uvicorn..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
