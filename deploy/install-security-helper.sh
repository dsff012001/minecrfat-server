#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo 'Run as root' >&2; exit 1; fi
APP_USER="${APP_USER:-blockctrl}"
HELPER=/usr/local/sbin/blockctrl-security-helper
cat >"$HELPER" <<'HELPER'
#!/usr/bin/env bash
set -Eeuo pipefail
STATE_DIR=/var/lib/blockctrl-security
RULES="$STATE_DIR/rules.tsv"
mkdir -p "$STATE_DIR"
touch "$RULES"
chmod 0600 "$RULES"
json(){ printf '%s\n' "$1"; }
need_ufw(){ command -v ufw >/dev/null 2>&1 || { echo 'UFW kurulu değil' >&2; exit 4; }; }
valid_port(){ [[ "$1" =~ ^[0-9]+$ ]] && ((1<=10#$1 && 10#$1<=65535)); }
valid_epoch(){ [[ "$1" == "0" || "$1" =~ ^[0-9]{10,13}$ ]]; }
valid_cidr(){ python3 - "$1" <<'PY'
import ipaddress,sys
try: ipaddress.ip_network(sys.argv[1], strict=False)
except Exception: raise SystemExit(1)
PY
}
normalize_epoch(){
  local value="${1:-0}"
  [[ -z "$value" || "$value" == "null" ]] && { echo 0; return; }
  valid_epoch "$value" || { echo 'Geçersiz expiresAt' >&2; exit 3; }
  if (( ${#value} >= 13 )); then echo $((10#$value/1000)); else echo $((10#$value)); fi
}
remove_record(){
  local type="$1" cidr="$2" port="$3" tmp
  tmp="$(mktemp)"
  awk -F'|' -v t="$type" -v c="$cidr" -v p="$port" '!( $1==t && $2==c && $3==p )' "$RULES" >"$tmp"
  cat "$tmp" >"$RULES"; rm -f "$tmp"
}
record_rule(){
  local type="$1" cidr="$2" port="$3" expiry="$4"
  remove_record "$type" "$cidr" "$port"
  printf '%s|%s|%s|%s\n' "$type" "$cidr" "$port" "$expiry" >>"$RULES"
}
delete_ufw_rule(){
  local type="$1" cidr="$2" port="$3"
  case "$type" in
    deny) ufw --force delete deny from "$cidr" to any port "$port" proto tcp >/dev/null 2>&1 || true ;;
    allow) ufw --force delete allow from "$cidr" to any port "$port" proto tcp >/dev/null 2>&1 || true ;;
  esac
}
expire_rules(){
  need_ufw
  local now tmp type cidr port expiry
  now="$(date +%s)"; tmp="$(mktemp)"
  while IFS='|' read -r type cidr port expiry; do
    [[ -z "${type:-}" ]] && continue
    if [[ "${expiry:-0}" != "0" ]] && (( 10#${expiry} <= now )); then
      delete_ufw_rule "$type" "$cidr" "$port"
    else
      printf '%s|%s|%s|%s\n' "$type" "$cidr" "$port" "${expiry:-0}" >>"$tmp"
    fi
  done <"$RULES"
  cat "$tmp" >"$RULES"; rm -f "$tmp"
  json '{"ok":true,"expiredChecked":true}'
}
status(){
  if ! command -v ufw >/dev/null 2>&1; then json '{"ready":false,"provider":"none","rateLimit":false,"managedRules":0,"error":"ufw-not-installed"}'; return; fi
  local p="${1:-25565}" out active=false limited=false count=0
  out="$(ufw status 2>&1 || true)"
  grep -qi 'Status: active' <<<"$out" && active=true
  grep -Eiq "(^|[[:space:]])${p}/tcp.*LIMIT" <<<"$out" && limited=true
  count="$(awk -F'|' -v p="$p" '$3==p {n++} END{print n+0}' "$RULES")"
  printf '{"ready":%s,"provider":"ufw","active":%s,"rateLimit":%s,"managedRules":%s,"port":%s}\n' "$active" "$active" "$limited" "$count" "$p"
}
rule(){
  local op="$1" cidr="$2" port="$3" expires="${4:-0}" expiry type
  need_ufw; valid_cidr "$cidr" || { echo 'Geçersiz IP/CIDR' >&2; exit 3; }; valid_port "$port" || { echo 'Geçersiz port' >&2; exit 3; }
  expiry="$(normalize_epoch "$expires")"
  case "$op" in
    block-ip) type=deny; delete_ufw_rule deny "$cidr" "$port"; ufw --force insert 1 deny from "$cidr" to any port "$port" proto tcp comment 'blockctrl-security' >/dev/null; record_rule deny "$cidr" "$port" "$expiry" ;;
    unblock-ip) type=deny; delete_ufw_rule deny "$cidr" "$port"; remove_record deny "$cidr" "$port" ;;
    allow-ip) type=allow; delete_ufw_rule allow "$cidr" "$port"; ufw --force insert 1 allow from "$cidr" to any port "$port" proto tcp comment 'blockctrl-security' >/dev/null; record_rule allow "$cidr" "$port" "$expiry" ;;
    unallow-ip) type=allow; delete_ufw_rule allow "$cidr" "$port"; remove_record allow "$cidr" "$port" ;;
    *) echo 'Geçersiz IP kuralı işlemi' >&2; exit 2 ;;
  esac
  printf '{"ok":true,"operation":"%s","cidr":"%s","port":%s,"expiresAt":%s}\n' "$op" "$cidr" "$port" "$expiry"
}
case "${1:-}" in
  status) expire_rules >/dev/null 2>&1 || true; status "${2:-25565}" ;;
  block-ip|unblock-ip|allow-ip|unallow-ip) rule "$1" "${2:-}" "${3:-}" "${4:-0}" ;;
  rate-limit-enable) need_ufw; valid_port "${2:-}" || exit 3; ufw --force delete limit "${2}/tcp" >/dev/null 2>&1 || true; ufw --force limit "${2}/tcp" comment 'blockctrl-security-rate-limit' >/dev/null; status "$2" ;;
  rate-limit-disable) need_ufw; valid_port "${2:-}" || exit 3; ufw --force delete limit "${2}/tcp" >/dev/null 2>&1 || true; status "$2" ;;
  expire) expire_rules ;;
  *) echo 'usage: blockctrl-security-helper status|block-ip|unblock-ip|allow-ip|unallow-ip|rate-limit-enable|rate-limit-disable|expire ...' >&2; exit 2 ;;
esac
HELPER
chmod 0755 "$HELPER"
cat >/etc/sudoers.d/blockctrl-security-helper <<EOF2
$APP_USER ALL=(root) NOPASSWD: $HELPER *
EOF2
chmod 0440 /etc/sudoers.d/blockctrl-security-helper
visudo -cf /etc/sudoers.d/blockctrl-security-helper >/dev/null
cat >/etc/systemd/system/blockctrl-security-expiry.service <<EOF2
[Unit]
Description=BlockCtrl security rule expiry cleanup

[Service]
Type=oneshot
ExecStart=$HELPER expire
EOF2
cat >/etc/systemd/system/blockctrl-security-expiry.timer <<'EOF2'
[Unit]
Description=Run BlockCtrl security expiry cleanup every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=15s
Persistent=true

[Install]
WantedBy=timers.target
EOF2
systemctl daemon-reload
systemctl enable --now blockctrl-security-expiry.timer >/dev/null
"$HELPER" status 25565 || true
echo 'BlockCtrl security helper installed. It manages tagged Minecraft-port allow/deny rules with persistent expiry cleanup and UFW connection rate-limit; it never disables SSH or changes Oracle NSG/Security Lists.'
