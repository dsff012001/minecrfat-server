# BlockCtrl Node Agent

Bu servis gerçek Minecraft Java süreçlerini kendi Linux hosting sunucunuzda çalıştırır. Node.js 20+, `tar`, Paper/Vanilla/Fabric 1.20 için Java 17 ve 1.21 için Java 21 kurulu olmalıdır.

## Kurulum

Node agent, web panelden ayrı bir Node.js projesidir. Komutları mutlaka `agent` klasörünün içinde çalıştırın; web panel kök dizinindeki `package.json` ile agent bağımlılıkları aynı değildir.

```bash
cd /opt/blockctrl/agent
node --version   # Node.js 20 veya üzeri
pnpm --version
pnpm install --frozen-lockfile
pnpm build       # dist/index.js oluşturur
```

Çalıştırmadan önce `/etc/blockctrl-agent.env` dosyasını hazırlayın, ardından:

```bash
pnpm start
```

2. Paper kayıp eşya takibi kullanılacaksa `tracker/paper` projesini Java 17 ve Maven ile derleyin; oluşan jar yolunu `TRACKER_JAR` olarak verin.
3. Panelde **Node bağla** ile `NODE_ID` ve yalnız bir kez gösterilen `NODE_TOKEN` değerlerini alın.
4. Agent'ı root olmayan, yalnız `/srv/blockctrl` dizinine erişebilen ayrı bir Linux kullanıcısı altında çalıştırın.

## Ortam değişkenleri

```ini
PANEL_URL=https://panel-adresiniz.com
NODE_ID=...
NODE_TOKEN=...
DATA_DIR=/srv/blockctrl
TRACKER_JAR=/opt/blockctrl/BlockCtrlTracker.jar
```

## systemd

```ini
[Unit]
Description=BlockCtrl Minecraft Node Agent
After=network-online.target

[Service]
Type=simple
User=blockctrl
WorkingDirectory=/opt/blockctrl/agent
EnvironmentFile=/etc/blockctrl-agent.env
ExecStart=/usr/bin/node /opt/blockctrl/agent/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Agent yalnız panele doğru giden HTTPS bağlantısı kurar; inbound reverse proxy gerekmez. Tracker yalnız `127.0.0.1:8788` adresine erişir. Canlı dosyalar `DATA_DIR/servers/<server-id>`, otomatik ve manuel yerel yedekler `DATA_DIR/backups` altında tutulur; bu dizinleri ayrıca VPS snapshot veya harici yedek politikanıza dahil edin. Agent token'ını paylaşmayın, root yetkisi vermeyin ve güvenlik duvarında Minecraft portları dışında yeni inbound port açmayın.
