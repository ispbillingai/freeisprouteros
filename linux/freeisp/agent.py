"""Authenticated maintenance UI and reversible configuration for the VM lab."""
import hashlib
import hmac
import ipaddress
import json
import secrets
import ssl
import subprocess
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from freeisp.config import DEFAULT, save_atomic, validate
from freeisp.network import Network

DATA = Path("/data")
UI = Path("/usr/lib/freeisp/ui.html")


class Controller:
    def __init__(self, network, data=DATA, timeout=60):
        self.network, self.data, self.timeout = network, Path(data), timeout
        self.lock = threading.RLock()
        self.saved = validate(json.loads((self.data / "config.json").read_text()))
        self.active = dict(self.saved)
        self.pending = None
        self.timer = None
        self.error = None

    def stage(self, candidate):
        candidate = validate(candidate)
        with self.lock:
            if self.pending:
                raise ValueError("Confirm or revert the pending change first.")
            try:
                self.network.apply(candidate)
            except Exception:
                self.network.apply(self.saved)
                raise
            token = secrets.token_urlsafe(24)
            self.active = candidate
            self.pending = {"id": token, "expires": time.time() + self.timeout}
            self.timer = threading.Timer(self.timeout, self.revert)
            self.timer.daemon = True
            self.timer.start()
            return dict(self.pending)

    def confirm(self, token):
        with self.lock:
            if not self.pending or not hmac.compare_digest(token, self.pending["id"]):
                raise ValueError("Change is missing, expired or belongs to another request.")
            if time.time() >= self.pending["expires"]:
                self.revert()
                raise ValueError("Confirmation window expired; previous settings restored.")
            save_atomic(self.data / "config.json", self.active)
            self.saved = dict(self.active)
            self.timer.cancel()
            self.pending = None

    def revert(self):
        with self.lock:
            if not self.pending:
                return
            if self.timer:
                self.timer.cancel()
            try:
                self.network.apply(self.saved)
                self.active = dict(self.saved)
                self.error = None
            except Exception:
                # apply() disables forwarding before it changes network state.
                self.error = "Automatic restore failed. Use the maintenance console and reboot to saved settings."
            finally:
                self.pending = None


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200000).hex()


class Handler(BaseHTTPRequestHandler):
    server_version = "FreeISP-lab/0.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, fmt, *args):
        # Never record supplied passwords, cookies, backups or request bodies.
        print("management", self.client_address[0], self.command, self.path.split("?")[0], flush=True)

    def reply(self, code, value, content_type="application/json", headers=None):
        body = json.dumps(value).encode() if content_type == "application/json" else value
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
        for key, val in (headers or {}).items():
            self.send_header(key, val)
        self.end_headers()
        self.wfile.write(body)

    def authenticated(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie["freeisp_session"].value
        except (KeyError, ValueError):
            return False
        with self.server.sessions_lock:
            expiry = self.server.sessions.get(token, 0)
            return expiry > time.time()

    def origin_valid(self):
        # Mutations require both a same-origin request and a non-simple header.
        if self.headers.get("X-FreeISP-Request") != "1":
            return False
        origin = self.headers.get("Origin")
        scheme = "https://" if self.server.is_tls else "http://"
        if origin and origin != scheme + self.headers.get("Host", ""):
            return False
        host = urlsplit("https://" + self.headers.get("Host", "")).hostname
        allowed = {"localhost", "127.0.0.1", "10.78.0.15", "freeisp.lan",
                   str(ipaddress.ip_interface(self.server.controller.active["lan"]).ip)}
        if not self.server.is_tls:
            allowed = {"localhost", "127.0.0.1"}
        return host in allowed

    def do_GET(self):
        if self.path == "/":
            self.reply(200, UI.read_bytes(), "text/html; charset=utf-8")
            return
        if not self.authenticated():
            self.reply(401, {"error": "Sign in to FreeISP."})
            return
        controller = self.server.controller
        with controller.lock:
            if self.path == "/api/status":
                try:
                    observed = controller.network.status()
                except Exception:
                    self.reply(503, {"error": "Unable to read network state."})
                    return
                self.reply(200, {"version": "0.1.0-lab", "target": "x86_64 virtual appliance",
                                 "config": controller.active, "pending": controller.pending,
                                 "error": controller.error, "observed": observed,
                                 "implemented": ["IPv4 routing/NAT", "firewall", "DHCP", "DNS", "configuration backup/restore"],
                                 "not_implemented": ["PPPoE", "RADIUS accounting", "hotspot", "subscriber limits", "Wi-Fi", "firmware update", "RouterOS API"]})
            elif self.path == "/api/backup":
                self.reply(200, controller.saved, headers={"Content-Disposition": 'attachment; filename="freeisp-settings.json"'})
            else:
                self.reply(404, {"error": "Not found."})

    def do_POST(self):
        if not self.origin_valid():
            self.reply(403, {"error": "Use the FreeISP management page."})
            return
        try:
            if self.headers.get("Transfer-Encoding") or self.headers.get_content_type() != "application/json":
                raise ValueError("Expected a JSON request.")
            if len(self.headers.get_all("Content-Length", [])) != 1:
                raise ValueError("One content length is required.")
            length = int(self.headers["Content-Length"])
            if not 0 < length <= 8192:
                raise ValueError("Request must be 1–8192 bytes.")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object.")
            if self.path == "/api/login":
                self.login(data)
                return
            if not self.authenticated():
                self.reply(401, {"error": "Sign in to FreeISP."})
                return
            controller = self.server.controller
            if self.path in ("/api/config", "/api/restore"):
                self.reply(200, {"pending": controller.stage(data)})
            elif self.path == "/api/confirm":
                token = data.get("id")
                if not isinstance(token, str):
                    raise ValueError("Missing confirmation identifier.")
                controller.confirm(token)
                self.reply(200, {"saved": True})
            elif self.path == "/api/revert":
                controller.revert()
                self.reply(200, {"reverted": controller.error is None, "error": controller.error})
            elif self.path == "/api/logout":
                with self.server.sessions_lock:
                    cookie = SimpleCookie(self.headers.get("Cookie", ""))
                    self.server.sessions.pop(cookie["freeisp_session"].value, None)
                secure = "; Secure" if self.server.is_tls else ""
                self.reply(200, {"signed_out": True}, headers={"Set-Cookie": "freeisp_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict" + secure})
            else:
                self.reply(404, {"error": "Not found."})
        except (ValueError, TypeError, KeyError) as exc:
            self.reply(400, {"error": str(exc)})
        except Exception:
            self.reply(500, {"error": "Operation failed. Check the maintenance console; saved settings are retained."})

    def login(self, data):
        now = time.monotonic()
        with self.server.sessions_lock:
            self.server.attempts = [t for t in self.server.attempts if now - t < 60]
            if len(self.server.attempts) >= 10:
                self.reply(429, {"error": "Too many login attempts. Wait one minute."})
                return
            self.server.attempts.append(now)
        password = data.get("password")
        credentials = self.server.credentials
        if not isinstance(password, str) or len(password) > 256 or not hmac.compare_digest(
                password_hash(password, credentials["salt"]), credentials["hash"]):
            self.reply(401, {"error": "Incorrect administrator password."})
            return
        token = secrets.token_urlsafe(32)
        with self.server.sessions_lock:
            self.server.sessions = {k: v for k, v in self.server.sessions.items() if v > time.time()}
            if len(self.server.sessions) >= 32:
                self.server.sessions.pop(next(iter(self.server.sessions)))
            self.server.sessions[token] = time.time() + 3600
        secure = "; Secure" if self.server.is_tls else ""
        self.reply(200, {"signed_in": True}, headers={"Set-Cookie": f"freeisp_session={token}; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict" + secure})


def main():
    DATA.mkdir(exist_ok=True)
    if not (DATA / "config.json").exists():
        save_atomic(DATA / "config.json", DEFAULT)
    if not (DATA / "admin.json").exists():
        save_atomic(DATA / "admin.json", json.loads(Path("/etc/freeisp/admin.json").read_text()))
    if not (DATA / "tls.key").exists() or not (DATA / "tls.crt").exists():
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
                        "-keyout", str(DATA / "tls.key"), "-out", str(DATA / "tls.crt"),
                        "-subj", "/CN=FreeISP Lab", "-addext", "subjectAltName=DNS:localhost,DNS:freeisp.lan,IP:127.0.0.1,IP:10.78.0.15,IP:10.77.0.1"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (DATA / "tls.key").chmod(0o600)
    network = Network()
    controller = Controller(network)
    network.start(controller.saved)
    server = ThreadingHTTPServer(("0.0.0.0", 8443), Handler)
    server.controller = controller
    server.is_tls = True
    server.credentials = json.loads((DATA / "admin.json").read_text())
    server.sessions, server.attempts, server.sessions_lock = {}, [], threading.Lock()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(DATA / "tls.crt", DATA / "tls.key")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    # The maintenance network is an isolated QEMU backend exposed only on host
    # loopback. Remote users reach it through encrypted SSH port forwarding.
    # LAN management stays HTTPS; this listener is not reachable from WAN/LAN.
    maintenance = ThreadingHTTPServer(("10.78.0.15", 8080), Handler)
    maintenance.controller, maintenance.credentials = controller, server.credentials
    maintenance.sessions, maintenance.attempts, maintenance.sessions_lock = {}, [], threading.Lock()
    maintenance.is_tls = False
    threading.Thread(target=maintenance.serve_forever, daemon=True).start()
    print("FREEISP_READY: HTTPS management, configuration recovery and IPv4 router started", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
