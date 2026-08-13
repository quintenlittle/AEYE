"""AEYE P2P -- TCP listener + client handshake (Phase 1).

Blocking sockets on daemon threads (clarity over cleverness). The host binds a
listener on its OWN port (default 8131 -- never the main HTTP server's 8130);
each incoming peer must send an ``auth`` message with a valid session code
before the connection is kept. Nothing else happens yet: no chat, no file
transfer, no encryption.

Wire protocol (Phase 1) -- newline-delimited UTF-8 JSON::

    client -> { "type": "auth", "code": "AEYE-XXXX-XXXX" }
    host   -> { "type": "auth_ok" }    (connection kept open)   OR
              { "type": "auth_fail" }  (socket closed)
"""
from __future__ import annotations

import json
import socket
import threading
import time
from collections import deque

DEFAULT_PORT = 8131
_RECV_TIMEOUT = 15.0        # a peer that doesn't send auth in time is dropped
_MAX_LINE = 4096            # an auth line is tiny -- cap it to avoid abuse

# Verbose-logging switch (synced from the UI's Debug Mode). When OFF (default),
# message CONTENTS are kept out of the logs -- they still reach the chat window
# via HUB, but never appear in stdout / the log file (no sensitive persistence).
_DEBUG = False


def set_debug(on: bool) -> None:
    global _DEBUG
    _DEBUG = bool(on)


def _stamp() -> str:
    return time.strftime("%H:%M:%S")


class P2PListener:
    """Host-side TCP listener that authenticates peers by session code."""

    def __init__(self, session_mgr, port: int = DEFAULT_PORT, log=None):
        self.session_mgr = session_mgr
        self.port = int(port)
        self._log_cb = log
        self._srv = None
        self._accept_thread = None
        self._running = False
        self._lock = threading.Lock()
        self._conns = []                     # live, authenticated sockets
        self.logs = deque(maxlen=200)        # recent log lines for the UI

    # ---- verbose logging (spec: [LISTENING] / [INCOMING CONNECTION] / ...) --
    def log(self, msg: str) -> None:
        line = "[{}] {}".format(_stamp(), msg)
        self.logs.append(line)
        try:
            print("P2P " + line, flush=True)
        except Exception:
            pass
        if self._log_cb:
            try:
                self._log_cb(line)
            except Exception:
                pass

    # ---- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(("0.0.0.0", self.port))     # reachable from LAN / forwarded
            srv.listen(5)
            srv.settimeout(1.0)                  # so the accept loop sees stop()
            self._srv = srv
            self._running = True
            self._accept_thread = threading.Thread(
                target=self._accept_loop, name="p2p-accept", daemon=True)
            self._accept_thread.start()
        self.log("[LISTENING] port {}".format(self.port))

    def stop(self) -> None:
        with self._lock:
            self._running = False
            srv, self._srv = self._srv, None
            conns, self._conns = self._conns, []
        if srv:
            try:
                srv.close()
            except Exception:
                pass
        for c in conns:
            try:
                c.close()
            except Exception:
                pass
        self.log("[STOPPED] listener closed")

    def is_running(self) -> bool:
        return self._running

    def conn_count(self) -> int:
        with self._lock:
            return len(self._conns)

    # ---- accept loop -------------------------------------------------------
    def _accept_loop(self) -> None:
        while self._running:
            srv = self._srv
            if not srv:
                break
            try:
                conn, addr = srv.accept()
            except socket.timeout:
                continue                          # loop so stop() is noticed
            except OSError:
                break                             # socket closed under us
            self.log("[INCOMING CONNECTION] from {}:{}".format(addr[0], addr[1]))
            threading.Thread(target=self._handle, args=(conn, addr),
                             name="p2p-conn", daemon=True).start()

    def _handle(self, conn, addr) -> None:
        peer = "{}:{}".format(addr[0], addr[1])
        try:
            conn.settimeout(_RECV_TIMEOUT)
            line = self._read_line(conn)
            msg = json.loads(line) if line else {}
            if not isinstance(msg, dict) or msg.get("type") != "auth":
                self.log("[AUTH FAIL] {} -- no auth message".format(peer))
                self._send(conn, {"type": "auth_fail"})
                conn.close()
                return
            if self.session_mgr.validate_session(str(msg.get("code", ""))):
                self.log("[AUTH SUCCESS] {}".format(peer))
                self._send(conn, {"type": "auth_ok"})
                with self._lock:
                    self._conns.append(conn)
                self._hold(conn, peer)            # keep open (Phase 1: no chat)
            else:
                self.log("[AUTH FAIL] {} -- bad or expired code".format(peer))
                self._send(conn, {"type": "auth_fail"})
                conn.close()
        except Exception as e:
            self.log("[AUTH FAIL] {} -- {}".format(peer, type(e).__name__))
            try:
                conn.close()
            except Exception:
                pass

    def _hold(self, conn, peer) -> None:
        """After a successful auth, hand the socket to the Phase 2 chat read
        loop, which reads NDJSON messages until the peer drops (it also logs
        the lifecycle and closes the socket). We only tidy up this listener's
        own connection bookkeeping afterwards -- the auth handshake above is
        untouched."""
        try:
            run_chat_loop(conn, peer, self.log)
        finally:
            with self._lock:
                if conn in self._conns:
                    self._conns.remove(conn)

    # ---- socket helpers ----------------------------------------------------
    def _read_line(self, conn) -> str:
        buf = b""
        while b"\n" not in buf and len(buf) <= _MAX_LINE:
            chunk = conn.recv(1024)
            if not chunk:
                break
            buf += chunk
        return buf.split(b"\n", 1)[0].decode("utf-8", "replace").strip()

    def _send(self, conn, obj) -> None:
        try:
            conn.sendall((json.dumps(obj) + "\n").encode("utf-8"))
        except Exception:
            pass


def connect_and_auth(ip: str, port: int, code: str, timeout: float = 8.0) -> dict:
    """Client side: connect, send the auth message, return the host's reply.

    Returns ``{"ok": bool, "response": dict|None, "error": str|None}``. The
    socket is closed afterwards -- Phase 1 has nothing to keep it open for.
    """
    result = {"ok": False, "response": None, "error": None}
    s = None
    try:
        s = socket.create_connection((ip, int(port)), timeout=timeout)
        s.settimeout(timeout)
        s.sendall((json.dumps({"type": "auth", "code": code}) + "\n").encode("utf-8"))
        buf = b""
        while b"\n" not in buf and len(buf) < _MAX_LINE:
            chunk = s.recv(1024)
            if not chunk:
                break
            buf += chunk
        line = buf.split(b"\n", 1)[0].decode("utf-8", "replace").strip()
        resp = json.loads(line) if line else {}
        result["response"] = resp
        result["ok"] = isinstance(resp, dict) and resp.get("type") == "auth_ok"
    except Exception as e:
        result["error"] = "{}: {}".format(type(e).__name__, e)
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass
    return result


# ==========================================================================
# Phase 2: real-time chat over the already-authenticated connection.
#
# Everything below runs ONLY after a successful auth handshake -- the auth and
# connection-setup code above is left untouched. Framing is newline-delimited
# JSON (NDJSON): exactly one JSON object per line, each ending in "\n", so a
# reader can split on newlines and never concatenate two messages.
# ==========================================================================


class _ChatHub:
    """Thread-safe sink for chat + lifecycle events (drained by the HTTP poll
    route), plus the single active socket to send outgoing chat on. One
    conversation at a time (Phase 1/2). Every event carries a monotonic ``seq``
    so the poller can ask for "everything since N"."""

    def __init__(self):
        self._lock = threading.Lock()
        self._events = deque(maxlen=1000)
        self._seq = 0
        self._active = None

    def push(self, kind, **data):
        with self._lock:
            self._seq += 1
            ev = {"seq": self._seq, "kind": kind, "ts": time.time()}
            ev.update(data)
            self._events.append(ev)
            return self._seq

    def since(self, seq):
        """Events with ``seq`` greater than the argument, plus the new cursor."""
        with self._lock:
            evs = [e for e in self._events if e["seq"] > seq]
            return evs, self._seq

    def set_active(self, conn):
        with self._lock:
            self._active = conn

    def clear_active(self, conn):
        with self._lock:
            if self._active is conn:
                self._active = None

    def active(self):
        with self._lock:
            return self._active

    def connected(self):
        with self._lock:
            return self._active is not None


# module-level singleton -- both roles (host + client) feed the same hub, and
# the server's poll/send routes read/write through it.
HUB = _ChatHub()


def send_chat(conn, message: str) -> bool:
    """Serialize ``message`` as one NDJSON chat line and send it on ``conn``.
    Returns True on success. Never raises."""
    try:
        line = json.dumps({"type": "chat", "msg": message}) + "\n"
        conn.sendall(line.encode("utf-8"))
        return True
    except Exception:
        return False


def run_chat_loop(conn, peer, log) -> None:
    """Post-auth read loop: register ``conn`` as the active chat socket and read
    NDJSON lines until it closes.

    ROBUST BY DESIGN -- malformed JSON and unknown message types are logged and
    skipped; the thread never crashes on bad input. Chat + lifecycle are pushed
    to :data:`HUB` so the frontend (which polls ``/api/p2p/poll``) can render
    them in real time."""
    HUB.set_active(conn)
    HUB.push("connected", peer=peer)
    log("[CONNECTION ESTABLISHED] {}".format(peer))
    buf = b""
    try:
        conn.settimeout(None)
        while True:
            data = conn.recv(4096)
            if not data:
                break                              # peer closed the socket
            buf += data
            while b"\n" in buf:                    # frame on newlines (NDJSON)
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    log("[INVALID MESSAGE] {} -- bad JSON".format(peer))
                    HUB.push("invalid", peer=peer, reason="bad JSON")
                    continue                       # log and keep going
                if not isinstance(msg, dict) or "type" not in msg:
                    log("[INVALID MESSAGE] {} -- not a typed object".format(peer))
                    HUB.push("invalid", peer=peer, reason="not a typed object")
                    continue
                mtype = msg.get("type")
                if mtype == "chat":
                    text = str(msg.get("msg", ""))
                    # content only in the log when Debug Mode is on; the chat
                    # window always gets it via HUB regardless
                    log("[CHAT RECEIVED] {}".format(text) if _DEBUG else "[CHAT RECEIVED]")
                    HUB.push("chat", peer=peer, msg=text)
                else:
                    log("[IGNORED] {} -- unknown type '{}'".format(peer, mtype))
    except Exception as e:
        log("[DISCONNECTED] {} -- {}".format(peer, type(e).__name__))
    finally:
        HUB.clear_active(conn)
        HUB.push("disconnected", peer=peer)
        log("[DISCONNECTED] {}".format(peer))
        try:
            conn.close()
        except Exception:
            pass


def open_chat_client(ip, port, code, log, timeout: float = 8.0):
    """Client side of chat: connect and run the SAME auth handshake as
    :func:`connect_and_auth` (which is left untouched), then -- on success --
    return the authenticated socket so the caller can run :func:`run_chat_loop`
    on it. Returns None if auth is rejected; raises on a connection error."""
    s = socket.create_connection((ip, int(port)), timeout=timeout)
    s.settimeout(timeout)
    s.sendall((json.dumps({"type": "auth", "code": code}) + "\n").encode("utf-8"))
    buf = b""
    while b"\n" not in buf and len(buf) < _MAX_LINE:
        chunk = s.recv(1024)
        if not chunk:
            break
        buf += chunk
    line = buf.split(b"\n", 1)[0].decode("utf-8", "replace").strip()
    resp = json.loads(line) if line else {}
    if isinstance(resp, dict) and resp.get("type") == "auth_ok":
        log("[AUTH SUCCESS] host {}:{}".format(ip, port))
        return s
    try:
        s.close()
    except Exception:
        pass
    log("[AUTH FAIL] host {}:{} -- rejected".format(ip, port))
    return None
