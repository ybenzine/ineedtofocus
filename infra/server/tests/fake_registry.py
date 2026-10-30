"""Fake GHCR for the build provenance tests in focus_ci.sh (#177).

Serves recorded registry objects over HTTPS, the way ghcr.io answers an anonymous
client, so the real cosign verifies real attestation bundles without the network. The
test container points ghcr.io (and Sigstore's hosts, to catch a call to them) at
127.0.0.1 and trusts this server's test CA.

    python3 -I fake_registry.py <state dir> <cert> <key>

Every directory under <state dir>/images holds one recorded image (see
infra/server/tests/provenance/README.md): image.json (its manifest) and, when it's
attested, referrers.json (the index ghcr.io keeps at the tag sha256-<hex>, since it has
no referrers API), attestation.json (the bundle's manifest) and bundle.json (the
Sigstore bundle). Everything is served by its sha256, read again on each request, so a
test adds or removes an image by adding or removing its directory. Any repository name
gets the same objects.

Each request is appended to <state dir>/requests.log as
`<method> <host> <path> <status> lock=<held|free>`: whether /opt/focus/deploy.lock was
held while it was served. While <state dir>/down exists, every request gets a 503.

It also answers DNS on 127.0.0.1:53 (UDP), where the test points /etc/resolv.conf: every
name not in /etc/hosts is refused with NXDOMAIN and appended to <state dir>/dns.log. So
a call to any host the test didn't point here fails and shows, instead of going out.
"""

from __future__ import annotations

import fcntl
import hashlib
import http.server
import json
import re
import socket
import ssl
import sys
import threading
from pathlib import Path

LOCK = Path("/opt/focus/deploy.lock")
MANIFEST = re.compile(r"^/v2/(?P<name>[a-z0-9._/-]+)/manifests/(?P<ref>[A-Za-z0-9_.:-]+)$")
BLOB = re.compile(r"^/v2/(?P<name>[a-z0-9._/-]+)/blobs/(?P<digest>sha256:[0-9a-f]{64})$")
REFERRERS = re.compile(r"^/v2/[a-z0-9._/-]+/referrers/sha256:[0-9a-f]{64}$")
MANIFEST_FILES = ("image.json", "referrers.json", "attestation.json")


def digest_of(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def lock_state() -> str:
    try:
        with LOCK.open("rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock, fcntl.LOCK_UN)
    except BlockingIOError:
        return "held"
    except OSError:
        return "missing"
    return "free"


class Objects:
    """The recorded objects under <state>/images, by digest and by tag."""

    def __init__(self, state: Path) -> None:
        self.manifests: dict[str, bytes] = {}
        self.blobs: dict[str, bytes] = {}
        for image in sorted((state / "images").glob("*")):
            if not image.is_dir():
                continue
            files = {
                name: (image / name).read_bytes()
                for name in MANIFEST_FILES
                if (image / name).is_file()
            }
            if "image.json" not in files:
                continue
            subject = digest_of(files["image.json"])
            for name, data in files.items():
                self.manifests[digest_of(data)] = data
                if name == "referrers.json":
                    self.manifests["sha256-" + subject.removeprefix("sha256:")] = data
            bundle = image / "bundle.json"
            if bundle.is_file():
                data = bundle.read_bytes()
                self.blobs[digest_of(data)] = data


class Handler(http.server.BaseHTTPRequestHandler):
    state: Path

    def log_message(self, format: str, *args: object) -> None:
        pass  # requests.log instead of stderr

    def record(self, status: int) -> None:
        host = self.headers.get("Host", "-").split(":")[0]
        with (self.state / "requests.log").open("a") as log:
            log.write(f"{self.command} {host} {self.path} {status} lock={lock_state()}\n")

    def answer(
        self, status: int, body: bytes, content_type: str, digest: str | None = None
    ) -> None:
        self.record(status)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Docker-Distribution-API-Version", "registry/2.0")
        if digest:
            self.send_header("Docker-Content-Digest", digest)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def not_found(self, code: str) -> None:
        body = json.dumps({"errors": [{"code": code, "message": code.lower().replace("_", " ")}]})
        self.answer(404, body.encode(), "application/json")

    def do_GET(self) -> None:
        if (self.state / "down").exists():
            self.answer(503, b"unavailable", "text/plain")
            return
        host = self.headers.get("Host", "").split(":")[0]
        if host != "ghcr.io":
            self.not_found("NOT_FOUND")
            return
        path = self.path.split("?")[0]
        if path in ("/v2", "/v2/"):
            self.answer(200, b"{}", "application/json")
            return
        objects = Objects(self.state)
        if match := MANIFEST.match(path):
            data = objects.manifests.get(match["ref"])
            if data is None:
                self.not_found("MANIFEST_UNKNOWN")
                return
            media_type = json.loads(data)["mediaType"]
            self.answer(200, data, media_type, digest_of(data))
            return
        if match := BLOB.match(path):
            data = objects.blobs.get(match["digest"])
            if data is None:
                self.not_found("BLOB_UNKNOWN")
                return
            self.answer(200, data, "application/octet-stream", digest_of(data))
            return
        if REFERRERS.match(path):
            self.not_found("NOT_FOUND")  # ghcr.io has no referrers API
            return
        self.not_found("NOT_FOUND")

    do_HEAD = do_GET


def query_name(packet: bytes) -> str:
    """The question's name of a DNS query, dotted ("?" when it can't be read)."""
    labels: list[str] = []
    at = 12  # after the header
    while at < len(packet) and packet[at] != 0:
        length = packet[at]
        if length > 63:  # a compression pointer has no place in a question
            return "?"
        labels.append(packet[at + 1 : at + 1 + length].decode("ascii", "replace"))
        at += 1 + length
    return ".".join(labels) or "?"


def serve_dns(state: Path) -> None:
    """NXDOMAIN for every query, each one logged to <state>/dns.log."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 53))
    while True:
        packet, client = sock.recvfrom(512)
        if len(packet) < 12:
            continue
        with (state / "dns.log").open("a") as log:
            log.write(query_name(packet) + "\n")
        # The same ID and question; QR, RD and RA set, RCODE 3 (NXDOMAIN); no answers.
        header = packet[:2] + b"\x81\x83" + packet[4:6] + b"\x00\x00\x00\x00\x00\x00"
        sock.sendto(header + packet[12:], client)


def main() -> None:
    state, cert, key = (Path(arg) for arg in sys.argv[1:4])
    Handler.state = state
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 443), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=serve_dns, args=(state,), daemon=True).start()
    (state / "ready").touch()
    server.serve_forever()


if __name__ == "__main__":
    main()
