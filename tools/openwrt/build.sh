#!/bin/sh
set -eu
PROJECT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
CACHE=${FREEISP_OPENWRT_CACHE:-/opt/freeisp-openwrt-cache}
VERSION=25.12.5
BUILDER="$CACHE/openwrt-imagebuilder-$VERSION-x86-64.Linux-x86_64"
OUT="$PROJECT/artifacts/releases/freeisp-openwrt"
FILES="$CACHE/freeisp-files"
mkdir -p "$CACHE" "$OUT" "$FILES"
[ -n "${FREEISP_CREDENTIALS:-}" ] && [ -f "$FREEISP_CREDENTIALS" ] || { echo 'Provide private FREEISP_CREDENTIALS JSON, never commit it.'; exit 1; }
if [ ! -f "$CACHE/imagebuilder.tar.zst" ]; then
    curl -fL --retry 2 "https://downloads.openwrt.org/releases/$VERSION/targets/x86/64/openwrt-imagebuilder-$VERSION-x86-64.Linux-x86_64.tar.zst" -o "$CACHE/imagebuilder.tar.zst"
fi
printf '%s  %s\n' '313221253d9bac534e4a4ee6492a4941b4ba0f43200eceb8d16a4785470ae9df' "$CACHE/imagebuilder.tar.zst" | sha256sum -c -
[ -d "$BUILDER" ] || tar --zstd -xf "$CACHE/imagebuilder.tar.zst" -C "$CACHE"
cp -a "$PROJECT/openwrt/files/." "$FILES/"
chmod 755 "$FILES/etc/uci-defaults/99-freeisp" "$FILES/usr/bin/freeisp-resources"
chmod 755 "$FILES/usr/libexec/freeisp-bridge-status"
chmod 755 "$FILES/etc/uci-defaults/98-freeisp-wifi" "$FILES/etc/uci-defaults/99-freeisp" "$FILES/usr/bin/freeisp-resources"
chmod 600 "$FILES/etc/config/freeisp_wifi"
chmod 755 "$FILES/etc/uci-defaults/98-freeisp-pppoe" "$FILES/etc/init.d/freeisp-pppoe" "$FILES/usr/libexec/"freeisp-* "$FILES/usr/libexec/rpcd/freeisp.pppoe"
chmod 755 "$FILES/usr/bin/freeisp-command-line"
python3 "$PROJECT/tools/openwrt/release-manifest.py" --root "$FILES"
chmod 755 "$FILES/etc/uci-defaults/98-freeisp-hotspot" \
    "$FILES/etc/init.d/freeisp-hotspot" "$FILES/usr/libexec/rpcd/freeisp.hotspot"
chmod 755 "$FILES/etc/uci-defaults/98-freeisp-tools" "$FILES/etc/init.d/freeisp-tools" "$FILES/usr/libexec/rpcd/freeisp.tools"
chmod 600 "$FILES/etc/config/freeisp_tools"
chmod 755 "$FILES/etc/uci-defaults/98-freeisp-api" "$FILES/etc/uci-defaults/99-freeisp-ftp" \
    "$FILES/etc/init.d/freeisp-api" "$FILES/etc/init.d/freeisp-ftp" "$FILES/usr/bin/freeisp-api"
chmod 755 "$FILES/etc/uci-defaults/99-freeisp" "$FILES/usr/bin/freeisp-resources" "$FILES/usr/bin/freeisp-firewall-status"
mkdir -p "$FILES/etc/freeisp"
export FREEISP_FILES="$FILES"
python3 - <<'PY'
import json, os, subprocess
from pathlib import Path
password = json.loads(Path(os.environ['FREEISP_CREDENTIALS']).read_text())['password']
assert isinstance(password, str) and password and '\n' not in password
hashed = subprocess.run(['openssl', 'passwd', '-6', '-stdin'], input=password+'\n', text=True, capture_output=True, check=True).stdout
target = Path(os.environ['FREEISP_FILES'])/'etc/freeisp/root.hash'
target.write_text(hashed)
target.chmod(0o600)
PY
PACKAGES=$(tr '\n' ' ' < "$PROJECT/openwrt/packages.txt")
cd "$BUILDER"
make image PROFILE=generic PACKAGES="$PACKAGES" FILES="$FILES" ROOTFS_PARTSIZE=512
cp bin/targets/x86/64/openwrt-$VERSION-x86-64-generic-ext4-combined.img.gz "$OUT/freeisp-openwrt-x86-64.img.gz"
cp bin/targets/x86/64/*.manifest "$OUT/"
cp "$PROJECT/tools/openwrt/run.sh" "$OUT/run.sh"
chmod 755 "$OUT/run.sh"
cd "$OUT"
sha256sum freeisp-openwrt-x86-64.img.gz > SHA256SUMS
git -C "$PROJECT" rev-parse HEAD > SOURCE_COMMIT
echo 'FreeISP OpenWrt image built. Private credentials are embedded; do not publish this personalized image.'
