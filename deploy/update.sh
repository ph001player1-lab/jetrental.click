#!/usr/bin/env bash
# ============================================================================
# KOKON — обновление и запуск сервисов на сервере
# ============================================================================
# Забирает свежий код из GitHub, пересобирает и перезапускает контейнеры.
# Запуск на сервере:  bash /opt/kokon/app/deploy/update.sh
# ============================================================================

set -euo pipefail

APP_DIR="/opt/kokon/app"
COMPOSE=(docker compose -f "$APP_DIR/deploy/docker-compose.yml")

cd "$APP_DIR"
git pull --ff-only

"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps

echo
echo "Готово. Проверка: https://bot.jetrental.click/health"
