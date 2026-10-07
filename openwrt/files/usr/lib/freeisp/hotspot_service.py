#!/usr/bin/python3
"""Root-only rpcd management socket and guest-facing captive login service."""
import argparse
import hashlib
import hmac
import html
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import secrets
import signal
import socket
import socketserver
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit

from hotspot import Engine, HotspotError
from hotspot_runtime import Runtime

SOCKET_PATH = "/var/run/freeisp-hotspot.sock"
MAX_REQUEST = 65536
METHODS = {"snapshot": {}, "mutate": {"action": "", "payload": ""}}
ACTIONS = {"save", "remove", "set_enabled", "setup", "reset_html", "disconnect", "remove_cookies"}


def failure(exc):
    if isinstance(exc, HotspotError):
        return exc.as_dict()
    return {"ok": False, "error": {"code": "runtime", "message": str(exc)[:400]}}


def read_json(stream, limit=MAX_REQUEST):
    # rpcd writes one JSON value WITHOUT a newline and keeps stdin open while
    # waiting for output. read1 consumes only currently available bytes.
    source = getattr(stream, "buffer", stream)
    read = getattr(source, "read1", None)
    accumulated = bytearray()
    decoder = json.JSONDecoder()
    while len(accumulated) <= limit:
        part = read(min(4096, limit + 1 - len(accumulated))) if read else source.read(1)
        if not part:
            raise ValueError("Incomplete JSON request")
        if isinstance(part, str):
            part = part.encode("utf-8")
        accumulated.extend(part)
        if len(accumulated) > limit:
            raise ValueError("Request is too large")
        try:
            raw = accumulated.decode("utf-8").lstrip()
            value, end = decoder.raw_decode(raw)
        except (ValueError, UnicodeError):
            continue
        if raw[end:].strip():
            raise ValueError("Request contains trailing data")
        if not isinstance(value, dict):
            raise ValueError("Request must be a JSON object")
        return value
    raise ValueError("Request is too large")


def dispatch(engine, method, args):
    if method == "snapshot":
        return engine.snapshot()
    if method != "mutate" or args.get("action") not in ACTIONS:
        raise HotspotError("unknown_action", "Unknown management action")
    payload = args.get("payload", "{}")
    if not isinstance(payload, str) or len(payload) > MAX_REQUEST:
        raise HotspotError("validation", "Payload must be a JSON string")
    try:
        parsed = json.loads(payload)
    except ValueError as exc:
        raise HotspotError("validation", "Payload is not valid JSON") from exc
    return engine.dispatch(args["action"], parsed)


class ManagementHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(10)
        try:
            request = read_json(self.rfile)
            with self.server.controller.lock:
                result = dispatch(self.server.controller.engine, request.get("method"), request.get("args", {}))
                self.server.controller.reconcile_port()
        except Exception as exc:
            result = failure(exc)
        self.wfile.write((json.dumps(result, separators=(",", ":")) + "\n").encode())


class ManagementServer(getattr(socketserver, "ThreadingUnixStreamServer", socketserver.ThreadingTCPServer)):
    daemon_threads = True


class PortalServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def process_request(self, request, client_address):
        # Bound unauthenticated workers; a slow client cannot exhaust router RAM.
        if not self.capacity.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.capacity.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.capacity.release()


class PortalHandler(BaseHTTPRequestHandler):
    server_version = "FreeISP"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(8)

    def log_message(self, format_string, *args):
        # Avoid recording usernames, cookies or credentials in system logs.
        pass

    @property
    def controller(self):
        return self.server.controller

    def _peer(self):
        peer = self.controller.runtime.client(self.client_address[0])
        tables = self.controller.engine.config["collections"]
        server = next(s for s in tables["servers"] if s["id"] == peer["server_id"])
        profile = next(p for p in tables["server_profiles"] if p["id"] == server["profile"])
        if server["disabled"] or profile["disabled"]:
            raise ValueError("This Hotspot is disabled")
        return peer, server, profile

    def _csrf(self, peer, timestamp=None):
        timestamp = str(int(time.time()) if timestamp is None else timestamp)
        value = timestamp + "|" + peer["ip"] + "|" + peer["mac"]
        return timestamp + "." + hmac.new(self.controller.secret, value.encode(), hashlib.sha256).hexdigest()

    def _verify_csrf(self, token, peer):
        try:
            stamp = token.split(".", 1)[0]
            valid_age = 0 <= time.time() - int(stamp) <= 900
            return valid_age and hmac.compare_digest(token, self._csrf(peer, stamp))
        except (ValueError, AttributeError):
            return False

    def _authorities(self, profile):
        suffix = ":" + str(profile.get("http_port", 6480))
        names = [profile["hotspot_address"] + suffix]
        if profile.get("dns_name"):
            names.insert(0, profile["dns_name"] + suffix)
        return names

    def _headers(self, code, content_type="text/html; charset=utf-8", cookie=None, location=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        if location:
            self.send_header("Location", location)
        self.send_header("Connection", "close")
        self.end_headers()

    def _page(self, peer, server, error="", code=200, cookie=None):
        current = next((s for s in self.controller.engine.state["sessions"] if
                        s["address"] == peer["ip"] and s["mac_address"].upper() == peer["mac"].upper() and s["server"] == server["id"]), None)
        token = html.escape(self._csrf(peer), quote=True)
        if current:
            content = ('<h1>You are connected</h1><p>Signed in as <strong>' + html.escape(current["user"]) + '</strong>.</p>'
                       '<form method="post" action="/logout"><input type="hidden" name="csrf" value="' + token + '">'
                       '<button type="submit">Log out</button></form>')
        else:
            content = ('<h1>Connect to the internet</h1><p>Sign in to ' + html.escape(server["name"]) + '.</p>'
                       + ('<p role="alert" class="error">' + html.escape(error) + '</p>' if error else '') +
                       '<form method="post" action="/login"><input type="hidden" name="csrf" value="' + token + '">'
                       '<label>Username<input name="username" required maxlength="128" autocomplete="username"></label>'
                       '<label>Password<input type="password" name="password" required maxlength="1024" autocomplete="current-password"></label>'
                       '<label class="remember"><input type="checkbox" name="remember" value="1"> Remember this device</label>'
                       '<button type="submit">Sign in</button></form><p class="small">Use your Hotspot access account. This local sign-in page uses HTTP.</p>')
        template = ('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                    '<title>FreeISP Hotspot</title><style>body{margin:0;background:#eef2f8;color:#17263b;font:16px system-ui,sans-serif}'
                    'main{max-width:390px;margin:9vh auto;padding:32px;background:white;border-radius:14px;box-shadow:0 12px 40px #20304018}'
                    'h1{font-size:26px}label{display:block;margin:18px 0}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aab6c6;border-radius:6px;font:inherit}'
                    'input[type=checkbox]{width:auto}.remember,.small{font-size:13px}button{width:100%;padding:13px;border:0;border-radius:6px;background:#205eac;color:white;font:inherit;cursor:pointer}'
                    '.error{color:#a31824}.small{color:#536479}</style><main>{{content}}</main></html>')
        path = self.controller.runtime.template_path(server)
        try:
            with open(path, encoding="utf-8") as stream:
                custom = stream.read(65537)
            if len(custom) <= 65536 and "{{content}}" in custom:
                template = custom
        except (OSError, UnicodeError):
            pass
        self._headers(code, cookie=cookie)
        self.wfile.write(template.replace("{{content}}", content).encode("utf-8"))

    def do_GET(self):
        try:
            with self.controller.lock:
                peer, server, profile = self._peer()
                # Captive probes land on the canonical router origin before credentials.
                authorities = self._authorities(profile)
                if self.headers.get("Host") not in authorities:
                    self._headers(302, location="http://" + authorities[0] + "/")
                    return
                cookie = SimpleCookie()
                try:
                    cookie.load(self.headers.get("Cookie", ""))
                except Exception:
                    pass
                current = any(s["address"] == peer["ip"] and s["server"] == server["id"] for s in self.controller.engine.state["sessions"])
                if not current and "freeisp_login" in cookie and profile.get("cookie_login", True):
                    try:
                        self.controller.engine.login_cookie(cookie["freeisp_login"].value, peer["ip"], peer["mac"], peer["server_id"])
                    except HotspotError:
                        pass
                self._page(peer, server)
        except Exception as exc:
            self._headers(403)
            self.wfile.write(("<!doctype html><p>" + html.escape(str(exc)) + "</p>").encode())

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192 or self.headers.get("Transfer-Encoding"):
                raise ValueError("Invalid form size")
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/x-www-form-urlencoded":
                raise ValueError("Unsupported form content type")
            values = parse_qs(self.rfile.read(length).decode("utf-8"), max_num_fields=8)
            fields = {k: v[0] for k, v in values.items() if len(v) == 1}
            with self.controller.lock:
                peer, server, profile = self._peer()
                authorities = self._authorities(profile)
                authority = self.headers.get("Host")
                origin = self.headers.get("Origin")
                if authority not in authorities or (origin and origin != "http://" + authority) or not self._verify_csrf(fields.get("csrf", ""), peer):
                    raise ValueError("This form expired. Reload the login page and try again.")
                cookie = None
                if self.path == "/login":
                    try:
                        result = self.controller.engine.login(fields.get("username", ""), fields.get("password", ""),
                                                              peer["ip"], peer["mac"], peer["server_id"], fields.get("remember") == "1")
                    except HotspotError as exc:
                        self._page(peer, server, exc.message, 400)
                        return
                    if result.get("cookie"):
                        cookie = "freeisp_login=" + result["cookie"] + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + str(int(profile["cookie_lifetime"]))
                elif self.path == "/logout":
                    current = next((s for s in self.controller.engine.state["sessions"] if s["address"] == peer["ip"] and
                                    s["mac_address"].upper() == peer["mac"].upper() and s["server"] == server["id"]), None)
                    if current:
                        self.controller.engine.logout(current["id"], peer["ip"])
                    cookie = "freeisp_login=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
                else:
                    raise ValueError("Unknown form action")
                self._headers(303, location="/", cookie=cookie)
        except Exception as exc:
            self._headers(400)
            self.wfile.write(("<!doctype html><p>" + html.escape(str(exc)) + "</p>").encode())


class Controller:
    def __init__(self, engine, runtime):
        self.engine = engine
        self.runtime = runtime
        self.lock = threading.RLock()
        self.secret = secrets.token_bytes(32)
        self.portal = None
        self.portal_port = None
        self.stopping = threading.Event()
        runtime.port_manager = self

    def prepare_port(self, config):
        tables = config["collections"]
        profiles = {x["id"]: x for x in tables["server_profiles"]}
        enabled = [s for s in tables["servers"] if not s["disabled"] and not profiles[s["profile"]]["disabled"]]
        port = int(profiles[enabled[0]["profile"]]["http_port"]) if enabled else None
        if port == self.portal_port:
            return None
        replacement = None
        if port:
            replacement = PortalServer(("0.0.0.0", port), PortalHandler)
            replacement.controller = self
            replacement.capacity = threading.BoundedSemaphore(24)
        return port, replacement

    def activate_port(self, prepared):
        if prepared is None:
            return
        port, replacement = prepared
        previous = self.portal
        self.portal, self.portal_port = replacement, port
        if replacement:
            threading.Thread(target=replacement.serve_forever, daemon=True).start()
        if previous:
            # shutdown waits only for the accept loop; never hold up portal workers.
            previous.shutdown()
            previous.server_close()

    def discard_port(self, prepared):
        if prepared and prepared[1]:
            prepared[1].server_close()

    def reconcile_port(self):
        self.activate_port(self.prepare_port(self.engine.config))

    def tick(self):
        while not self.stopping.wait(5):
            try:
                with self.lock:
                    self.engine.poll()
                    self.reconcile_port()
            except Exception as exc:
                print("FreeISP Hotspot: " + str(exc), file=sys.stderr, flush=True)


def serve(socket_path=SOCKET_PATH, config_path="/etc/freeisp/hotspot.json", state_path="/etc/freeisp/hotspot-state.json"):
    runtime = Runtime()
    engine = Engine(config_path=config_path, state_path=state_path, runtime=runtime)
    controller = Controller(engine, runtime)
    try:
        engine.poll()
        controller.reconcile_port()
    except Exception as exc:
        # Keep management available to fix an invalid interface; guard remains closed.
        print("FreeISP Hotspot startup: " + str(exc), file=sys.stderr, flush=True)
    if os.path.exists(socket_path):
        # Refuse to unlink a live daemon's socket.
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(socket_path)
        except OSError:
            os.unlink(socket_path)
        else:
            raise RuntimeError("Hotspot service is already running")
        finally:
            probe.close()
    old_umask = os.umask(0o077)
    try:
        management = ManagementServer(socket_path, ManagementHandler)
    finally:
        os.umask(old_umask)
    os.chmod(socket_path, 0o600)
    management.controller = controller
    threading.Thread(target=controller.tick, daemon=True).start()
    def stop(*_args):
        controller.stopping.set()
        threading.Thread(target=management.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        management.serve_forever(poll_interval=0.5)
    finally:
        controller.stopping.set()
        management.server_close()
        if controller.portal:
            controller.portal.shutdown()
            controller.portal.server_close()
        os.unlink(socket_path)


def rpc(argv, socket_path=SOCKET_PATH):
    if argv == ["list"]:
        print(json.dumps(METHODS))
        return 0
    if len(argv) != 2 or argv[0] != "call" or argv[1] not in METHODS:
        print(json.dumps({"ok": False, "error": {"code": "unknown_action", "message": "Unknown rpcd method"}}))
        return 0
    try:
        args = read_json(sys.stdin)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(20)
            client.connect(socket_path)
            client.sendall((json.dumps({"method": argv[1], "args": args}) + "\n").encode())
            with client.makefile("r", encoding="utf-8") as response:
                result = read_json(response, limit=4 * 1024 * 1024)
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps(failure(exc)))
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "rpc":
        sys.exit(rpc(sys.argv[2:]))
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve"])
    parser.add_argument("--socket", default=SOCKET_PATH)
    parser.add_argument("--config", default="/etc/freeisp/hotspot.json")
    parser.add_argument("--state", default="/etc/freeisp/hotspot-state.json")
    options = parser.parse_args()
    serve(options.socket, options.config, options.state)
