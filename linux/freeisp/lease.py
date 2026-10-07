#!/usr/bin/python3
"""Validate DHCP-provided values before passing argument lists to iproute2."""
import ipaddress
import os
import subprocess
import sys
from pathlib import Path

iface = os.environ["interface"]
if not iface.isalnum():
    raise SystemExit("Invalid interface")

def ip(*args):
    subprocess.run(["ip", *args], check=True, timeout=10)

if sys.argv[1] == "deconfig":
    ip("address", "flush", "dev", iface, "scope", "global")
    Path("/run/wan-resolv.conf").write_text("")
elif sys.argv[1] in ("bound", "renew"):
    address = ipaddress.IPv4Interface(os.environ["ip"] + "/" + os.environ.get("subnet", "255.255.255.0"))
    gateways = [str(ipaddress.IPv4Address(a)) for a in os.environ.get("router", "").split()]
    dns = [str(ipaddress.IPv4Address(a)) for a in os.environ.get("dns", "").split()]
    ip("address", "flush", "dev", iface, "scope", "global")
    ip("address", "add", str(address), "dev", iface)
    if gateways:
        ip("route", "replace", "default", "via", gateways[0], "dev", iface)
    Path("/run/wan-resolv.conf").write_text("".join("nameserver " + a + "\n" for a in dns))
