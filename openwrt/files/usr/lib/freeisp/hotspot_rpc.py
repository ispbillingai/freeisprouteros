#!/usr/bin/python3
"""Small rpcd bridge; the resident Hotspot daemon owns all state and mutations."""
import json
import socket
import sys

SOCKET_PATH = "/var/run/freeisp-hotspot.sock"
MAX_REQUEST = 65536
METHODS = {"snapshot": {}, "mutate": {"action": "", "payload": ""}}


def failure(_exc):
    return {"ok": False, "error": {"code": "runtime", "message": "Hotspot service could not be reached or returned an invalid response."}}


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

