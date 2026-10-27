#!/usr/bin/env bash
# ============================================================================
# KOKON — первичная настройка сервера (Ubuntu 24.04)
# ============================================================================
# Запуск на сервере:
#   curl -fsSL https://raw.githubusercontent.com/ph001player1-lab/Kokon-Car-Bike-Service/refs/heads/claude/bold-pascal-1k2fgi/deploy/bootstrap.sh -o bootstrap.sh
#   sudo bash bootstrap.sh
#
# Что делает (безопасно запускать повторно):
#   1. Обновляет систему, ставит часовой пояс Asia/Bangkok
#   2. Добавляет swap 2 ГБ (запас памяти для браузера робота 1С)
#   3. Ставит Docker + Docker Compose из официального репозитория Docker
#   4. Включает firewall (открыты только 22, 80, 443), fail2ban и автообновления
#   5. Запрещает вход по паролю и под root — ТОЛЬКО если у пользователя
#      ubuntu уже есть SSH-ключ (иначе можно потерять доступ к серверу)
#   6. Создаёт рабочую папку /opt/kokon
#
# Секретов в этом файле нет и быть не должно: репозиторий публичный.
# ============================================================================

set -euo pipefail

APP_USER="ubuntu"
APP_DIR="/opt/kokon"
SWAP_FILE="/swapfile"
SWAP_SIZE="2G"

log() { echo -e "\n\033[1;34m==> $*\033[0m"; }

if [[ $EUID -ne 0 ]]; then
  echo "Запустите через sudo: sudo bash bootstrap.sh" >&2
  exit 1
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "Пользователь $APP_USER не найден" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
# Без этого needrestart в Ubuntu 24.04 останавливает установку вопросом
export NEEDRESTART_MODE=a

log "1/6 Обновление системы"
apt-get update -y
apt-get -o Dpkg::Options::="--force-confold" upgrade -y
apt-get install -y ca-certificates curl git ufw fail2ban unattended-upgrades
timedatectl set-timezone Asia/Bangkok

log "2/6 Swap ${SWAP_SIZE}"
if swapon --show | grep -q "$SWAP_FILE"; then
  echo "swap уже включён"
else
  fallocate -l "$SWAP_SIZE" "$SWAP_FILE"
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE"
  swapon "$SWAP_FILE"
  grep -q "^$SWAP_FILE " /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
fi

log "3/6 Docker"
if command -v docker >/dev/null 2>&1; then
  echo "Docker уже установлен"
else
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
usermod -aG docker "$APP_USER"

log "4/6 Firewall, fail2ban, автообновления"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

log "5/6 Защита SSH"
AUTH_KEYS="/home/$APP_USER/.ssh/authorized_keys"
# Файл называется 00-..., потому что sshd берёт ПЕРВОЕ найденное значение,
# а в Ubuntu рядом лежит 50-cloud-init.conf, который может разрешать пароли.
HARDENING_CONF="/etc/ssh/sshd_config.d/00-kokon-hardening.conf"
if [[ -s "$AUTH_KEYS" ]] && grep -qE '^(ssh-|ecdsa-)' "$AUTH_KEYS"; then
  cat > "$HARDENING_CONF" <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl restart ssh
  SSH_STATUS="вход только по SSH-ключу (пароль отключён)"
else
  SSH_STATUS="ВНИМАНИЕ: SSH-ключ не найден, вход по паролю оставлен. Добавьте ключ и запустите скрипт ещё раз."
fi

log "6/6 Рабочая папка $APP_DIR"
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"

log "ГОТОВО"
echo "Сервер:      $(hostname) / $(grep -oP '^PRETTY_NAME="\K[^"]+' /etc/os-release)"
echo "Часовой пояс: $(timedatectl show -p Timezone --value)"
echo "Docker:      $(docker --version)"
echo "Compose:     $(docker compose version)"
echo "Swap:        $(swapon --show --noheadings | awk '{print $3}')"
echo "Firewall:    $(ufw status | head -1)"
echo "SSH:         $SSH_STATUS"
echo
echo "Выйдите (exit) и зайдите снова, чтобы группа docker применилась к пользователю $APP_USER."
