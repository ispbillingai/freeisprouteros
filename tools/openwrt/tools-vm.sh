#!/bin/sh
# Local, disposable test VM only. Never uses or changes the deployed VM.
set -eu
PROJECT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
IMAGE=${FREEISP_TOOLS_IMAGE:?Set FREEISP_TOOLS_IMAGE to the existing OpenWrt .img.gz file}
OUT=$PROJECT/artifacts/tools-vm
mkdir -p "$OUT"
TESTDIR=$(mktemp -d "$OUT/run.XXXXXX")
mkdir "$TESTDIR/root"
gzip -dc "$IMAGE" > "$TESTDIR/router.raw"
OFFSET=$(python3 -c 'import struct,sys; f=open(sys.argv[1],"rb"); f.seek(470); print(struct.unpack("<I",f.read(4))[0]*512)' "$TESTDIR/router.raw")
mount -o "loop,offset=$OFFSET" "$TESTDIR/router.raw" "$TESTDIR/root"
trap 'umount "$TESTDIR/root"' EXIT
cp -a "$PROJECT/openwrt/files/." "$TESTDIR/root/"
find "$TESTDIR/root/etc/uci-defaults" "$TESTDIR/root/etc/init.d" -type f -exec sed -i 's/\r$//' {} +
# This password exists only in an ignored, loopback-accessible disposable test VM.
mkdir -p "$TESTDIR/root/etc/freeisp"
printf '%s\n' 'FreeISP-Tools-Local-Test-Only' | openssl passwd -6 -stdin > "$TESTDIR/root/etc/freeisp/root.hash"
# Only the disposable test disk receives this fixture ACL; it is absent from the product overlay.
printf '%s' '{"freeisp-tools-test":{"read":{"ubus":{"file":["read","exec"]},"file":{"*":["read","exec"]}},"write":{"ubus":{"file":["write","exec"]},"file":{"*":["write","exec"]}}}}' > "$TESTDIR/root/usr/share/rpcd/acl.d/freeisp-tools-test.json"
find "$TESTDIR/root/usr/libexec/rpcd" "$TESTDIR/root/etc/init.d" "$TESTDIR/root/etc/uci-defaults" -type f -exec chmod 755 {} +
umount "$TESTDIR/root"
trap - EXIT
ACCEL=tcg; CPU=max
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then ACCEL=kvm; CPU=host; fi
exec qemu-system-x86_64 -machine q35 -accel "$ACCEL" -cpu "$CPU" -m 384 -smp 2 \
 -drive "file=$TESTDIR/router.raw,format=raw,if=virtio" \
 -netdev user,id=wan -device virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01 \
 -netdev user,id=lan,restrict=on -device virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02 \
 -netdev user,id=management,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:18940-10.78.0.15:80,restrict=on \
 -device virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03 \
 -display none -monitor none -serial unix:/tmp/freeisp-tools-console.sock,server=on,wait=off
