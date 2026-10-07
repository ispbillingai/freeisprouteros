#!/bin/sh
set -eu
# Run inside the isolated Linux builder, not on a router or production VPS.
PROJECT=${FREEISP_PROJECT:-$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)}
ROOT=${FREEISP_BUILD_ROOT:-/opt/freeisp-linux-root}
CACHE="$PROJECT/artifacts/linux-cache"
mkdir -p "$ROOT" "$CACHE"
ARCHIVE=alpine-minirootfs-3.24.2-x86_64.tar.gz
SHA=c5ca053cfe1d85c5b96dff8b9bc57045f7f184a30ffb6b65776409ca90388677
if [ ! -f "$CACHE/$ARCHIVE" ]; then
    curl --fail --location --retry 3 "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/$ARCHIVE" -o "$CACHE/$ARCHIVE"
fi
printf '%s  %s\n' "$SHA" "$CACHE/$ARCHIVE" | sha256sum -c -
if [ ! -f "$ROOT/etc/alpine-release" ]; then
    tar -xzf "$CACHE/$ARCHIVE" -C "$ROOT"
fi
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"
mkdir -p "$ROOT/dev" "$ROOT/proc" "$ROOT/sys"
mountpoint -q "$ROOT/dev" || mount --bind /dev "$ROOT/dev"
mountpoint -q "$ROOT/proc" || mount -t proc proc "$ROOT/proc"
chroot "$ROOT" /sbin/apk add --no-cache linux-virt python3 iproute2 nftables dnsmasq openssl ca-certificates e2fsprogs
chroot "$ROOT" /sbin/apk info -v > "$CACHE/packages.txt"
echo 'FreeISP Linux dependencies ready'
