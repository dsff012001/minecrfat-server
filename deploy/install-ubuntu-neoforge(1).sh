#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then echo "Run as root: sudo bash $0" >&2; exit 1; fi
if [[ "$(. /etc/os-release && echo "$ID:$VERSION_ID")" != "ubuntu:24.04" && "$(. /etc/os-release && echo "$ID:$VERSION_ID")" != "ubuntu:20.04" ]]; then echo "This installer targets Ubuntu 20.04 or 24.04." >&2; exit 1; fi
APP_USER="${APP_USER:-blockctrl}"
APP_ROOT="${APP_ROOT:-/opt/blockctrl}"
DATA_DIR="${DATA_DIR:-/srv/blockctrl}"
PANEL_URL="${PANEL_URL:-}"
NODE_ID="${NODE_ID:-}"
NODE_TOKEN="${NODE_TOKEN:-}"
NEOFORGE_VERSION="${NEOFORGE_VERSION:-21.1.77}"
MC_VERSION="${MC_VERSION:-1.21.1}"
NEOFORGE_URL="${NEOFORGE_URL:-https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-installer.jar}"
AGENT_REPO_URL="${AGENT_REPO_URL:-}"

if [[ "$PANEL_URL" == *localhost* || "$PANEL_URL" == *127.0.0.1* || "$PANEL_URL" != https://* ]]; then echo "PANEL_URL must be a public HTTPS panel URL." >&2; exit 1; fi
for value in PANEL_URL NODE_ID NODE_TOKEN; do
  if [[ -z "${!value}" ]]; then echo "Missing ${value}. Set it before running." >&2; exit 1; fi
done

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl unzip tar git nginx ufw openjdk-21-jre-headless
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
corepack enable
corepack prepare pnpm@10.15.0 --activate

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_ROOT" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_ROOT" "$DATA_DIR/servers" "$DATA_DIR/backups"

if [[ ! -d "$APP_ROOT/agent" ]]; then
  if [[ -z "$AGENT_REPO_URL" ]]; then echo "Agent bulunamadı. AGENT_REPO_URL ile GitHub repo adresi verin." >&2; exit 2; fi
  git clone --depth 1 "$AGENT_REPO_URL" /tmp/blockctrl-agent-repo
  if [[ ! -f /tmp/blockctrl-agent-repo/package.json ]]; then echo "Repo içinde package.json bulunamadı." >&2; exit 2; fi
  install -d "$APP_ROOT/agent"
  cp -a /tmp/blockctrl-agent-repo/. "$APP_ROOT/agent/"
  rm -rf /tmp/blockctrl-agent-repo
fi
chown -R "$APP_USER:$APP_USER" "$APP_ROOT" "$DATA_DIR"
sudo -u "$APP_USER" bash -lc "cd '$APP_ROOT/agent' && pnpm install --frozen-lockfile && pnpm build"

install -m 600 -o root -g root /dev/null /etc/blockctrl-agent.env
cat >/etc/blockctrl-agent.env <<EOF
PANEL_URL=$PANEL_URL
NODE_ID=$NODE_ID
NODE_TOKEN=$NODE_TOKEN
DATA_DIR=$DATA_DIR
EOF

cat >/etc/systemd/system/blockctrl-agent.service <<EOF
[Unit]
Description=BlockCtrl Minecraft Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_ROOT/agent
EnvironmentFile=/etc/blockctrl-agent.env
ExecStart=/usr/bin/node $APP_ROOT/agent/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now blockctrl-agent.service
ufw allow OpenSSH
ufw allow 25565/tcp
ufw --force enable

echo "Installed BlockCtrl agent and NeoForge prerequisites."
echo "NeoForge installer URL: $NEOFORGE_URL"
echo "Run the NeoForge installer in a server directory, then accept eula.txt before starting Minecraft."
 systemctl --no-pager --full status blockctrl-agent.service || true
