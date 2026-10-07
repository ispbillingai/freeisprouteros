#!/bin/sh
set -eu
cd "$(dirname "$0")"
ACCEL=tcg
CPU=max
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then ACCEL=kvm; CPU=host; fi
exec qemu-system-x86_64 -machine q35 -accel "$ACCEL" -cpu "$CPU" -m 768 -smp 2 \
 -drive file=router.raw,format=raw,if=virtio \
 -netdev user,id=wan,hostfwd=tcp:127.0.0.1:8891-:80 \
 -device virtio-net-pci,netdev=wan,mac=52:54:00:f1:00:01 \
 -netdev socket,id=lan,listen=127.0.0.1:18878 \
 -device virtio-net-pci,netdev=lan,mac=52:54:00:f1:00:02 \
 -netdev user,id=management,net=10.78.0.0/24,hostfwd=tcp:127.0.0.1:${WEB_PORT:-8890}-10.78.0.15:80,hostfwd=tcp:127.0.0.1:2224-10.78.0.15:22,restrict=on \
 -device virtio-net-pci,netdev=management,mac=52:54:00:f1:00:03 \
 -display none -monitor none -serial stdio
