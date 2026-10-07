#!/bin/sh
set -eu
cd "$(dirname "$0")"
ACCEL=tcg
CPU=max
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then ACCEL=kvm; CPU=host; fi
# Only loopback host forwards. No host bridges, routing or firewall changes.
# Explicit adapter identities prevent LAN/WAN swaps when interface names change.
exec qemu-system-x86_64 -machine q35 -accel "$ACCEL" -cpu "$CPU" -m 512 -smp 2 \
 -kernel vmlinuz -initrd initramfs.gz \
 -append 'console=ttyS0 rdinit=/init panic=0 freeisp.appliance=1' \
 -drive file=state.raw,format=raw,if=virtio \
 -netdev user,id=wan,hostfwd=tcp:127.0.0.1:8844-:8443 \
 -device virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01 \
 -netdev socket,id=lan,listen=127.0.0.1:18877 \
 -device virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02 \
 -netdev user,id=management,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:8843-10.78.0.15:8443,restrict=on \
 -device virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03 \
 -display none -monitor none -serial stdio -no-reboot
