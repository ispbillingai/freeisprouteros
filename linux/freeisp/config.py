"""Strict portable configuration; interface assignment belongs to each target."""
import ipaddress
import json
import os
import re
from pathlib import Path

DEFAULT = {"schema": 1, "name": "FreeISP", "lan": "10.77.0.1/24",
           "pool_start": "10.77.0.100", "pool_end": "10.77.0.199",
           "lease_minutes": 30}


def validate(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT):
        raise ValueError("Use a FreeISP configuration backup with the supported fields.")
    if type(value["schema"]) is not int or value["schema"] != 1:
        raise ValueError("Unsupported configuration version.")
    if not isinstance(value["name"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 -]{0,39}", value["name"]):
        raise ValueError("Name must be 1–40 letters, numbers, spaces or hyphens.")
    if type(value["lease_minutes"]) is not int or not 2 <= value["lease_minutes"] <= 1440:
        raise ValueError("Lease time must be 2–1440 minutes.")
    try:
        lan = ipaddress.IPv4Interface(value["lan"])
        first = ipaddress.IPv4Address(value["pool_start"])
        last = ipaddress.IPv4Address(value["pool_end"])
    except (ValueError, TypeError, ipaddress.AddressValueError) as exc:
        raise ValueError("Enter valid IPv4 addresses and a LAN prefix.") from exc
    private = [ipaddress.IPv4Network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
    if not any(lan.network.subnet_of(n) for n in private) or not 24 <= lan.network.prefixlen <= 29:
        raise ValueError("Use a private LAN subnet between /24 and /29.")
    # Fixed upstream and maintenance networks for the first virtual target.
    if any(lan.network.overlaps(ipaddress.ip_network(n)) for n in ("10.0.2.0/24", "10.78.0.0/24")):
        raise ValueError("LAN overlaps the lab's internet or maintenance network.")
    if any(a not in lan.network or a in (lan.network.network_address, lan.network.broadcast_address)
           for a in (lan.ip, first, last)) or not first <= last or first <= lan.ip <= last:
        raise ValueError("DHCP range must contain usable LAN addresses and exclude the router.")
    if str(lan) != value["lan"] or str(first) != value["pool_start"] or str(last) != value["pool_end"]:
        raise ValueError("Use canonical IPv4 notation.")
    return dict(value)


def save_atomic(path, value):
    path = Path(path)
    tmp = path.with_suffix(".new")
    with open(tmp, "w", encoding="utf-8") as stream:
        os.chmod(tmp, 0o600)
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
