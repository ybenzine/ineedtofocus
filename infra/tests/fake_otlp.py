"""Stand-in for Grafana Cloud's OTLP gateway in the production-stack smoke test (#27).

Runs in the app image (which ships the OTLP protobuf classes) as the `fake-grafana`
service of the smoke test's dev project; the collector exports to it with the same
otlphttp exporter and basic auth it uses for Grafana Cloud. For each export it prints
one JSON line to stdout:

    {"signal": "traces", "auth_ok": true, "resources": [...], "spans": [...]}

`auth_ok` says whether the Authorization header matched FAKE_OTLP_EXPECTED_AUTH; the
header itself is never printed. For traces it lists each resource's environment and
version and each server span's path, host and scheme, which the smoke test uses to check
environment tagging and proxy-header trust. Stdlib + opentelemetry-proto.
"""

from __future__ import annotations

import gzip
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.common.v1.common_pb2 import KeyValue

EXPECTED_AUTH = os.environ.get("FAKE_OTLP_EXPECTED_AUTH", "")
SIGNALS = {"/otlp/v1/traces": "traces", "/otlp/v1/metrics": "metrics", "/otlp/v1/logs": "logs"}
RESOURCE_KEYS = ("deployment.environment.name", "service.name", "service.version")
SPAN_KEYS = ("url.path", "url.scheme", "server.address", "http.response.status_code")


def attributes(items: Any, keys: tuple[str, ...]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    item: KeyValue
    for item in items:
        if item.key in keys:
            value = item.value
            result[item.key] = getattr(value, value.WhichOneof("value") or "string_value")
    return result


def summarise_traces(body: bytes) -> dict[str, Any]:
    request = ExportTraceServiceRequest()
    request.ParseFromString(body)
    resources: list[dict[str, Any]] = []
    spans: list[dict[str, Any]] = []
    for resource_spans in request.resource_spans:
        resources.append(attributes(resource_spans.resource.attributes, RESOURCE_KEYS))
        for scope_spans in resource_spans.scope_spans:
            for span in scope_spans.spans:
                found = attributes(span.attributes, SPAN_KEYS)
                if "url.path" in found:
                    spans.append(found)
    return {"resources": resources, "spans": spans}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        signal = SIGNALS.get(self.path, self.path)
        line: dict[str, Any] = {
            "signal": signal,
            "auth_ok": bool(EXPECTED_AUTH) and self.headers.get("Authorization") == EXPECTED_AUTH,
        }
        if signal == "traces":
            line |= summarise_traces(body)
        print(json.dumps(line), flush=True)
        # An empty protobuf message is a valid Export*ServiceResponse.
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return None  # one JSON line per export is enough


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 4318), Handler).serve_forever()
