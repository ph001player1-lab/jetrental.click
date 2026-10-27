#!/usr/bin/env bash
# ============================================================================
# KOKON — сохранить секрет (токен, ключ API) на сервере
# ============================================================================
# Значение вводится скрыто (не видно на экране и на скриншотах) и пишется
# в /opt/kokon/.env с правами 600. В git секреты не попадают никогда.
#
# Использование:  bash /opt/kokon/app/deploy/set-secret.sh TELEGRAM_BOT_TOKEN
# ============================================================================

set -euo pipefail

ENV_FILE="${KOKON_ENV_FILE:-/opt/kokon/.env}"
NAME="${1:-}"

if [[ ! "$NAME" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
  echo "Укажите имя секрета, например: bash set-secret.sh TELEGRAM_BOT_TOKEN" >&2
  exit 1
fi

read -rsp "Вставьте значение для $NAME (символы не видны) и нажмите Enter: " VALUE
echo
# При вставке из Windows может прилететь \r — убираем переводы строк и пробелы по краям
VALUE="${VALUE//[$'\r\n']/}"
VALUE="$(echo -n "$VALUE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [[ -z "$VALUE" ]]; then
  echo "Пустое значение — ничего не сохранено." >&2
  exit 1
fi

touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Заменяем старое значение, если оно было, остальные строки не трогаем
TMP_FILE="$(mktemp)"
grep -v "^${NAME}=" "$ENV_FILE" > "$TMP_FILE" || true
printf '%s=%s\n' "$NAME" "$VALUE" >> "$TMP_FILE"
cat "$TMP_FILE" > "$ENV_FILE"
rm -f "$TMP_FILE"

echo "Сохранено: $NAME (${#VALUE} символов)."
echo "Чтобы бот увидел новое значение: bash /opt/kokon/app/deploy/update.sh"
