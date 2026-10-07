#!/usr/bin/python3
"""Scoped nftables enforcement for FreeISP's IPv4 captive Hotspot.

Only dedicated, already configured customer networks are eligible. The service
never changes addresses, DHCP, routing or the administrator's firewall policy.
"""
import copy
import hashlib
import ipaddress
import json
import os
import re
import socket
import subprocess
import tempfile
import threading
import time


TABLE = "freeisp_hotspot"
LEASE_SECONDS = 30
MARK = "0x04000000"
NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,15}$")
MAC = re.compile(r"^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$")


class RuntimeError(Exception):
    pass


def ident(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:16]


def quoted(value):
    if not NAME.fullmatch(value):
        raise RuntimeError("Invalid network interface name")
    return json.dumps(value)


def ipv4(value, network=False):
    parsed = ipaddress.ip_network(value, strict=False) if network else ipaddress.ip_address(value)
    if parsed.version != 4:
        raise RuntimeError("Hotspot currently supports IPv4 only")
    return str(parsed)


def ports(value):
    result = []
    for part in str(value).split(","):
        bounds = part.strip().split("-")
        if not 1 <= len(bounds) <= 2 or not all(x.isdigit() and 1 <= int(x) <= 65535 for x in bounds):
            raise RuntimeError("Invalid port or port range")
        if len(bounds) == 2 and int(bounds[0]) > int(bounds[1]):
            raise RuntimeError("Invalid port range order")
        result.append("-".join(str(int(x)) for x in bounds))
    return "{ " + ", ".join(result) + " }"


def command(argv, data=None, allow_fail=False):
    try:
        result = subprocess.run(argv, input=data, text=True, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Required network command unavailable: " + argv[0]) from exc
    if result.returncode and not allow_fail:
        raise RuntimeError((result.stderr.strip() or result.stdout.strip() or "Network command failed")[:400])
    return result


class Runtime:
    def __init__(self, runner=command, guard_path="/etc/nftables.d/70-freeisp-hotspot-guard.nft", clock=time.time,
                 verify_firewall=True, resolver=None, template_dir="/etc/freeisp/portal"):
        self.run = runner
        self.guard_path = guard_path
        self.clock = clock
        self.verify_firewall = verify_firewall
        self.resolver = resolver or socket.getaddrinfo
        self.config = {}
        self.sessions = []
        self.signature = None
        self.bases = {}
        self.last_bytes = {}
        self.activity = {}
        self.dns_cache = {}
        self.error = None
        self.mac_addresses = {}
        self.template_dir = template_dir
        self.port_manager = None
        self.dns_workers = threading.BoundedSemaphore(4)

    def _json(self, argv, optional=False):
        result = self.run(argv, allow_fail=optional)
        if result.returncode:
            return None
        try:
            return json.loads(result.stdout)
        except (ValueError, TypeError) as exc:
            raise RuntimeError("Invalid response from " + argv[0]) from exc

    def interfaces(self):
        addresses = self._json(["ip", "-j", "-4", "address", "show"])
        routes = self._json(["ip", "-j", "-4", "route", "show", "default"])
        excluded = {r.get("dev") for r in routes}
        zones = {}
        offloading = False
        if self.verify_firewall:
            network = self._json(["ubus", "call", "network.interface", "dump"], optional=True) or {}
            for entry in network.get("interface", []):
                if re.search(r"(^|[_-])(wan\d*|mgmt|management)([_-]|$)", entry.get("interface", ""), re.I):
                    excluded.update([entry.get("device"), entry.get("l3_device")])
            firewall = self._json(["ubus", "call", "uci", "get", '{"config":"firewall"}'], optional=True)
            if firewall is None:
                raise RuntimeError("Cannot inspect firewall safety settings")
            sections = firewall.get("values", {})
            for row in sections.values():
                if row.get(".type") == "defaults":
                    offloading |= str(row.get("flow_offloading", "0")) == "1" or str(row.get("flow_offloading_hw", "0")) == "1"
                if row.get(".type") == "zone":
                    networks = row.get("network", [])
                    if isinstance(networks, str):
                        networks = networks.split()
                    for entry in network.get("interface", []):
                        if entry.get("interface") in networks:
                            zones[entry.get("l3_device") or entry.get("device")] = row
            # flowtables can be added independently of the UCI defaults.
            ruleset = self._json(["nft", "-j", "list", "ruleset"])
            offloading |= any("flowtable" in x for x in ruleset.get("nftables", []))
        result = []
        for row in addresses:
            name = row.get("ifname", "").split("@")[0]
            v4 = [a["local"] for a in row.get("addr_info", []) if a.get("family") == "inet"]
            reason = ""
            if not NAME.fullmatch(name) or name == "lo" or name in excluded or re.search(r"(^|[-_])(wan\d*|mgmt|management)([-_]|$)", name, re.I):
                reason = "Management, loopback and WAN interfaces cannot host a Hotspot"
            elif not v4:
                reason = "Configure an IPv4 customer network first"
            elif row.get("master"):
                reason = "Select the customer bridge, not one of its member ports"
            elif offloading:
                reason = "Disable software and hardware flow offloading before enabling Hotspot"
            elif self.verify_firewall and zones.get(name, {}).get("input", "").upper() != "ACCEPT":
                reason = "The customer firewall zone must accept input; Hotspot restricts it to DNS, DHCP and the portal"
            result.append({"name": name, "addresses": v4, "eligible": not bool(reason), "reason": reason,
                           "networks": [str(ipaddress.ip_network(a["local"] + "/" + str(a["prefixlen"]), strict=False))
                                        for a in row.get("addr_info", []) if a.get("family") == "inet"]})
        return result

    def _enabled(self, config, collection):
        return [x for x in config.get("collections", config).get(collection, []) if not x.get("disabled", False)]

    def _servers(self, config):
        profiles = {p["id"]: p for p in config.get("collections", config).get("server_profiles", [])}
        for server in self._enabled(config, "servers"):
            if server.get("profile") not in profiles:
                raise RuntimeError("An enabled server requires an existing server profile")
            profile = profiles[server["profile"]]
            if not profile.get("disabled", False):
                yield server, profile

    def validate(self, config):
        servers = list(self._servers(config))
        if not servers:
            return
        interfaces = {x["name"]: x for x in self.interfaces()}
        selected_ports = set()
        selected_networks = []
        for server, profile in servers:
            iface = interfaces.get(server.get("interface"))
            if not iface or not iface["eligible"]:
                raise RuntimeError((iface or {}).get("reason", "Customer interface does not exist"))
            if profile.get("hotspot_address") not in iface["addresses"]:
                raise RuntimeError("Hotspot address must be an existing IPv4 address on the customer interface")
            if profile.get("dns_name") and self._resolve_host(profile["dns_name"]) != [profile["hotspot_address"]]:
                raise RuntimeError("The portal DNS name must already resolve only to its Hotspot address; configure the customer DNS record first")
            pool = server.get("address_pool", "")
            if pool:
                # Pool is a validation boundary for the already configured DHCP network.
                try:
                    network = ipaddress.ip_network(pool, strict=False)
                except ValueError as exc:
                    raise RuntimeError("Address pool must be the existing customer IPv4 subnet (CIDR)") from exc
                if network.version != 4 or not any(network.subnet_of(ipaddress.ip_network(n)) for n in iface["networks"]):
                    raise RuntimeError("Address pool must be inside the existing customer interface subnet")
                if any(network.overlaps(other) for other in selected_networks):
                    raise RuntimeError("Enabled Hotspot servers must use distinct, non-overlapping customer subnets")
                selected_networks.append(network)
            port = int(profile.get("http_port", 6480))
            if not 1024 <= port <= 65535:
                raise RuntimeError("The portal must use an unprivileged port (1024–65535)")
            selected_ports.add(port)
        if len(selected_ports) > 1:
            raise RuntimeError("All enabled servers must use the same captive portal port")

    def _resolve_host(self, host):
        host = host.lower().rstrip(".")
        now = self.clock()
        cached = self.dns_cache.get(host)
        if cached and cached[0] > now:
            return cached[1]
        addresses = []
        done = threading.Event()
        def resolve():
            try:
                addresses.extend(sorted({ipv4(x[4][0]) for x in self.resolver(host, None, socket.AF_INET, socket.SOCK_STREAM)}))
            except (OSError, ValueError):
                pass
            finally:
                self.dns_workers.release()
                done.set()
        if self.dns_workers.acquire(blocking=False):
            threading.Thread(target=resolve, daemon=True).start()
            done.wait(2)
        found = list(addresses) if done.is_set() else []
        self.dns_cache[host] = (now + 60, found)
        return found

    def _domains(self, config):
        resolved = {}
        for row in self._enabled(config, "walled_garden"):
            host = row["host"].lower().rstrip(".")
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host):
                raise RuntimeError("Use an exact DNS hostname for the walled garden")
            resolved[row["id"]] = self._resolve_host(host)
            if not resolved[row["id"]]:
                raise RuntimeError("Cannot resolve walled garden host: " + host)
        return resolved

    def _bindings(self, config, server, kind):
        return [x for x in self._enabled(config, "ip_bindings") if x.get("server", "all") in ("all", server["id"]) and x["type"] == kind]

    def _binding_match(self, row, outgoing=True):
        if not outgoing and row.get("mac_address"):
            addresses = self.mac_addresses.get(row["mac_address"].upper(), [])
            if row.get("address"):
                network = ipaddress.ip_network(row["address"], strict=False)
                addresses = [a for a in addresses if ipaddress.ip_address(a) in network]
            if not addresses:
                return None
            return "ip daddr { " + ", ".join(ipv4(a) for a in addresses) + " }"
        fields = []
        if row.get("address"):
            fields.append("ip " + ("saddr " if outgoing else "daddr ") + ipv4(row["address"], network=True))
        if outgoing and row.get("mac_address"):
            if not MAC.fullmatch(row["mac_address"]):
                raise RuntimeError("Invalid hardware address")
            fields.append("ether saddr " + row["mac_address"].lower())
        if not fields:
            return None
        return " ".join(fields)

    def _garden(self, config, server, resolved, outgoing=True):
        rules = []
        for collection in ("walled_garden", "walled_garden_ip"):
            for row in self._enabled(config, collection):
                if row.get("server", "all") not in ("all", server["id"]):
                    continue
                destinations = resolved.get(row["id"], []) if collection == "walled_garden" else [row["dst_address"]]
                protocol = "tcp" if collection == "walled_garden" else row.get("protocol", "any")
                port = str(row.get("port", 0)) if collection == "walled_garden" else row.get("dst_port", "")
                for address in destinations:
                    match = "ip " + ("daddr " if outgoing else "saddr ") + ipv4(address, network=True)
                    if protocol != "any":
                        if protocol not in ("tcp", "udp", "icmp"):
                            raise RuntimeError("Invalid walled garden protocol")
                        match += " ip protocol " + protocol
                    if port and port != "0" and protocol in ("tcp", "udp"):
                        match += " " + protocol + (" dport " if outgoing else " sport ") + ports(port)
                    rules.append((row.get("action", "allow"), match))
        return sorted(rules, key=lambda x: x[0] != "deny")

    def render(self, config, sessions, resolved=None):
        """Produce an atomic, self-contained table replacement; no shell interpolation."""
        resolved = self._domains(config) if resolved is None else resolved
        lines = ["table inet " + TABLE + " {"]
        servers = list(self._servers(config))
        server_ids = {s["id"] for s, _ in servers}
        active = [s for s in sessions if s.get("server") in server_ids or s.get("server_id") in server_ids]
        for session in active:
            key = ident(session["id"])
            address = ipv4(session.get("address") or session.get("ip"))
            lines.extend([" set lease_" + key + " { type ipv4_addr; flags timeout; timeout 30s; elements = { " + address + " timeout 30s }; }",
                          " counter up_" + key + " { }", " counter down_" + key + " { }"])
        lines.extend([" chain ingress { type filter hook prerouting priority -301; policy accept;",
                      *["  iifname " + quoted(s["interface"]) + " meta mark set meta mark & 0xfbffffff" for s, _ in servers], " }"])
        for direction, hook in (("local", "input"), ("out", "forward")):
            lines.append(" chain " + hook + " { type filter hook " + hook + " priority -20; policy accept;")
            for server, _ in servers:
                key = ident(server["id"])
                iface = quoted(server["interface"])
                lines.extend(["  iifname " + iface + " meta nfproto ipv6 drop", "  iifname " + iface + " jump " + direction + "_" + key])
                if hook == "forward":
                    lines.extend(["  oifname " + iface + " meta nfproto ipv6 drop", "  oifname " + iface + " jump in_" + key])
            lines.append(" }")
        accept = "meta mark set meta mark | " + MARK + " accept"
        profiles = {x["id"]: x for x in self._enabled(config, "user_profiles")}
        users = {x["id"]: x for x in self._enabled(config, "users")}
        for server, profile in servers:
            sid = server["id"]
            key = ident(sid)
            selected = [s for s in active if s.get("server", s.get("server_id")) == sid]
            for direction in ("out", "in", "local"):
                outgoing = direction != "in"
                lines.append(" chain " + direction + "_" + key + " {")
                for binding in self._bindings(config, server, "blocked"):
                    match = self._binding_match(binding, outgoing)
                    if match:
                        lines.append("  " + match + " drop")
                if direction == "local":
                    gateway = ipv4(profile["hotspot_address"])
                    lines.extend(["  udp sport 68 udp dport 67 " + accept,
                                  "  ip daddr " + gateway + " udp dport 53 " + accept,
                                  "  ip daddr " + gateway + " tcp dport { 53, " + str(int(profile.get("http_port", 6480))) + " } " + accept])
                for session in selected:
                    skey = ident(session["id"])
                    address = ipv4(session.get("address") or session.get("ip"))
                    mac = session.get("mac_address") or session.get("mac")
                    if not MAC.fullmatch(mac or ""):
                        raise RuntimeError("Session requires a valid client hardware address")
                    match = "ip " + ("saddr" if outgoing else "daddr") + " @lease_" + skey
                    if outgoing:
                        match += " ether saddr " + mac.lower()
                    if direction == "local":
                        for service in self._enabled(config, "service_ports"):
                            if service["protocol"] not in ("tcp", "udp"):
                                raise RuntimeError("Invalid service protocol")
                            lines.append("  " + match + " " + service["protocol"] + " dport " + ports(service["ports"]) + " " + accept)
                        continue
                    user = users.get(session.get("user_id", session.get("user")), {})
                    uprofile = profiles.get(user.get("profile", session.get("profile")), {})
                    rate = int(uprofile.get("rate_limit_up" if outgoing else "rate_limit_down", 0))
                    if rate:
                        lines.append("  " + match + " limit rate over " + str(rate) + " bytes/second burst " + str(max(rate, 1500)) + " bytes drop")
                    lines.append("  " + match + " counter name " + ("up_" if outgoing else "down_") + skey + " " + accept)
                if direction != "local":
                    # Regular bindings intentionally require login even when a broader bypass exists.
                    for binding in self._bindings(config, server, "regular"):
                        match = self._binding_match(binding, outgoing)
                        if match:
                            lines.append("  " + match + " jump garden_" + direction + "_" + key)
                    for binding in self._bindings(config, server, "bypassed"):
                        match = self._binding_match(binding, outgoing)
                        if match:
                            lines.append("  " + match + " " + accept)
                    lines.append("  jump garden_" + direction + "_" + key)
                lines.append("  drop\n }")
            for direction in ("out", "in"):
                lines.append(" chain garden_" + direction + "_" + key + " {")
                for action, match in self._garden(config, server, resolved, direction == "out"):
                    lines.append("  " + match + " " + ("drop" if action == "deny" else accept))
                lines.append("  drop\n }")
        lines.append(" chain portal_redirect { type nat hook prerouting priority -105; policy accept;")
        for server, profile in servers:
            prefix = "  iifname " + quoted(server["interface"])
            for binding in self._bindings(config, server, "blocked"):
                match = self._binding_match(binding)
                if match:
                    lines.append(prefix + " " + match + " return")
            for session in active:
                if session.get("server", session.get("server_id")) == server["id"]:
                    mac = session.get("mac_address") or session.get("mac")
                    lines.append(prefix + " ip saddr @lease_" + ident(session["id"]) + " ether saddr " + mac.lower() + " return")
            for action, match in self._garden(config, server, resolved):
                lines.append(prefix + " " + match + " return")
            for binding in self._bindings(config, server, "regular"):
                match = self._binding_match(binding)
                if match:
                    lines.append(prefix + " " + match + " tcp dport 80 redirect to :" + str(int(profile.get("http_port", 6480))))
            for binding in self._bindings(config, server, "bypassed"):
                match = self._binding_match(binding)
                if match:
                    lines.append(prefix + " " + match + " return")
            lines.append(prefix + " meta nfproto ipv4 tcp dport 80 redirect to :" + str(int(profile.get("http_port", 6480))))
        lines.append(" }\n}")
        return "\n".join(lines) + "\n"

    def _guard(self, config):
        servers = list(self._servers(config))
        lines = ["# Generated by freeisp-hotspot. Included INSIDE table inet fw4."]
        for hook in ("input", "forward"):
            lines.append("chain freeisp_hotspot_guard_" + hook + " { type filter hook " + hook + " priority -10; policy accept;")
            for server, _ in servers:
                interface = quoted(server["interface"])
                lines.append(" iifname " + interface + " meta mark & " + MARK + " != " + MARK + " drop")
                if hook == "forward":
                    lines.append(" oifname " + interface + " meta mark & " + MARK + " != " + MARK + " drop")
            lines.append("}")
        return "\n".join(lines) + "\n"

    def _write_guard(self, content):
        if not self.guard_path:
            return
        directory = os.path.dirname(self.guard_path)
        os.makedirs(directory, exist_ok=True)
        fd, path = tempfile.mkstemp(prefix=".hotspot-", dir=directory)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(path, 0o600)
            os.replace(path, self.guard_path)
        finally:
            if os.path.exists(path):
                os.unlink(path)

    def configure(self, config, sessions):
        """Apply validated changes atomically; existing rules survive a failed nft batch."""
        try:
            return self._configure(config, sessions)
        except Exception as exc:
            self.error = str(exc)
            raise

    def _configure(self, config, sessions):
        self.validate(config)
        resolved = self._domains(config)
        self.mac_addresses = {}
        if list(self._servers(config)):
            for host in self.hosts(config):
                self.mac_addresses.setdefault(host["mac_address"], []).append(host["address"])
        signature = json.dumps([config, [{k: s.get(k) for k in (
            "id", "user_id", "server", "server_id", "address", "ip", "mac_address", "mac", "profile")} for s in sessions], resolved, self.mac_addresses], sort_keys=True)
        present = self._json(["nft", "-j", "list", "table", "inet", TABLE], optional=True)
        if signature == self.signature and present:
            lines = []
            for session in sessions:
                key = ident(session["id"])
                address = ipv4(session.get("address") or session.get("ip"))
                lines.extend(["flush set inet " + TABLE + " lease_" + key,
                              "add element inet " + TABLE + " lease_" + key + " { " + address + " timeout 30s }"])
            if lines:
                self.run(["nft", "-f", "-"], "\n".join(lines) + "\n")
            self.error = None
            return
        counters = self._counters(present or {})
        rules = ("delete table inet " + TABLE + "\n" if present else "") + self.render(config, sessions, resolved)
        guard = self._guard(config)
        fw4 = self._json(["nft", "-j", "list", "table", "inet", "fw4"], optional=True)
        if fw4:
            existing = {x["chain"]["name"] for x in fw4.get("nftables", []) if "chain" in x}
            for hook in ("input", "forward"):
                name = "freeisp_hotspot_guard_" + hook
                if name in existing:
                    rules += "flush chain inet fw4 " + name + "\ndelete chain inet fw4 " + name + "\n"
            rules += "table inet fw4 {\n" + guard + "}\n"
        self.run(["nft", "-c", "-f", "-"], rules)
        previous_guard = None
        if self.guard_path and os.path.exists(self.guard_path):
            with open(self.guard_path, encoding="utf-8") as stream:
                previous_guard = stream.read()
        prepared = self.port_manager.prepare_port(config) if self.port_manager else None
        try:
            self._write_guard(guard)
            self.run(["nft", "-f", "-"], rules)
        except Exception:
            if self.port_manager:
                self.port_manager.discard_port(prepared)
            self._write_guard(previous_guard or self._guard(self.config))
            raise
        if self.port_manager:
            self.port_manager.activate_port(prepared)
        self.bases = {s["id"]: counters.get(s["id"], self.bases.get(s["id"], {})) for s in sessions}
        self.config = copy.deepcopy(config)
        self.sessions = copy.deepcopy(sessions)
        self.signature = signature
        self.error = None

    def _counters(self, data):
        raw = {x["counter"]["name"]: x["counter"] for x in data.get("nftables", []) if "counter" in x}
        result = {}
        for session in self.sessions:
            sid = session["id"]
            key = ident(sid)
            base = self.bases.get(sid, {})
            values = {}
            for name, direction in (("up", "out"), ("down", "in")):
                counter = raw.get(name + "_" + key, {})
                values["bytes_" + direction] = base.get("bytes_" + direction, 0) + counter.get("bytes", 0)
                values["packets_" + direction] = base.get("packets_" + direction, 0) + counter.get("packets", 0)
            total = values["bytes_in"] + values["bytes_out"]
            if total > self.last_bytes.get(sid, 0):
                self.activity[sid] = self.clock()
            self.last_bytes[sid] = total
            values["last_activity"] = self.activity.get(sid, session.get("last_activity", session.get("created_at", self.clock())))
            result[sid] = values
        return result

    def hosts(self, config):
        server_by_iface = {s["interface"]: s for s, _ in self._servers(config)}
        neighbors = self._json(["ip", "-j", "-4", "neigh", "show"])
        hosts = []
        for row in neighbors:
            server = server_by_iface.get(row.get("dev"))
            if not server or not row.get("lladdr") or not MAC.fullmatch(row["lladdr"]):
                continue
            state = row.get("state", [])
            if isinstance(state, str):
                state = [state]
            if any(x in ("FAILED", "INCOMPLETE") for x in state):
                continue
            address = ipv4(row["dst"])
            if server.get("address_pool") and ipaddress.ip_address(address) not in ipaddress.ip_network(server["address_pool"], strict=False):
                continue
            hosts.append({"id": ident(server["id"] + ":" + address), "server": server["id"], "server_id": server["id"],
                          "interface": row["dev"], "address": address, "ip": address, "mac_address": row["lladdr"].upper(),
                          "mac": row["lladdr"].upper(), "state": ",".join(state), "authorized": False})
        return hosts

    def client(self, ip):
        matches = [h for h in self.hosts(self.config) if h["ip"] == ip]
        if len(matches) != 1:
            raise RuntimeError("The client is not on an enabled Hotspot customer network")
        return matches[0]

    def observe(self, config):
        try:
            interfaces = self.interfaces()
            data = self._json(["nft", "-j", "list", "table", "inet", TABLE], optional=True) or {}
            hosts = self.hosts(config)
            leases = {}
            for entry in data.get("nftables", []):
                row = entry.get("set", {})
                if row.get("name", "").startswith("lease_"):
                    values = []
                    for element in row.get("elem", []):
                        if isinstance(element, str):
                            values.append(element)
                        elif isinstance(element, dict):
                            value = element.get("elem", element)
                            if value.get("expires", 1) > 0:
                                values.append(value.get("val"))
                    leases[row["name"]] = values
            for host in hosts:
                host["authorized"] = any(s.get("server", s.get("server_id")) == host["server"] and
                    (s.get("address") or s.get("ip")) == host["address"] and
                    host["address"] in leases.get("lease_" + ident(s["id"]), []) and
                    (s.get("mac_address") or s.get("mac", "")).upper() == host["mac_address"] for s in self.sessions)
            missing = bool(list(self._servers(config))) and not data
            error = "Hotspot firewall enforcement is missing; restart the service" if missing else self.error
            by_name = {x["name"]: x for x in interfaces}
            for server, profile in self._servers(config):
                interface = by_name.get(server["interface"])
                if not interface or not interface["eligible"]:
                    error = (interface or {}).get("reason", "Configured customer interface is unavailable")
            return {"available": not bool(error), "error": error, "interfaces": interfaces, "hosts": hosts,
                    "counters": self._counters(data), "enforcing": bool(data),
                    "warnings": ["IPv6 is blocked on enabled Hotspot networks.", "Existing DHCP, WAN forwarding and NAT are required.",
                                 "DNS gardens allow resolved IP addresses; shared hosting is not filtered by HTTP path."]}
        except Exception as exc:
            self.error = str(exc)
            return {"available": False, "error": self.error, "interfaces": [], "hosts": [], "counters": {}, "enforcing": False}

    def template_path(self, server):
        return os.path.join(self.template_dir, ident(server["id"]) + ".html")

    def reset_html(self, server):
        """Remove only this server's optional administrator-supplied template."""
        try:
            os.unlink(self.template_path(server))
        except FileNotFoundError:
            pass
