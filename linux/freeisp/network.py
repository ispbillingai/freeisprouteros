"""Linux router backend, restricted to the dedicated FreeISP VM profile."""
import ipaddress
import json
import subprocess
import time
from pathlib import Path


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=15, **kwargs).stdout


class Network:
    def __init__(self):
        if "freeisp.appliance=1" not in Path("/proc/cmdline").read_text().split():
            raise RuntimeError("Network changes require the dedicated FreeISP appliance boot profile.")
        self.interfaces = {}
        for path in Path("/sys/class/net").glob("*/address"):
            mac = path.read_text().strip()
            for role, suffix in (("wan", "01"), ("lan", "02"), ("management", "03")):
                if mac == "52:54:00:f1:00:" + suffix:
                    self.interfaces[role] = path.parent.name
        if set(self.interfaces) != {"wan", "lan", "management"}:
            raise RuntimeError("Expected three explicitly assigned virtual adapters; refusing guessed port roles.")
        self.dns = None
        self.wan = None

    def firewall(self, config):
        wan, lan, mgmt = (self.interfaces[r] for r in ("wan", "lan", "management"))
        subnet = str(ipaddress.ip_interface(config["lan"]).network)
        # One atomic nft transaction. This appliance owns its complete ruleset.
        rules = f'''flush ruleset
table inet freeisp {{
 chain input {{
  type filter hook input priority 0; policy drop;
  iifname "lo" accept
  ct state invalid drop
  ct state established,related accept
  iifname "{wan}" udp sport 67 udp dport 68 accept
  iifname "{lan}" udp sport 68 udp dport 67 accept
  iifname "{lan}" ip saddr {subnet} udp dport 53 accept
  iifname "{lan}" ip saddr {subnet} tcp dport {{53,8443}} accept
  iifname "{lan}" ip saddr {subnet} icmp type echo-request accept
  iifname "{mgmt}" ip saddr 10.78.0.0/24 tcp dport {{8080,8443}} accept
 }}
 chain forward {{
  type filter hook forward priority 0; policy drop;
  ct state invalid drop
  iifname "{wan}" oifname "{lan}" ct state established,related counter accept
  iifname "{lan}" oifname "{wan}" ip saddr {subnet} counter accept
 }}
 chain output {{ type filter hook output priority 0; policy accept; }}
}}
table ip freeisp_nat {{
 chain postrouting {{ type nat hook postrouting priority srcnat; policy accept;
  oifname "{wan}" ip saddr {subnet} counter masquerade
 }}
}}
'''
        run("nft", "-c", "-f", "-", input=rules)
        run("nft", "-f", "-", input=rules)

    def apply(self, config):
        lan = self.interfaces["lan"]
        Path("/proc/sys/net/ipv4/ip_forward").write_text("0\n")
        self.firewall(config)
        run("ip", "address", "flush", "dev", lan, "scope", "global")
        run("ip", "address", "add", config["lan"], "dev", lan)
        run("ip", "link", "set", lan, "up")
        if self.dns is not None:
            self.dns.terminate()
            self.dns.wait(timeout=5)
        addr = str(ipaddress.ip_interface(config["lan"]).ip)
        mask = str(ipaddress.ip_interface(config["lan"]).network.netmask)
        content = f'''interface={lan}
bind-interfaces
listen-address={addr}
dhcp-range={config['pool_start']},{config['pool_end']},{mask},{config['lease_minutes']}m
dhcp-option=option:router,{addr}
dhcp-option=option:dns-server,{addr}
dhcp-leasefile=/run/freeisp-leases
dhcp-authoritative
resolv-file=/run/wan-resolv.conf
no-hosts
domain-needed
bogus-priv
address=/freeisp.lan/{addr}
local=/lan/
'''
        Path("/run/freeisp-dns.conf").write_text(content)
        run("dnsmasq", "--test", "--conf-file=/run/freeisp-dns.conf")
        self.dns = subprocess.Popen(["dnsmasq", "--keep-in-foreground", "--conf-file=/run/freeisp-dns.conf"])
        time.sleep(0.15)
        if self.dns.poll() is not None:
            raise RuntimeError("DHCP/DNS service failed to start.")
        Path("/proc/sys/net/ipv4/ip_forward").write_text("1\n")

    def start(self, config):
        for setting in ("all", "default"):
            Path(f"/proc/sys/net/ipv6/conf/{setting}/disable_ipv6").write_text("1\n")
        run("ip", "link", "set", "lo", "up")
        mgmt = self.interfaces["management"]
        run("ip", "address", "add", "10.78.0.15/24", "dev", mgmt)
        run("ip", "link", "set", mgmt, "up")
        Path("/run/wan-resolv.conf").touch()
        self.apply(config)
        wan = self.interfaces["wan"]
        run("ip", "link", "set", wan, "up")
        self.wan = subprocess.Popen(["udhcpc", "-f", "-i", wan, "-s", "/usr/lib/freeisp/lease.py",
                                     "-p", "/run/freeisp-wan.pid", "-t", "5", "-T", "2"])

    def status(self):
        return {"interfaces": json.loads(run("ip", "-j", "address")),
                "routes": json.loads(run("ip", "-j", "route")),
                "dhcp_dns_running": self.dns is not None and self.dns.poll() is None,
                "wan_client_running": self.wan is not None and self.wan.poll() is None,
                "leases": Path("/run/freeisp-leases").read_text() if Path("/run/freeisp-leases").exists() else "",
                "firewall": run("nft", "list", "ruleset")}
