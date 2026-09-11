#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo 'Run as root.' >&2; exit 1; fi

APP_USER="${APP_USER:-blockctrl}"
SFTP_CHROOT_BASE="${SFTP_CHROOT_BASE:-/srv/blockctrl-sftp}"

if ! command -v setfacl >/dev/null 2>&1 || ! command -v nsenter >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y acl util-linux
  else
    echo 'setfacl/nsenter bulunamadı. POSIX ACL ve util-linux paketleri kurulmalı.' >&2
    exit 1
  fi
fi

install -d -m 0750 -o root -g root /usr/local/sbin
install -d -m 0755 -o root -g root "$SFTP_CHROOT_BASE"

cat >/usr/local/sbin/blockctrl-sftp-helper <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail

op=${1:-}
server=${2:-}
username=${3:-}
extra=${4:-}
app_user="${BLOCKCTRL_APP_USER:-blockctrl}"
chroot_base="${BLOCKCTRL_SFTP_CHROOT_BASE:-/srv/blockctrl-sftp}"

# blockctrl-agent ProtectSystem/PrivateTmp nedeniyle ayrı mount namespace kullanır.
# Privileged helper root olduktan sonra host mount namespace'e geçer; böylece bind
# mount ve /etc değişiklikleri sshd ve reboot sonrasında gerçekten görünür olur.
host_mnt="$(readlink /proc/1/ns/mnt 2>/dev/null || true)"
self_mnt="$(readlink /proc/self/ns/mnt 2>/dev/null || true)"
if [[ -n "$host_mnt" && -n "$self_mnt" && "$host_mnt" != "$self_mnt" ]]; then
  command -v nsenter >/dev/null 2>&1 || { echo 'nsenter is required' >&2; exit 7; }
  exec nsenter -t 1 -m -- "$0" "$@"
fi

[[ "$server" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || { echo 'invalid server id' >&2; exit 2; }
server="${server,,}"
compact="${server//-/}"
expected_username="mc_${compact:0:12}"
[[ "$username" =~ ^mc_[a-f0-9]{12}$ && "$username" == "$expected_username" ]] || { echo 'invalid username for server' >&2; exit 2; }

root="/srv/blockctrl/servers/$server"
chroot="$chroot_base/$username"
mount_dir="$chroot/files"
old_chroot="/srv/blockctrl/sftp-chroot/$username"
marker="# blockctrl-sftp:$username"

json_bool(){ [[ "$1" == "true" ]] && printf 'true' || printf 'false'; }
sshd_bin(){ command -v sshd || command -v /usr/sbin/sshd || true; }
ssh_service(){ systemctl is-active --quiet ssh 2>/dev/null || systemctl is-active --quiet sshd 2>/dev/null; }
ssh_port(){ local bin; bin="$(sshd_bin)"; [[ -n "$bin" ]] || { printf '22'; return; }; "$bin" -T 2>/dev/null | awk '$1=="port"{print $2;exit}' | grep -E '^[0-9]+$' || printf '22'; }
ensure_server_root(){ [[ -d "$root" ]] || { echo 'server root does not exist' >&2; exit 3; }; }
ensure_user(){ id "$username" >/dev/null 2>&1 || { echo 'sftp user does not exist' >&2; exit 4; }; }

prepare_acl(){
  ensure_server_root
  id "$app_user" >/dev/null 2>&1 || { echo "agent user $app_user does not exist" >&2; exit 5; }
  command -v setfacl >/dev/null 2>&1 || { echo 'setfacl is required' >&2; exit 5; }
  local current_owner
  current_owner="$(stat -c '%U' "$root" 2>/dev/null || true)"
  if [[ "$current_owner" == mc_* ]]; then chown "$app_user:$app_user" "$root"; fi
  setfacl -R -m "u:$username:rwX,u:$app_user:rwX,m::rwx" "$root"
  find "$root" -type d -exec setfacl -m "d:u::rwx,d:u:$username:rwx,d:u:$app_user:rwx,d:g::r-x,d:m::rwx,d:o::---" {} +
}

persist_bind(){
  local tmp skip=false line
  tmp="$(mktemp)"
  if [[ -f /etc/fstab ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "$marker" ]]; then skip=true; continue; fi
      if [[ "$skip" == true ]]; then skip=false; continue; fi
      [[ "$line" == *" $mount_dir "* ]] && continue
      printf '%s\n' "$line" >>"$tmp"
    done </etc/fstab
  fi
  printf '%s\n' "$marker" >>"$tmp"
  printf '%s %s none bind,nosuid,nodev,nofail 0 0\n' "$root" "$mount_dir" >>"$tmp"
  install -m 0644 -o root -g root "$tmp" /etc/fstab
  rm -f "$tmp"
}

mount_server(){
  install -d -m 0755 -o root -g root "$chroot" "$mount_dir"
  if mountpoint -q "$old_chroot/files" 2>/dev/null; then umount "$old_chroot/files" || true; fi
  if mountpoint -q "$mount_dir"; then umount "$mount_dir"; fi
  mount --bind "$root" "$mount_dir"
  mount -o remount,bind,nosuid,nodev "$mount_dir" 2>/dev/null || true
  persist_bind
}

chroot_secure(){
  local path uid mode
  for path in /srv "$chroot_base" "$chroot"; do
    [[ -d "$path" ]] || return 1
    read -r uid mode < <(stat -c '%u %a' "$path")
    [[ "$uid" == 0 ]] || return 1
    local group=$(( (10#$mode / 10) % 10 )) other=$(( 10#$mode % 10 ))
    (( (group & 2) == 0 && (other & 2) == 0 )) || return 1
  done
}

effective_sshd_ok(){
  local bin cfg
  bin="$(sshd_bin)"; [[ -n "$bin" ]] || return 1
  cfg="$($bin -T -C user=$username,host=localhost,addr=127.0.0.1 2>/dev/null)" || return 1
  grep -q '^forcecommand internal-sftp -d /files -u 0002$' <<<"$cfg" || return 1
  grep -q '^chrootdirectory /srv/blockctrl-sftp/%u$' <<<"$cfg" || return 1
  grep -q '^passwordauthentication yes$' <<<"$cfg" || return 1
}

account_locked(){
  ensure_user
  local state
  state="$(passwd -S "$username" 2>/dev/null | awk '{print $2}')"
  [[ "$state" == "L" || "$state" == "LK" ]]
}

case "$op" in
  create)
    [[ -n "$username" ]] || exit 2
    ensure_server_root
    IFS= read -r password
    [[ ${#password} -ge 20 && ${#password} -le 256 ]] || { echo 'invalid password length' >&2; exit 2; }
    install -d -m 0755 -o root -g root "$chroot_base"
    id "$username" >/dev/null 2>&1 || useradd --no-create-home --shell /usr/sbin/nologin --home-dir /files "$username"
    usermod --home /files --shell /usr/sbin/nologin "$username"
    printf '%s:%s\n' "$username" "$password" | chpasswd
    usermod --unlock "$username" >/dev/null 2>&1 || true
    prepare_acl
    mount_server
    printf '{"ok":true,"username":"%s","port":%s,"rootPath":"/files","chrootPath":"%s"}\n' "$username" "$(ssh_port)" "$chroot"
    ;;
  rotate-password)
    [[ -n "$username" ]] || exit 2
    ensure_user
    IFS= read -r password
    [[ ${#password} -ge 20 && ${#password} -le 256 ]] || { echo 'invalid password length' >&2; exit 2; }
    printf '%s:%s\n' "$username" "$password" | chpasswd
    usermod --unlock "$username" >/dev/null 2>&1 || true
    prepare_acl
    mount_server
    printf '{"ok":true,"username":"%s","port":%s,"rotated":true}\n' "$username" "$(ssh_port)"
    ;;
  status)
    [[ -n "$username" ]] || exit 2
    user_exists=false; id "$username" >/dev/null 2>&1 && user_exists=true
    mounted=false; mountpoint -q "$mount_dir" 2>/dev/null && mounted=true
    sshd_valid=false; bin="$(sshd_bin)"; [[ -n "$bin" ]] && "$bin" -t >/dev/null 2>&1 && effective_sshd_ok && sshd_valid=true
    service_active=false; ssh_service && service_active=true
    secure_chroot=false; chroot_secure && secure_chroot=true
    locked=true
    if [[ "$user_exists" == true ]]; then account_locked || locked=false; fi
    enabled=false; [[ "$locked" == false ]] && enabled=true
    root_exists=false; [[ -d "$root" ]] && root_exists=true
    ready=false
    if [[ "$user_exists" == true && "$root_exists" == true && "$mounted" == true && "$sshd_valid" == true && "$service_active" == true && "$secure_chroot" == true && "$enabled" == true ]]; then ready=true; fi
    printf '{"ok":true,"ready":%s,"enabled":%s,"userExists":%s,"rootExists":%s,"mounted":%s,"sshdValid":%s,"serviceActive":%s,"secureChroot":%s,"port":%s,"username":"%s","rootPath":"/files","chrootPath":"%s"}\n' \
      "$(json_bool "$ready")" "$(json_bool "$enabled")" "$(json_bool "$user_exists")" "$(json_bool "$root_exists")" "$(json_bool "$mounted")" "$(json_bool "$sshd_valid")" "$(json_bool "$service_active")" "$(json_bool "$secure_chroot")" "$(ssh_port)" "$username" "$chroot"
    ;;
  enable)
    [[ -n "$username" ]] || exit 2
    ensure_user
    prepare_acl
    mount_server
    usermod --unlock "$username" >/dev/null 2>&1 || true
    printf '{"ok":true,"enabled":true,"port":%s}\n' "$(ssh_port)"
    ;;
  disable)
    [[ -n "$username" ]] || exit 2
    ensure_user
    usermod --lock "$username"
    pkill -TERM -u "$username" 2>/dev/null || true
    printf '{"ok":true,"enabled":false}\n'
    ;;
  sessions)
    [[ -n "$username" ]] || exit 2
    ensure_user
    first=true
    printf '{"ok":true,"sessions":['
    while read -r pid elapsed comm; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      [[ "$comm" == sshd || "$comm" == sftp-server ]] || continue
      if [[ "$first" == true ]]; then first=false; else printf ','; fi
      printf '{"pid":%s,"elapsedSeconds":%s,"process":"%s"}' "$pid" "${elapsed:-0}" "$comm"
    done < <(ps -u "$username" -o pid=,etimes=,comm= 2>/dev/null || true)
    printf ']}\n'
    ;;
  terminate-session)
    [[ -n "$username" && "$extra" =~ ^[0-9]+$ ]] || exit 2
    ensure_user
    owner="$(ps -o user= -p "$extra" 2>/dev/null | xargs || true)"
    comm="$(ps -o comm= -p "$extra" 2>/dev/null | xargs || true)"
    [[ "$owner" == "$username" && ( "$comm" == "sshd" || "$comm" == "sftp-server" ) ]] || { echo 'session not owned by sftp user' >&2; exit 6; }
    kill -TERM "$extra" 2>/dev/null || true
    sleep 1
    kill -KILL "$extra" 2>/dev/null || true
    printf '{"ok":true,"terminated":%s}\n' "$extra"
    ;;
  delete)
    [[ -n "$username" ]] || exit 2
    pkill -TERM -u "$username" 2>/dev/null || true
    mountpoint -q "$mount_dir" 2>/dev/null && umount "$mount_dir" || true
    tmp="$(mktemp)"; skip=false
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == "$marker" ]]; then skip=true; continue; fi
      if [[ "$skip" == true ]]; then skip=false; continue; fi
      [[ "$line" == *" $mount_dir "* ]] && continue
      printf '%s\n' "$line" >>"$tmp"
    done </etc/fstab
    install -m 0644 -o root -g root "$tmp" /etc/fstab
    rm -f "$tmp"
    userdel "$username" 2>/dev/null || true
    rm -rf "$chroot" "$old_chroot"
    printf '{"ok":true,"deleted":true}\n'
    ;;
  *) echo 'unsupported operation' >&2; exit 2 ;;
esac
HELPER

chmod 0750 /usr/local/sbin/blockctrl-sftp-helper
install -d -m 0755 /etc/sudoers.d
cat >/etc/sudoers.d/blockctrl-sftp-helper <<SUDO
$APP_USER ALL=(root) NOPASSWD: /usr/local/sbin/blockctrl-sftp-helper
SUDO
chmod 0440 /etc/sudoers.d/blockctrl-sftp-helper
visudo -cf /etc/sudoers.d/blockctrl-sftp-helper >/dev/null

# blockctrl-agent normalde root değildir. Sadece yukarıdaki sudoers allowlist'indeki
# doğrulamalı SFTP helper'ına privilege transition yapabilmesi için NNP kapatılır.
install -d -m 0755 /etc/systemd/system/blockctrl-agent.service.d
cat >/etc/systemd/system/blockctrl-agent.service.d/20-sftp-helper.conf <<'SYSTEMD'
[Service]
NoNewPrivileges=false
SYSTEMD
systemctl daemon-reload

install -d -m 0755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/90-blockctrl-sftp.conf <<'SSH'
Match User mc_*
    ForceCommand internal-sftp -d /files -u 0002
    ChrootDirectory /srv/blockctrl-sftp/%u
    PasswordAuthentication yes
    KbdInteractiveAuthentication no
    PubkeyAuthentication no
    AllowAgentForwarding no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitTTY no
    PermitUserRC no
SSH

if command -v sshd >/dev/null 2>&1; then
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi

# Eski BlockCtrl chroot düzenini mümkünse veri silmeden yeni root-owned yapıya taşı.
if compgen -G '/srv/blockctrl/sftp-chroot/mc_*' >/dev/null; then
  for old in /srv/blockctrl/sftp-chroot/mc_*; do
    [[ -d "$old" ]] || continue
    username="$(basename "$old")"
    prefix="${username#mc_}"
    matches=()
    for candidate in /srv/blockctrl/servers/*; do
      [[ -d "$candidate" ]] || continue
      sid="$(basename "$candidate")"
      compact="${sid//-/}"
      [[ "$compact" == "$prefix"* ]] && matches+=("$sid")
    done
    if [[ ${#matches[@]} -eq 1 ]] && id "$username" >/dev/null 2>&1; then
      BLOCKCTRL_APP_USER="$APP_USER" BLOCKCTRL_SFTP_CHROOT_BASE="$SFTP_CHROOT_BASE" /usr/local/sbin/blockctrl-sftp-helper enable "${matches[0]}" "$username" >/dev/null || echo "SFTP migration warning: $username" >&2
    fi
  done
fi

printf 'SFTP helper installed. Chroot base: %s\n' "$SFTP_CHROOT_BASE"
