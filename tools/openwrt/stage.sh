#!/bin/sh
set -eu
PROJECT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$PROJECT"
git diff --exit-code
git diff --cached --exit-code
[ "$(id -u)" = 0 ] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends build-essential gawk libncurses-dev libssl-dev zlib1g-dev python3 python3-setuptools rsync unzip file wget curl zstd qemu-system-x86 qemu-utils
sh tools/openwrt/build.sh
OUT="$PROJECT/artifacts/releases/freeisp-openwrt"
# Never overwrite a running or previously configured appliance disk.
[ ! -e "$OUT/router.raw" ] || { echo 'Existing router.raw retained; use a new staging directory for another image.'; exit 1; }
gzip -dc "$OUT/freeisp-openwrt-x86-64.img.gz" > "$OUT/router.raw"
id freeisp-lab >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin freeisp-lab
chown freeisp-lab:freeisp-lab "$OUT/router.raw"
chmod 600 "$OUT/router.raw"
cat > /etc/systemd/system/freeisp-openwrt.service <<EOF
[Unit]
Description=FreeISP OpenWrt virtual router
After=network.target
[Service]
Type=simple
User=freeisp-lab
WorkingDirectory=$OUT
Environment=WEB_PORT=8890
ExecStart=/bin/sh $OUT/run.sh
Restart=always
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$OUT/router.raw
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl start freeisp-openwrt
echo 'Staged OpenWrt management on loopback port 8890. Existing lab remains unchanged.'
