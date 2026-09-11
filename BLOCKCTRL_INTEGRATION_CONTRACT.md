# BlockCtrl integration contract

Bu dosya, panel tarafında hazırlanmış özelliklerin Oracle/VPS agent entegrasyonunda hangi sözleşmelerle bağlanacağını tanımlar. Mevcut çalışan komutlar ve veri yapıları korunur; root yetkisi web uygulamasına verilmez.

## Capability modeli

Panel yalnız gerçekten desteklenen capability değerlerinde ilgili entegrasyon kontrollerini etkinleştirir. Agent tarafı hazır oldukça `server_settings.capabilities` dizisine capability eklenir.

Temel mevcut yetenekler: `properties`, `port`, `world`, `backup`, `scheduler`, `database`, `sftp`, `upload`, `files`, `console`, `audit`, `rbac`, `loader`.

SFTP politika/telemetri ayrımı: `sftp-actions`, `sftp-policy`, `sftp-telemetry`. Temel `sftp` capability yalnız çalışan çekirdek SFTP yöneticisini ifade eder; henüz uygulanmayan politika alanları bu capability ile sahte şekilde açılmaz.

Yeni entegrasyon capability değerleri: `file-browser`, `bulk-download`, `file-security`, `security-agent`, `firewall`, `anticheat`, `players`, `addons`, `logs`, `metrics`, `metrics-history`, `geoip`, `notifications`, `updates`, `offsite-backup`, `proxy`, `process`, `java`, `java-env`, `paper-config`, `storage`, `advanced-security`, `auth-addon`, `discord`, `dns`.

## Ayar uygulama

`PATCH /api/panel-settings`

Panel güvenli şekilde JSON ayarlarını saklar, audit kaydı üretir ve bilinen `server.properties` anahtarlarını mevcut `set-properties` agent komutuna dönüştürür. Diğer ayarlar `apply-settings` komutuna ayrılır. Parola, secret, token, API key ve credential değerleri bu tabloda düz metin saklanmaz.

`apply-settings` payload:

```json
{
  "changes": { "settingKey": "value" },
  "source": "panel-settings-v2",
  "safeMode": true
}
```

## Genel agent eylemleri

`POST /api/server-actions` bütün yeni entegrasyon komutlarını `agent_commands` kuyruğuna ekler ve audit log yazar. Riskli eylemler `confirm: true` gerektirir.

Dosya: `file-inventory`, `bulk-download`, `file-create`, `folder-create`, `file-rename`, `file-move`, `file-copy`, `file-delete`, `file-download`, `folder-download`, `file-read`, `file-write`, `file-permissions`, `file-bulk-delete`, `file-bulk-move`, `upload-retry`, `upload-history-clear`.

Güvenlik: `security-scan`, `scan-files`, `scan-mods`, `scan-plugins`, `scan-config`, `scan-zip`, `jar-metadata`, `hash-files`, `quarantine-file`, `restore-quarantine`, `delete-quarantine`, `login-security-status`, `network-security-status`, `firewall-status`, `port-scan`.

Anti-cheat: `anticheat-status`, `anticheat-update`, `anticheat-configure`.

Oyuncu: `player-details`, `player-inventory`, `player-enderchest`, `player-history`, `player-note`, `player-action`.

Veritabanı: `database-backup`, `database-restore`, `database-export`, `database-import`, `database-optimize`, `database-repair`, `database-user`, `database-permissions`.

Yedek: `backup-verify`, `backup-copy`.

Yazılım: `software-compatibility`, `addon-scan`, `addon-update`, `addon-toggle`.

Günlük: `logs-export`, `crash-reports`, `agent-logs`, `server-startup-logs`.

SFTP kuyruk uyumluluğu: `sftp-test`, `sftp-disable`, `sftp-enable`, `sftp-session-list`, `sftp-session-terminate`. Canlı panel işlemleri parola düz metnini `agent_commands` içine yazmamak için kimliği doğrulanmış node bridge üzerinden `/internal/sftp/*` uçlarına gider.


## SFTP güvenli çalışma modeli

- SFTP kullanıcı adı server UUID'sinden deterministik olarak `mc_<12hex>` biçiminde üretilir.
- Agent `blockctrl` kullanıcısı olarak kalır. SFTP helper için systemd `NoNewPrivileges=false` gerekir; root geçişi yalnız `/etc/sudoers.d/blockctrl-sftp-helper` içindeki tek helper allowlist'i üzerinden yapılır ve helper server UUID/kullanıcı/PID girdilerini tekrar doğrular. `ProtectSystem` ve `PrivateTmp` korunur; helper root olduktan sonra gerektiğinde `nsenter -t 1 -m` ile host mount namespace'e geçer, böylece SFTP bind mount'u sshd tarafından gerçekten görülür ve reboot sonrası fstab kaydı kalıcıdır.
- Parola node/agent üzerinde kriptografik olarak üretilir; panel yalnız tek HTTP yanıtında kullanıcıya gösterir ve veritabanında sadece SHA-256 özeti tutulur. Parola `agent_commands.payload`, audit log veya kalıcı panel ayarlarına yazılmaz.
- OpenSSH chroot `/srv/blockctrl-sftp/<username>` altında root sahipli ve group/other write kapalı olacak şekilde tutulur. Minecraft sunucu dizini `/srv/blockctrl/servers/<serverId>` sahipliği değiştirilmez.
- Sunucu dosyaları chroot içindeki `/files` dizinine bind mount edilir; mount `/etc/fstab` ile reboot sonrasında da korunur.
- SFTP kullanıcısı ve `blockctrl` agent kullanıcısı sunucu dosyalarında POSIX ACL ile birlikte yazabilir. Böylece SFTP oluşturmak agent'ın dosya sahipliğini bozmaz.
- `status` kontrolü kullanıcı, sunucu dizini, bind mount, chroot ownership/mode, etkili sshd Match ayarı ve SSH servis durumunu doğrular.
- `disable` hesabı kilitler ve aktif SFTP oturumlarını kapatır; `enable` ACL/mount durumunu tekrar kurar ve hesabı açar.
- Oturum sonlandırma yalnız ilgili SFTP kullanıcısına ait doğrulanmış `sshd`/`sftp-server` PID'lerinde çalışır.
- Oracle Cloud Security List/NSG veya işletim sistemi firewall kuralları helper tarafından otomatik sıfırlanmaz/değiştirilmez; dış port erişimi ayrı altyapı ayarıdır.

## File inventory sonucu

`file-inventory` tamamlandığında `agent_commands.result` en az şu biçimde olmalıdır:

```json
{
  "items": [
    {
      "path": "mods/example.jar",
      "name": "example.jar",
      "type": "jar",
      "sizeBytes": 123456,
      "modifiedAt": "2026-09-10T00:00:00.000Z",
      "permissions": "0644"
    }
  ]
}
```

## Bulk download sonucu

`bulk-download` durumları: `queued`, `preparing`, `compressing`, `ready`, `failed`, `expired`. Tamamlanan komutun result alanı `filename`, `sizeBytes`, `progress`, `downloadUrl`, `expiresAt` içerebilir. Geçici ZIP süre dolduğunda agent tarafından silinmelidir. Path traversal ve Zip Slip kontrolleri zorunludur.

## Güvenlik ilkeleri

- Web uygulaması root çalıştırmaz.
- Privileged işler mevcut güvenli agent/helper katmanında yürür.
- Mevcut firewall kuralları otomatik sıfırlanmaz.
- World/backup restore önce güvenli yedek/snapshot mekanizması kullanır.
- Veritabanları DROP/recreate edilmez; silme açık onay gerektirir.
- Binary/JAR/world dosyaları metin editörüyle açılmaz.
- Parolalar yalnız oluşturma/rotasyon sonucunda tek sefer gösterilir.
- Unsupported capability panelde çalışıyormuş gibi gösterilmez.
