#!/usr/bin/env python3
"""Create an isolated VirtualBox FreeISP lab; never bridge a physical adapter.

The input must be the published FreeISP x86 VM image with its three assigned
MAC addresses. Guest provisioning and credentials are deliberately separate.
"""
import argparse
import gzip
import hashlib
from pathlib import Path
import shutil
import socket
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--vbox', default=r'C:\Program Files\Oracle\VirtualBox\VBoxManage.exe')
    args = parser.parse_args()
    if hashlib.sha256(args.image.read_bytes()).hexdigest() != args.sha256.lower():
        raise SystemExit('Image checksum mismatch; no VM was created.')
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)

    def vbox(*command):
        result = subprocess.run([args.vbox, *map(str, command)], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout

    names = ['FreeISP Router Lab', 'FreeISP Customer Lab']
    existing = vbox('list', 'vms')
    if any('"' + name + '"' in existing for name in names):
        raise SystemExit('A lab VM already exists. Use its Start script; no VM was changed.')
    for port in (18874, 12224, 18875, 12225):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    raw = directory / 'base.raw'
    if raw.exists():
        raise SystemExit('base.raw already exists; choose an empty lab directory.')
    print('Extracting verified router image...', flush=True)
    with gzip.open(args.image, 'rb') as source, raw.open('xb') as target:
        shutil.copyfileobj(source, target)
    for index, name in enumerate(names):
        folder = directory / name
        if folder.exists():
            raise SystemExit('VM folder already exists: ' + str(folder))
        print('Creating ' + name, flush=True)
        vbox('createvm', '--name', name, '--ostype', 'Linux_64', '--basefolder', directory, '--register')
        disk = folder / 'router.vdi'
        vbox('convertfromraw', raw, disk, '--format', 'VDI')
        vbox('modifyvm', name, '--memory', 1024 if index == 0 else 512,
             '--cpus', 2 if index == 0 else 1, '--ioapic', 'on', '--firmware', 'bios',
             '--boot1', 'disk', '--boot2', 'none', '--boot3', 'none', '--boot4', 'none',
             '--audio-enabled', 'off', '--usb-ohci', 'off', '--graphicscontroller', 'vmsvga',
             '--nic1', 'nat' if index == 0 else 'intnet', '--nic-type1', 'virtio',
             '--mac-address1', '525400F10001', '--cable-connected1', 'on',
             '--nic2', 'intnet', '--nic-type2', 'virtio', '--mac-address2', '525400F10002',
             '--intnet2', 'FreeISP-Lab-LAN' if index == 0 else 'FreeISP-Lab-Client-Unused',
             '--cable-connected2', 'on', '--nic3', 'nat', '--nic-type3', 'virtio',
             '--mac-address3', '525400F10003', '--cable-connected3', 'on',
             '--nat-net3', '10.78.0.0/24',
             '--nat-pf3', f'web,tcp,127.0.0.1,{18874 + index},10.78.0.15,80',
             '--nat-pf3', f'ssh,tcp,127.0.0.1,{12224 + index},10.78.0.15,22',
             '--uart1', '0x3F8', '4', '--uart-mode1', 'file', folder / 'serial.log')
        if index:
            vbox('modifyvm', name, '--intnet1', 'FreeISP-Lab-LAN')
        else:
            # The synthetic WAN speed-test server binds only to Windows localhost.
            vbox('modifyvm', name, '--nat-localhostreachable1', 'on')
        vbox('storagectl', name, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci')
        vbox('storageattach', name, '--storagectl', 'SATA', '--port', 0, '--device', 0,
             '--type', 'hdd', '--medium', disk)
        print(vbox('startvm', name, '--type', 'headless'), flush=True)
    print('VMs started. Provision the customer LAN before routing tests to avoid a gateway address conflict.')


if __name__ == '__main__':
    main()
