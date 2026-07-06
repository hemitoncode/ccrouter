import sys as _sys
from pathlib import Path as _Path

_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "src"))

import http.client
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ccrouter import config
from ccrouter.server import ProxyHandler

HIGH_PROMPT = "design and implement a payment service end-to-end"
LOW_PROMPT = "rename a.py to b.py now"


class MockUpstream(BaseHTTPRequestHandler):
    """Fake api.anthropic.com. Behavior driven by server.state['mode']."""

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        state = self.server.state
        state["requests"].append({
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body,
        })
        mode = state.get("mode", "json")
        if mode == "404_then_ok" and len(state["requests"]) == 1:
            error = json.dumps({
                "type": "error",
                "error": {"type": "not_found_error",
                          "message": "model: claude-opus-4-6 not found"},
            }).encode()
            self._reply(404, error)
            return
        if mode == "sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"event: a\ndata: {}\n\n")
            self.wfile.flush()
            # Prove incremental delivery: only continue once the *client*
            # has already received the first event through the proxy.
            state["gate_ok"] = state["gate"].wait(timeout=3)
            self.wfile.write(b"event: b\ndata: {}\n\n")
            self.wfile.flush()
            return
        self._reply(200, json.dumps({"ok": True}).encode())

    def _reply(self, status, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def make_proxy(cfg):
    proxy = ThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
    proxy.cfg = cfg
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    return proxy


class ProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        os.environ["CCROUTER_HOME"] = cls.tmp.name

        cls.mock = ThreadingHTTPServer(("127.0.0.1", 0), MockUpstream)
        cls.mock.state = {"requests": [], "mode": "json"}
        threading.Thread(target=cls.mock.serve_forever, daemon=True).start()

        cfg = config.load_config(user_path=Path(os.devnull))
        cfg["upstream_scheme"] = "http"
        cfg["upstream_host"] = "127.0.0.1:%d" % cls.mock.server_address[1]
        cfg["classifier"]["api_key"] = None
        cls.cfg = cfg
        cls.proxy = make_proxy(cfg)
        cls.port = cls.proxy.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.proxy.shutdown()
        cls.proxy.server_close()
        cls.mock.shutdown()
        cls.mock.server_close()
        os.environ.pop("CCROUTER_HOME", None)
        cls.tmp.cleanup()

    def setUp(self):
        self.mock.state["requests"] = []
        self.mock.state["mode"] = "json"

    # -- helpers ------------------------------------------------------------
    def request(self, path="/v1/messages", body=None, headers=None,
                method="POST", raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        payload = raw if raw is not None else (
            json.dumps(body).encode() if body is not None else b"")
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(headers or {})
        conn.request(method, path, body=payload, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    def upstream_requests(self):
        return self.mock.state["requests"]

    def sentinel_body(self, prompt):
        return {"model": "auto",
                "messages": [{"role": "user", "content": prompt}]}

    # -- tests ----------------------------------------------------------------
    def test_sentinel_rewrite_and_header_fidelity(self):
        status, _ = self.request(
            body=self.sentinel_body(HIGH_PROMPT),
            headers={
                "Authorization": "Bearer secret-token-xyz",
                "anthropic-beta": "oauth-2025-04-20,fine-grained",
                "x-claude-code-session-id": "sess-1234abcd",
            },
        )
        self.assertEqual(status, 200)
        [req] = self.upstream_requests()
        sent = json.loads(req["body"])
        self.assertEqual(sent["model"], self.cfg["models"]["high"])
        self.assertEqual(sent["messages"][0]["content"], HIGH_PROMPT)
        self.assertEqual(req["headers"]["authorization"], "Bearer secret-token-xyz")
        self.assertEqual(req["headers"]["anthropic-beta"],
                         "oauth-2025-04-20,fine-grained")
        self.assertEqual(req["headers"]["host"], self.cfg["upstream_host"])
        # Decision was logged, without leaking credentials or prompt text.
        log = (Path(self.tmp.name) / "decisions.jsonl").read_text()
        self.assertIn('"tier": "high"', log)
        self.assertNotIn("secret-token-xyz", log)
        self.assertNotIn(HIGH_PROMPT, log)

    def test_non_sentinel_passthrough_is_byte_identical(self):
        raw = b'{"model": "claude-sonnet-4-6",   "messages": []}'
        status, _ = self.request(raw=raw)
        self.assertEqual(status, 200)
        [req] = self.upstream_requests()
        self.assertEqual(req["body"], raw)

    def test_unparseable_body_forwarded_untouched(self):
        raw = b'{"model": "auto", "messages": [truncated'
        status, _ = self.request(raw=raw)
        self.assertEqual(status, 200)
        [req] = self.upstream_requests()
        self.assertEqual(req["body"], raw)

    def test_count_tokens_rewritten(self):
        status, _ = self.request(path="/v1/messages/count_tokens",
                                 body=self.sentinel_body(LOW_PROMPT))
        self.assertEqual(status, 200)
        [req] = self.upstream_requests()
        self.assertEqual(json.loads(req["body"])["model"],
                         self.cfg["models"]["low"])

    def test_sse_streams_incrementally(self):
        self.mock.state["mode"] = "sse"
        gate = threading.Event()
        self.mock.state["gate"] = gate
        self.mock.state["gate_ok"] = None

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/v1/messages",
                     body=json.dumps(self.sentinel_body("hello there my friend")),
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        received = b""
        while b"event: a" not in received:
            chunk = resp.read1(65536)
            self.assertTrue(chunk, "stream ended before first event")
            received += chunk
        self.assertNotIn(b"event: b", received,
                         "second event arrived early — not incremental")
        gate.set()
        while True:
            chunk = resp.read1(65536)
            if not chunk:
                break
            received += chunk
        conn.close()
        self.assertIn(b"event: b", received)
        self.assertTrue(self.mock.state["gate_ok"],
                        "proxy buffered the stream instead of forwarding live")

    def test_downgrade_retry_on_model_404(self):
        self.mock.state["mode"] = "404_then_ok"
        status, data = self.request(body=self.sentinel_body(HIGH_PROMPT))
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), {"ok": True})
        requests = self.upstream_requests()
        self.assertEqual(len(requests), 2)
        self.assertEqual(json.loads(requests[0]["body"])["model"],
                         self.cfg["models"]["high"])
        self.assertEqual(json.loads(requests[1]["body"])["model"],
                         self.cfg["models"]["mid"])

    def test_unrouted_404_is_not_retried(self):
        self.mock.state["mode"] = "404_then_ok"
        raw = json.dumps({"model": "claude-sonnet-4-6", "messages": []}).encode()
        status, data = self.request(raw=raw)
        self.assertEqual(status, 404)
        self.assertIn(b"not_found_error", data)
        self.assertEqual(len(self.upstream_requests()), 1)

    def test_health_endpoint(self):
        status, data = self.request(path="/__ccrouter/health", method="GET")
        self.assertEqual(status, 200)
        info = json.loads(data)
        self.assertTrue(info["ok"])
        self.assertEqual(info["sentinel"], "auto")

    def test_head_probe(self):
        status, data = self.request(path="/", method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(data, b"")

    def test_dead_upstream_returns_502(self):
        cfg = dict(self.cfg)
        cfg["upstream_host"] = "127.0.0.1:1"  # nothing listens here
        proxy = make_proxy(cfg)
        try:
            conn = http.client.HTTPConnection(
                "127.0.0.1", proxy.server_address[1], timeout=10)
            conn.request("POST", "/v1/messages",
                         body=json.dumps(self.sentinel_body("hi there friend")),
                         headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            data = resp.read()
            conn.close()
            self.assertEqual(resp.status, 502)
            self.assertIn(b"cc-model-router", data)
        finally:
            proxy.shutdown()
            proxy.server_close()


if __name__ == "__main__":
    unittest.main()
