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
  if [[ "${KOKON_PULLED:-}" != "1" ]]; then
    git pull --ff-only
    # Свежий код мог изменить и этот скрипт — дальше работает уже новая версия,
    # иначе новые шаги (например, установка программ) сработали бы только со
    # второго запуска
    KOKON_PULLED=1 exec bash "$app_dir/deploy/update.sh" "$@"
  fi

  # Счётчик трафика сервера vnStat (вкладка «Сервер» на сайте сотрудников).
  # Ставится один раз; sudo может спросить пароль пользователя ubuntu.
  if ! command -v vnstat >/dev/null 2>&1; then
    echo "Ставлю vnStat — счётчик трафика сервера"
    sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a sh -c \
      'apt-get install -y vnstat || (apt-get update && apt-get install -y vnstat)' \
      || echo "Внимание: vnStat не установился — на вкладке «Сервер» не будет трафика VPS"
  fi

  # Общий секрет для связи бота с наблюдателем WhatsApp — создаётся один раз
  local env_file="/opt/kokon/.env"
  if ! grep -q '^INTERNAL_SECRET=' "$env_file" 2>/dev/null; then
    touch "$env_file"
    chmod 600 "$env_file"
    printf 'INTERNAL_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$env_file"
    echo "Создан INTERNAL_SECRET для наблюдателя WhatsApp"
  fi
  # Переезд на jetmobility.org: старые адреса jetrental.click в настройках
  # отключаем (комментируем) — тогда работают новые адреса по умолчанию
  if grep -qE '^(PUBLIC_BASE_URL|STAFF_URL|MAIL_FROM|JETRENTAL_HOSTS|KOKON_PREVIEW_HOSTS)=.*jetrental\.click' "$env_file"; then
    sed -i -E 's/^((PUBLIC_BASE_URL|STAFF_URL|MAIL_FROM|JETRENTAL_HOSTS|KOKON_PREVIEW_HOSTS)=.*jetrental\.click.*)$/# \1  # отключено при переезде на jetmobility.org/' "$env_file"
    echo "Старые адреса jetrental.click в /opt/kokon/.env отключены"
  fi

  # Наблюдателю и WhatsApp-боту передаём только этот секрет, остальные им не нужны
  INTERNAL_SECRET="$(grep '^INTERNAL_SECRET=' "$env_file" | tail -1 | cut -d= -f2-)"
  export INTERNAL_SECRET

  # Версия кода — её видно на вкладке «Сервер» и в /health
  APP_VERSION="$(git rev-parse --short HEAD)"
  APP_VERSION_DATE="$(git log -1 --format=%cI)"
  export APP_VERSION APP_VERSION_DATE

  "${compose[@]}" up -d --build --remove-orphans
  # Caddyfile мог измениться — перечитываем без остановки
  "${compose[@]}" exec -T caddy caddy reload --config /etc/caddy/kokon/Caddyfile --adapter caddyfile \
    || echo "Внимание: Caddy не перечитал настройки, смотрите: docker compose logs caddy"
  "${compose[@]}" ps

  echo
  echo "Готово. Проверка:"
  echo "  https://bot.jetmobility.org/health"
  echo "  https://staff.jetmobility.org"
  echo "  https://jetmobility.org"
}

main "$@"
exit
