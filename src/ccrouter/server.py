"""Localhost reverse proxy implementing the routing.

Claude Code (launched by `ccrouter code`) points ANTHROPIC_BASE_URL here.
For POST /v1/messages[/count_tokens] bodies whose model equals the sentinel,
the model field is rewritten per the routing decision; everything else is
forwarded byte-identical. Headers (including Authorization and
anthropic-beta) pass through verbatim in both directions, minus hop-by-hop
headers. Responses stream back unbuffered so SSE stays incremental.
"""

import argparse
import atexit
import http.client
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import __version__, config, decisions, router

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
REQUEST_EXCLUDE = HOP_BY_HOP | {"host", "content-length"}
RESPONSE_EXCLUDE = HOP_BY_HOP | {"content-length"}


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "cc-model-router/" + __version__

    # -- entry points ------------------------------------------------------
    def do_HEAD(self):
        # Claude Code probes the gateway with HEAD / at startup.
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/__ccrouter/health":
            return self._health()
        self._proxy()

    def do_POST(self):
        self._proxy()

    def do_PUT(self):
        self._proxy()

    def do_PATCH(self):
        self._proxy()

    def do_DELETE(self):
        self._proxy()

    def do_OPTIONS(self):
        self._proxy()

    # -- local endpoints ----------------------------------------------------
    def _health(self):
        cfg = self.server.cfg
        payload = json.dumps({
            "ok": True,
            "version": __version__,
            "pid": os.getpid(),
            "sentinel": cfg["sentinel"],
            "models": cfg["models"],
            "user_config": cfg.get("_user_config_loaded"),
            "user_config_error": cfg.get("_user_config_error"),
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    # -- proxying ------------------------------------------------------------
    def _proxy(self):
        cfg = self.server.cfg
        raw_body = self._read_body()

        decision = None
        body_dict = None
        if self.command == "POST" and raw_body:
            try:
                body_dict = json.loads(raw_body)
            except ValueError:
                body_dict = None  # not JSON: forward untouched
        if isinstance(body_dict, dict):
            decision = router.decide(
                self.path, dict(self.headers), body_dict, len(raw_body), cfg
            )
        if decision is not None:
            body_dict["model"] = decision.model
            raw_body = json.dumps(
                body_dict, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            decisions.record(decision, dict(self.headers), self.path, cfg)

        conn = None
        try:
            conn = self._upstream_request(raw_body)
            resp = conn.getresponse()

            # A routed model the subscription doesn't serve → one retry at MID.
            if (
                decision is not None
                and decision.tier != "mid"
                and cfg["rules"].get("retry_downgrade", True)
                and resp.status in (400, 404)
            ):
                err = resp.read()
                conn.close()
                conn = None
                if b"model" in err.lower():
                    body_dict["model"] = cfg["models"]["mid"]
                    raw_body = json.dumps(
                        body_dict, ensure_ascii=False, separators=(",", ":")
                    ).encode("utf-8")
                    retry = router.Decision(
                        "mid", cfg["models"]["mid"], "downgrade_retry",
                        signals=["from:%s" % decision.model],
                    )
                    decisions.record(retry, dict(self.headers), self.path, cfg)
                    conn = self._upstream_request(raw_body)
                    resp = conn.getresponse()
                else:
                    return self._send_buffered(resp.status, resp.getheaders(), err)

            self._stream_response(resp)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client went away mid-stream
        except Exception as exc:
            self._send_error_json(502, "upstream request failed: %s" % exc)
        finally:
            if conn is not None:
                conn.close()

    def _read_body(self) -> bytes:
        if (self.headers.get("Transfer-Encoding") or "").lower() == "chunked":
            return self._read_chunked()
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _read_chunked(self) -> bytes:
        data = bytearray()
        while True:
            line = self.rfile.readline(65536).strip()
            if b";" in line:
                line = line.split(b";", 1)[0]
            size = int(line or b"0", 16)
            if size == 0:
                while True:  # consume trailers
                    trailer = self.rfile.readline(65536)
                    if trailer in (b"\r\n", b"\n", b""):
                        break
                return bytes(data)
            remaining = size
            while remaining:
                chunk = self.rfile.read(remaining)
                if not chunk:
                    return bytes(data)
                data += chunk
                remaining -= len(chunk)
            self.rfile.read(2)  # trailing CRLF

    def _upstream_request(self, body: bytes):
        cfg = self.server.cfg
        conn_cls = (
            http.client.HTTPSConnection
            if cfg.get("upstream_scheme", "https") == "https"
            else http.client.HTTPConnection
        )
        conn = conn_cls(cfg["upstream_host"], timeout=600)
        conn.putrequest(
            self.command, self.path, skip_host=True, skip_accept_encoding=True
        )
        conn.putheader("Host", cfg["upstream_host"])
        for key, value in self.headers.items():
            if key.lower() not in REQUEST_EXCLUDE:
                conn.putheader(key, value)
        if body or self.command in ("POST", "PUT", "PATCH"):
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(message_body=body or None)
        return conn

    def _stream_response(self, resp) -> None:
        self.send_response_only(resp.status)
        self.log_request(resp.status)
        for key, value in resp.getheaders():
            if key.lower() not in RESPONSE_EXCLUDE:
                self.send_header(key, value)
        if self.command == "HEAD" or resp.status in (204, 304):
            length = resp.getheader("Content-Length")
            if length is not None:
                self.send_header("Content-Length", length)
            self.end_headers()
            return
        # Chunked re-framing lets us flush each upstream chunk immediately,
        # which keeps SSE token streaming live in the terminal.
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        while True:
            chunk = resp.read1(65536)
            if not chunk:
                break
            self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
            self.wfile.flush()
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def _send_buffered(self, status: int, headers, body: bytes) -> None:
        self.send_response_only(status)
        self.log_request(status)
        for key, value in headers:
            if key.lower() not in RESPONSE_EXCLUDE:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_error_json(self, status: int, message: str) -> None:
        payload = json.dumps({
            "type": "error",
            "error": {"type": "api_error", "message": "cc-model-router: " + message},
        }).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- logging (stderr → server.log when daemonized) -----------------------
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stderr.flush()


def pid_path():
    return config.state_dir() / "server.pid"


def _write_pidfile():
    config.state_dir().mkdir(parents=True, exist_ok=True)
    pid_path().write_text(str(os.getpid()))

    def _cleanup():
        try:
            if pid_path().read_text().strip() == str(os.getpid()):
                pid_path().unlink()
        except OSError:
            pass

    atexit.register(_cleanup)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="ccrouter-server")
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args(argv)

    cfg = config.load_config()
    port = args.port if args.port is not None else cfg["port"]

    httpd = ThreadingHTTPServer(("127.0.0.1", port), ProxyHandler)
    httpd.daemon_threads = True
    httpd.cfg = cfg
    _write_pidfile()

    sys.stderr.write(
        "cc-model-router %s listening on 127.0.0.1:%s -> %s://%s "
        "(sentinel=%r low=%s mid=%s high=%s)\n" % (
            __version__, port, cfg.get("upstream_scheme", "https"),
            cfg["upstream_host"], cfg["sentinel"], cfg["models"]["low"],
            cfg["models"]["mid"], cfg["models"]["high"],
        )
    )
    if cfg.get("_user_config_error"):
        sys.stderr.write("WARNING ignoring broken user config: %s\n"
                         % cfg["_user_config_error"])
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
