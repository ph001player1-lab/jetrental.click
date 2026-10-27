#!/usr/bin/env bash
# ============================================================================
# KOKON — обновление и запуск сервисов на сервере
# ============================================================================
# Забирает свежий код из GitHub, пересобирает и перезапускает контейнеры.
# Запуск на сервере:  bash /opt/kokon/app/deploy/update.sh
# ============================================================================

set -euo pipefail

# Весь код внутри main: bash сначала дочитывает файл целиком, поэтому
# git pull может безопасно обновить и этот же скрипт.
main() {
  local app_dir="/opt/kokon/app"
  local compose=(docker compose -f "$app_dir/deploy/docker-compose.yml")

  cd "$app_dir"
  git pull --ff-only

  "${compose[@]}" up -d --build --remove-orphans
  # Caddyfile мог измениться — перечитываем без остановки
  "${compose[@]}" exec -T caddy caddy reload --config /etc/caddy/kokon/Caddyfile --adapter caddyfile \
    || echo "Внимание: Caddy не перечитал настройки, смотрите: docker compose logs caddy"
  "${compose[@]}" ps

  echo
  echo "Готово. Проверка:"
  echo "  https://bot.jetrental.click/health"
  echo "  https://staff.jetrental.click"
  echo "  https://jetrental.click"
}

main "$@"
exit
