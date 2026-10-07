"""Version the router-served UI for FreeISP Desk static-asset caching."""
import argparse
import hashlib
import json
from pathlib import Path


def write_manifest(root):
    root = Path(root)
    target = root / 'www/luci-static/freeisp/release.json'
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob('*') if p.is_file() and p != target):
        relative = path.relative_to(root).as_posix()
        # Version UI, permissions and backend together, without hashing private state.
        if not relative.startswith(('www/luci-static/', 'usr/share/luci/', 'usr/share/rpcd/', 'usr/bin/freeisp-', 'usr/lib/freeisp/', 'usr/libexec/')):
            continue
        digest.update(relative.encode('utf-8') + b'\0')
        digest.update(path.read_bytes().replace(b'\r\n', b'\n'))
        digest.update(b'\0')
    manifest = {'schema': 1, 'revision': digest.hexdigest()}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2] / 'openwrt/files')
    print(json.dumps(write_manifest(parser.parse_args().root)))
