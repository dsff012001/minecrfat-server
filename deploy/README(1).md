# Ubuntu 24.04 + NeoForge kurulumu

Bu paket, boş bir Ubuntu 24.04 VPS üzerinde BlockCtrl agent için güvenli temel kurulumu yapar. Web panel Vercel'de çalışır; VPS'e yalnızca `agent` klasörü kopyalanır. Node agent dışarıya HTTPS bağlantısı açar, bu yüzden agent için inbound port açılmaz.

## 1. VPS hazırlığı

Önce repo içindeki `agent` klasörünü VPS'e kopyalayın:

```bash
sudo mkdir -p /opt/blockctrl
sudo chown "$USER:$USER" /opt/blockctrl
git clone <REPO_URL> /tmp/blockctrl
cp -a /tmp/blockctrl/agent /opt/blockctrl/agent
```

Ardından panelde **Node bağla** ile aldığınız değerleri kullanarak kurulumu çalıştırın:

```bash
cd /opt/blockctrl
sudo PANEL_URL="https://panel-url.vercel.app" \
  NODE_ID="panelden-alinan-id" \
  NODE_TOKEN="panelde-bir-kez-gosterilen-token" \
  bash /tmp/blockctrl/deploy/install-ubuntu-neoforge.sh
```

Token'ı shell geçmişine yazdırmamak için `HISTCONTROL=ignorespace` kullanabilir veya değişkenleri etkileşimli olarak dışarıdan sağlayabilirsiniz.

## 2. NeoForge sunucusu

Java 21 kurulum tarafından yapılır. NeoForge installer jar'ını indirip ayrı bir oyun dizininde çalıştırın:

```bash
sudo install -d -o blockctrl -g blockctrl /srv/blockctrl/servers/main
cd /srv/blockctrl/servers/main
sudo -u blockctrl curl -fL -o neoforge-installer.jar \
  https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-installer.jar
sudo -u blockctrl java -jar neoforge-installer.jar --installServer
sudo -u blockctrl sed -i 's/^eula=false/eula=true/' eula.txt
```

Panelde server kaydını oluştururken çalışma dizinini `/srv/blockctrl/servers/main` olarak tanımlayın. NeoForge sürümünü Minecraft sürümünüzle eşleştirin; `NEOFORGE_VERSION` ve `MC_VERSION` installer'a başlamadan önce değiştirilebilir.

## 3. Kontrol

```bash
systemctl status blockctrl-agent
journalctl -u blockctrl-agent -f
node --version
pnpm --version
```

Kurulum `blockctrl` adlı root olmayan kullanıcı ile çalışır. Firewall yalnızca SSH ve Minecraft varsayılan TCP portunu açar. SSL/IP erişimi için Nginx kuruludur; panel Vercel'de olduğu için VPS'e reverse proxy yapılandırılmaz. Alan adı eklendiğinde Nginx ve Let's Encrypt ayrı bir adım olarak etkinleştirilebilir.
