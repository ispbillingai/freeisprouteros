#!/bin/sh
# Isolated, disposable QEMU lab. Never touches the deployed router.
set -eu
PROJECT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
OUT="$PROJECT/artifacts/pppoe-lab"
IMAGE=/work/artifacts/releases/freeisp-openwrt-vps/freeisp-openwrt-x86-64.img.gz
mkdir -p "$OUT"
command -v sshpass >/dev/null || { apt-get update -qq; apt-get install -y --no-install-recommends sshpass; }
command -v ssh >/dev/null || { apt-get update -qq; apt-get install -y --no-install-recommends openssh-client; }
for role in router client; do
    [ -e "$OUT/$role.raw" ] || gzip -dc "$IMAGE" > "$OUT/$role.raw"
done
cleanup() {
    [ -z "${CLIENT_PID:-}" ] || kill "$CLIENT_PID" 2>/dev/null || true
    [ -z "${ROUTER_PID:-}" ] || kill "$ROUTER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
qemu-system-x86_64 -accel kvm -machine q35 -cpu host -m 768 -display none -serial "file:$OUT/router-console.log" -monitor none \
    -drive "file=$OUT/router.raw,format=raw,if=virtio" \
    -netdev user,id=wan -device virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01 \
    -netdev socket,id=lan,listen=127.0.0.1:23977 -device virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02 \
    -netdev user,id=management,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:23974-10.78.0.15:22,hostfwd=tcp:127.0.0.1:23976-10.78.0.15:80 -device virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03 > "$OUT/router-qemu.log" 2>&1 &
ROUTER_PID=$!
sleep 1
qemu-system-x86_64 -accel kvm -machine q35 -cpu host -m 512 -display none -serial "file:$OUT/client-console.log" -monitor none \
    -drive "file=$OUT/client.raw,format=raw,if=virtio" \
    -netdev socket,id=wan,connect=127.0.0.1:23977 -device virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01 \
    -netdev user,id=lan -device virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02 \
    -netdev user,id=management,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:23975-10.78.0.15:22 -device virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03 > "$OUT/client-qemu.log" 2>&1 &
CLIENT_PID=$!
python3 "$PROJECT/tools/openwrt/test-pppoe-vm.py"
