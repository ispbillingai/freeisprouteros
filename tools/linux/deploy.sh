#!/bin/sh
set -eu
# Run from an already-cloned GitHub commit on a dedicated Ubuntu development VPS.
# This starts the virtual appliance; it does not turn the VPS host into a router.
PROJECT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$PROJECT"
[ "$(id -u)" = 0 ] || { echo 'Run deployment with sudo.'; exit 1; }
git diff --exit-code
git diff --cached --exit-code
COMMIT=$(git rev-parse HEAD)
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils curl ca-certificates cpio e2fsprogs python3
sh tools/linux/prepare.sh
# Do not rebuild or test a state disk in use by the service.
if systemctl is-active --quiet freeisp-lab; then
    echo 'Stop freeisp-lab and back up its state before deploying a new image.'
    exit 1
fi
sh tools/linux/validate.sh
OUT="$PROJECT/artifacts/releases/freeisp-linux-lab"
id freeisp-lab >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin freeisp-lab
chown freeisp-lab:freeisp-lab "$OUT/state.raw"
chmod 600 "$OUT/state.raw" "$OUT/credentials.json" "$OUT/CREDENTIALS.txt"
cat > /etc/systemd/system/freeisp-lab.service <<EOF
[Unit]
Description=FreeISP isolated virtual router lab
After=network.target
[Service]
Type=simple
User=freeisp-lab
WorkingDirectory=$OUT
ExecStart=/bin/sh $OUT/run.sh
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$OUT/state.raw
[Install]
WantedBy=multi-user.target
EOF
printf '%s\n' "$COMMIT" > "$OUT/DEPLOYED_COMMIT"
systemctl daemon-reload
systemctl enable --now freeisp-lab
echo "Deployed GitHub commit $COMMIT; management is loopback-only at https://127.0.0.1:8843"
