# -*- coding: utf-8 -*-
"""Local stand-in for the sync backend, implementing the same contract as the
Cloudflare Worker and the Apps Script. Used to prove the client's sync round
trip works before anything is deployed.

    python server/testserver.py 8764
"""
import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

STORE = {}
LOCK = threading.Lock()


def key_for(code):
    return hashlib.sha256(("cadmv:" + code).encode("utf-8")).hexdigest()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _code(self):
        q = parse_qs(urlparse(self.path).query)
        return (q.get("code", [""])[0] or "").strip()

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        code = self._code()
        if len(code) < 6:
            return self._json({"error": "sync code must be at least 6 characters"}, 400)
        with LOCK:
            rec = STORE.get(key_for(code))
        if not rec:
            return self._json({"state": None, "rev": 0})
        return self._json({"state": rec["state"], "rev": rec["rev"]})

    def do_POST(self):
        code = self._code()
        if len(code) < 6:
            return self._json({"error": "sync code must be at least 6 characters"}, 400)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8")
        try:
            state = json.loads(raw)
        except ValueError:
            return self._json({"error": "body is not valid JSON"}, 400)
        if not isinstance(state, dict):
            return self._json({"error": "state must be an object"}, 400)
        k = key_for(code)
        with LOCK:
            rev = STORE.get(k, {}).get("rev", 0) + 1
            STORE[k] = {"state": state, "rev": rev}
        return self._json({"ok": True, "rev": rev})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8764
    print("sync test server on http://127.0.0.1:%d" % port)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
