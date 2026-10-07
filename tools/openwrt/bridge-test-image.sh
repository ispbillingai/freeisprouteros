#!/bin/sh
# Linux root only. Mutates a disposable copy, never the source image or host network.
# Usage: sh bridge-test-image.sh IMAGE.img.gz PROJECT OUTPUT IP-BRIDGE.apk
set -eu
if [ "${1:-}" != --inside ]; then
    [ "$#" = 4 ] || { echo 'Usage: IMAGE.img.gz PROJECT OUTPUT IP-BRIDGE.apk'; exit 2; }
    FREEISP_BRIDGE_TMP=$(mktemp -d /tmp/freeisp-bridge-test.XXXXXX)
    export FREEISP_BRIDGE_TMP
    # Cleanup runs after namespace PID 1 exits, so no child can retain a mount.
    trap 'case "$FREEISP_BRIDGE_TMP" in /tmp/freeisp-bridge-test.*) rm -rf "$FREEISP_BRIDGE_TMP";; esac' EXIT INT TERM
    unshare --mount --net --pid --fork sh "$0" --inside "$@"
    exit
fi
shift
image=$1 project=$2 output=$3 package=$4
[ "$(id -u)" = 0 ] || exit 2
mount --make-rprivate /
testdir=${FREEISP_BRIDGE_TMP:?}
# Exiting namespace PID 1 kills remaining service children and releases these
# private mounts. Only then does the outer process remove the disposable image.
mkdir -p "$testdir/root" "$output"
gzip -dc "$image" > "$testdir/router.img"
sector=$(od -An -tu4 -j470 -N4 "$testdir/router.img" | tr -d ' ')
[ "$sector" -gt 0 ]
mount -o "loop,offset=$((sector * 512))" "$testdir/router.img" "$testdir/root"
mount -t proc proc "$testdir/root/proc"
mount -t sysfs sysfs "$testdir/root/sys"
mount -t tmpfs tmpfs "$testdir/root/dev"
mknod "$testdir/root/dev/null" c 1 3
mknod "$testdir/root/dev/zero" c 1 5
mknod "$testdir/root/dev/random" c 1 8
mknod "$testdir/root/dev/urandom" c 1 9
chmod 666 "$testdir/root/dev/"*
mkdir -p "$testdir/root/tmp/bridge-repo"
cp "$package" "$testdir/root/tmp/bridge-repo/$(basename "$package")"
cp "$(dirname "$package")/packages.adb" "$testdir/root/tmp/bridge-repo/packages.adb"
printf '/tmp/bridge-repo/packages.adb\n' > "$testdir/root/tmp/bridge-repositories"
chroot "$testdir/root" /bin/sh -c 'apk add --no-network --repositories-file /tmp/bridge-repositories ip-bridge'
cp "$project/openwrt/files/usr/libexec/freeisp-bridge-status" "$testdir/root/usr/libexec/freeisp-bridge-status"
cp "$project/openwrt/files/usr/share/rpcd/acl.d/luci-app-freeisp-bridge.json" "$testdir/root/usr/share/rpcd/acl.d/luci-app-freeisp-bridge.json"
chmod 755 "$testdir/root/usr/libexec/freeisp-bridge-status"
cp "$project/tools/openwrt/test-bridge-backend.sh" "$testdir/root/tmp/test-bridge-backend.sh"
result=0
FREEISP_BRIDGE_TEST_ISOLATED=1 chroot "$testdir/root" /bin/sh /tmp/test-bridge-backend.sh > "$output/backend.log" 2>&1 || result=$?
for f in netifd.log netifd-restart.log rpcd.log bridge-link.json bridge-vlan.json bridge-fdb.json bridge-helper.json; do
    [ ! -f "$testdir/root/tmp/$f" ] || cp "$testdir/root/tmp/$f" "$output/$f"
done
cat "$output/backend.log"
exit "$result"
