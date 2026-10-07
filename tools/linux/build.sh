#!/bin/sh
set -eu
PROJECT=${FREEISP_PROJECT:-$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)}
ROOT=${FREEISP_BUILD_ROOT:-/opt/freeisp-linux-root}
OUT="$PROJECT/artifacts/releases/freeisp-linux-lab"
export FREEISP_PROJECT="$PROJECT" FREEISP_BUILD_ROOT="$ROOT"
mkdir -p "$OUT" "$ROOT/usr/lib/freeisp" "$ROOT/etc/freeisp"
cp "$PROJECT"/linux/freeisp/*.py "$PROJECT/linux/freeisp/ui.html" "$ROOT/usr/lib/freeisp/"
cp "$PROJECT/linux/init" "$ROOT/init"
chmod 755 "$ROOT/init" "$ROOT/usr/lib/freeisp/lease.py"
python3 - <<'PY'
import hashlib, json, secrets, os
from pathlib import Path
out = Path(os.environ['FREEISP_PROJECT']) / 'artifacts/releases/freeisp-linux-lab'
private = out / 'credentials.json'
if not private.exists():
    password = secrets.token_urlsafe(18)
    salt = secrets.token_hex(16)
    record = {'password': password, 'salt': salt,
              'hash': hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 200000).hex()}
    private.write_text(json.dumps(record, indent=2) + '\n')
    private.chmod(0o600)
record = json.loads(private.read_text())
(Path(os.environ['FREEISP_BUILD_ROOT']) / 'etc/freeisp/admin.json').write_text(json.dumps({k: record[k] for k in ('salt', 'hash')}))
(out / 'CREDENTIALS.txt').write_text('FreeISP private lab build\nManagement: https://127.0.0.1:8843\nAdministrator password: ' + record['password'] + '\nKeep this file and the state disk private.\n')
PY
cp "$ROOT/boot/vmlinuz-virt" "$OUT/vmlinuz"
# Exclude mounted build resources, all runtime files and the unused vendor initrd.
(cd "$ROOT" && find . -xdev \( -path ./dev -o -path ./proc -o -path ./sys -o -path ./boot -o -path ./run -o -path ./tmp \) -prune -print -o -print | cpio -o -H newc 2>/dev/null | gzip -1 > "$OUT/initramfs.gz")
# Create an empty dedicated state disk, never format a host block device.
if [ ! -f "$OUT/state.raw" ]; then
    truncate -s 64M "$OUT/state.raw"
    mkfs.ext4 -q -F -L FREEISP_STATE "$OUT/state.raw"
fi
cp "$PROJECT/tools/linux/run.sh" "$OUT/run.sh"
cp "$PROJECT/artifacts/linux-cache/packages.txt" "$OUT/packages.txt"
cp "$PROJECT/linux/README.md" "$OUT/README.md"
chmod 755 "$OUT/run.sh"
cd "$OUT"
sha256sum vmlinuz initramfs.gz > SHA256SUMS
echo 'FreeISP Linux lab image built'
