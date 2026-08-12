#!/usr/bin/env python3
"""
AEYE board-ticker relay -- a tiny local CORS proxy for 4chan's read-only API.

Why this exists: 4chan's API (a.4cdn.org) only allows cross-origin reads from
boards.4chan.org, so AEYE (which runs on a localhost origin) can't fetch it
directly. Public CORS proxies don't work either -- 4chan blocks their datacenter
IPs. This relay runs on YOUR machine, so requests go out from your own IP (which
4chan serves normally) and nothing touches a third party. Fully local, private.

Run it:
    python aeye-4chan-relay.py            # listens on 127.0.0.1:8788

Then in AEYE ▸ manage ▸ settings ▸ Board tickers, set the feed relay to:
    http://127.0.0.1:8788/{board}

Leave it running in the background while you use AEYE (or wrap it in a shortcut /
Task Scheduler entry). Stdlib only -- no pip installs, works with any Python 3.
"""
import re
import sys
import json
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8788
BOARD_RE = re.compile(r"^[a-z0-9]{1,10}$")
UA = "AEYE-board-ticker-relay/1.0 (local)"


class Handler(BaseHTTPRequestHandler):
    def _cors(self, code=200, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_OPTIONS(self):                      # preflight, just in case
        self._cors(204)

    def do_GET(self):
        board = self.path.lstrip("/").split("?", 1)[0].strip("/").lower()
        if not BOARD_RE.match(board):
            self._cors(400)
            self.wfile.write(b'{"error":"bad board code"}')
            return
        url = "https://a.4cdn.org/%s/catalog.json" % board
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=15) as r:
                body = r.read()
        except Exception as e:                 # feed down -> let AEYE skip the lane
            self._cors(502)
            self.wfile.write(json.dumps({"error": str(e)}).encode())
            return
        self._cors(200)
        self.wfile.write(body)

    def log_message(self, *a):                 # quiet
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("AEYE 4chan relay on http://%s:%d  ->  set AEYE relay to "
          "http://%s:%d/{board}" % (HOST, PORT, HOST, PORT))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()
        sys.exit(0)
