"""AEYE P2P -- file transfer over the already-authenticated TLS connection.

Self-contained: the TLS layer, the auth/connection handshake and the chat
system are all left untouched. This module only ADDS three new NDJSON message
types on top of the existing socket:

    file_meta      { type, id, name, size, chunk_size, total_chunks, lanes }
    file_chunk     { type, id, index, data(base64) }   -- order-independent
    file_complete  { type, id }

Sending (this side is the SENDER)
---------------------------------
A :class:`FileSender` runs on its own daemon thread. It base64-encodes chunks
and pushes them onto ONE bounded send queue (the in-flight cap), from which a
small pool of "lane" worker threads drain and write to the single shared socket
under a global send lock (so chat + chunk bytes never interleave). Chunk indices
are enqueued in an interleaved (lane-major) order to *simulate* parallel lanes
over the one connection.

Receiving (this side is the RECEIVER)
-------------------------------------
The chat read loop hands us file_* messages via a registered handler (see
``connection.set_message_handler``). On ``file_meta`` we open the destination
file (Desktop by default; configurable) and, per ``file_chunk``, seek to
``index * chunk_size`` and write the decoded bytes -- so out-of-order and even
duplicate chunks reassemble correctly and the receiver stays memory-bounded even
for very large files. ``file_complete`` finalizes.

PRIVACY (critical)
------------------
With Debug Mode OFF: NOTHING is logged, no file names / metadata are persisted;
all bookkeeping is in-memory only and lives on the transient event HUB (never
written to disk). With Debug Mode ON: the full lifecycle is logged, but chunk
events are THROTTLED (every N chunks or every X ms) -- never one line per chunk.

Everything is stdlib-only (base64, json, os, threading, queue) -- no new deps.
The base64 framing keeps JSON/NDJSON valid today; a future binary upgrade can
swap the payload encoding without touching the message shapes.
"""
from __future__ import annotations

import base64
import json
import math
import os
import queue
import threading
import time
import uuid

from . import connection   # HUB + safe_sendall + set_message_handler (additive)

# ---- tunables -------------------------------------------------------------
MIN_CHUNK = 64 * 1024            # 64 KB  -- safe lower bound
MAX_CHUNK = 256 * 1024          # 256 KB -- safe upper bound
DEFAULT_CHUNK = 65536           # 64 KB
DEFAULT_LANES = 4
MAX_LANES = 8
MAX_IN_FLIGHT = 32              # bounded send queue == in-flight chunk cap

# throttle: emit a progress/log event at most this often (whichever comes first)
_THROTTLE_CHUNKS = 16
_THROTTLE_MS = 250

# receiver flushes its OS buffers this often (every few MB, NOT per chunk) so a
# large transfer doesn't grow the Python write buffer without bound
_FLUSH_BYTES = 4 * 1024 * 1024

# ---- module state (in-memory ONLY -- nothing is persisted to disk) --------
_DEBUG = False
_cfg_lock = threading.Lock()
_download_dir = None            # resolved lazily -> Desktop by default
_senders = {}                  # id -> FileSender (active outgoing)
_receivers = {}                # id -> FileReceiver (active incoming)
_reg_lock = threading.Lock()


def set_debug(on: bool) -> None:
    """Synced from the UI's Debug Mode. OFF => this module logs NOTHING."""
    global _DEBUG
    _DEBUG = bool(on)


def _stamp() -> str:
    return time.strftime("%H:%M:%S")


def _log(msg: str) -> None:
    """Debug-gated stdout log. Silent unless Debug Mode is ON (privacy)."""
    if not _DEBUG:
        return
    try:
        print("P2P [{}] {}".format(_stamp(), msg), flush=True)
    except Exception:
        pass


# ---- download location -----------------------------------------------------
def _desktop_dir() -> str:
    home = os.path.expanduser("~")
    d = os.path.join(home, "Desktop")
    return d if os.path.isdir(d) else home


def _downloads_dir() -> str:
    home = os.path.expanduser("~")
    d = os.path.join(home, "Downloads")
    return d if os.path.isdir(d) else home


def configure_download(location: str = "desktop", custom_path: str = "") -> str:
    """Set where INCOMING files are saved. ``location`` is 'desktop',
    'downloads' or 'custom' (with ``custom_path``). Returns the resolved dir.
    In-memory only -- the choice is persisted by the frontend (localStorage)."""
    global _download_dir
    loc = (location or "desktop").strip().lower()
    if loc == "downloads":
        path = _downloads_dir()
    elif loc == "custom" and custom_path.strip():
        path = os.path.abspath(custom_path.strip())
    else:
        path = _desktop_dir()
    with _cfg_lock:
        _download_dir = path
    return path


def _dest_dir() -> str:
    with _cfg_lock:
        d = _download_dir
    return d or _desktop_dir()


def dirs() -> dict:
    """Expose the resolvable well-known dirs for the settings UI."""
    return {"desktop": _desktop_dir(), "downloads": _downloads_dir(),
            "current": _dest_dir()}


def clamp_chunk(n) -> int:
    try:
        n = int(n)
    except Exception:
        return DEFAULT_CHUNK
    return max(MIN_CHUNK, min(MAX_CHUNK, n))


# ---- HUB event helpers -----------------------------------------------------
# All transfer UI state flows through the transient in-memory event HUB (same
# channel chat uses). Nothing here is written to disk.
def _emit(ev: str, direction: str, tid: str, **data) -> None:
    connection.HUB.push("file", ev=ev, dir=direction, id=tid, **data)


def _safe_name(name: str) -> str:
    base = os.path.basename((name or "").replace("\\", "/"))
    base = base.strip().strip(".") or "file"
    # strip anything path-ish / control-ish; keep it boring and safe
    out = "".join(c for c in base if c not in '<>:"/\\|?*' and ord(c) >= 32)
    return (out or "file")[:180]


def _unique_path(directory: str, name: str) -> str:
    os.makedirs(directory, exist_ok=True)
    root, ext = os.path.splitext(name)
    cand = os.path.join(directory, name)
    i = 1
    while os.path.exists(cand):
        cand = os.path.join(directory, "{} ({}){}".format(root, i, ext))
        i += 1
    return cand


# ==========================================================================
# SENDER
# ==========================================================================
class FileSender(threading.Thread):
    """Chunk + base64 + interleave a file over the single shared socket."""

    def __init__(self, conn, name: str, src_path: str, size: int = -1,
                 chunk_size: int = DEFAULT_CHUNK, lanes: int = DEFAULT_LANES,
                 cleanup: bool = True):
        super().__init__(name="p2p-filesend", daemon=True)
        self.conn = conn
        self.id = uuid.uuid4().hex
        self.name = _safe_name(name)
        # STREAMING: we never hold the file in memory -- lane workers read their
        # chunk straight off disk (each with its own handle) at send time, so RAM
        # stays flat regardless of file size.
        self.src_path = src_path
        self.cleanup = bool(cleanup)      # delete the spool file when finished
        self.size = int(size) if size is not None and size >= 0 else os.path.getsize(src_path)
        self.chunk_size = clamp_chunk(chunk_size)
        self.total_chunks = max(1, math.ceil(self.size / self.chunk_size)) if self.size else 0
        self.lanes = max(1, min(MAX_LANES, int(lanes or DEFAULT_LANES)))
        self._cancel = threading.Event()
        self._sent = 0
        self._sent_bytes = 0
        self._lock = threading.Lock()
        self._t0 = 0.0
        self._last_emit = 0.0
        self._last_emit_n = 0

    def cancel(self) -> None:
        self._cancel.set()

    # -- wire helpers --------------------------------------------------------
    def _send_obj(self, obj) -> bool:
        try:
            connection.safe_sendall(self.conn, (json.dumps(obj) + "\n").encode("utf-8"))
            return True
        except Exception as e:
            _log("[ERROR] send failed -- {}".format(type(e).__name__))
            return False

    def _interleaved(self):
        """Lane-major index order: 0,4,8..,1,5,9..,2,6,10.. -> simulated lanes."""
        for off in range(self.lanes):
            i = off
            while i < self.total_chunks:
                yield i
                i += self.lanes

    # -- progress (throttled) ------------------------------------------------
    def _maybe_progress(self, force=False) -> None:
        now = time.time()
        with self._lock:
            n, nbytes = self._sent, self._sent_bytes
            due = (n - self._last_emit_n >= _THROTTLE_CHUNKS
                   or (now - self._last_emit) * 1000 >= _THROTTLE_MS)
            if not force and not due:
                return
            self._last_emit, self._last_emit_n = now, n
        elapsed = max(1e-6, now - self._t0)
        speed = nbytes / elapsed
        pct = (n / self.total_chunks * 100) if self.total_chunks else 100
        eta = ((self.size - nbytes) / speed) if speed > 0 else 0
        _emit("progress", "up", self.id, name=self.name, size=self.size,
              total_chunks=self.total_chunks, chunk_size=self.chunk_size,
              done=n, pct=round(pct, 1), speed=round(speed, 1), eta=round(eta, 1))
        _log("[PROGRESS] up {} {}/{} chunks  [SPEED] {:.1f} B/s".format(
            self.name, n, self.total_chunks, speed))

    # -- run -----------------------------------------------------------------
    def _cleanup_spool(self) -> None:
        """Delete the on-disk spool (the streamed upload) once we're done with
        it -- nothing is left on the sender's disk after a transfer."""
        if self.cleanup and self.src_path:
            try:
                os.remove(self.src_path)
            except Exception:
                pass

    def run(self) -> None:
        try:
            self._run()
        finally:
            self._cleanup_spool()

    def _run(self) -> None:
        self._t0 = time.time()
        _log("[FILE START] up id={} name={} size={} chunks={} lanes={}".format(
            self.id, self.name, self.size, self.total_chunks, self.lanes))
        _emit("start", "up", self.id, name=self.name, size=self.size,
              total_chunks=self.total_chunks, chunk_size=self.chunk_size)
        # file_meta
        meta = {"type": "file_meta", "id": self.id, "name": self.name,
                "size": self.size, "chunk_size": self.chunk_size,
                "total_chunks": self.total_chunks, "lanes": self.lanes}
        if not self._send_obj(meta):
            _emit("error", "up", self.id, name=self.name, error="send failed")
            _unregister_sender(self.id)
            return
        _log("[FILE META] up sent id={}".format(self.id))

        # Bounded index queue == the in-flight window (backpressure): it holds
        # chunk INDICES only (not data). When the receiver/socket falls behind,
        # sendall() blocks -> workers block -> the queue fills -> the producer
        # blocks. Nothing accumulates: at most `lanes` chunks are read into RAM at
        # once, so memory is flat no matter how big the file is.
        q = queue.Queue(maxsize=MAX_IN_FLIGHT)
        errs = []
        handles = []
        hlock = threading.Lock()

        def worker():
            # each lane gets its OWN read handle so seeks never race
            try:
                fh = open(self.src_path, "rb", buffering=0)
            except Exception:
                errs.append(-1)
                self._cancel.set()
                # still drain the queue so the producer doesn't block forever
                while True:
                    if q.get() is None:
                        q.task_done()
                        return
                    q.task_done()
            with hlock:
                handles.append(fh)
            while True:
                idx = q.get()
                try:
                    if idx is None or self._cancel.is_set():
                        return
                    fh.seek(idx * self.chunk_size)
                    piece = fh.read(self.chunk_size)      # <= chunk_size bytes off disk
                    b64 = base64.b64encode(piece).decode("ascii")
                    ok = self._send_obj({"type": "file_chunk", "id": self.id,
                                         "index": idx, "data": b64})
                    if not ok:
                        errs.append(idx)
                        self._cancel.set()
                        return
                    with self._lock:
                        self._sent += 1
                        self._sent_bytes += len(piece)
                    self._maybe_progress()
                finally:
                    q.task_done()

        pool = [threading.Thread(target=worker, name="p2p-lane", daemon=True)
                for _ in range(self.lanes)]
        for w in pool:
            w.start()
        # producer: interleaved order, blocks when the queue is full (in-flight cap)
        for idx in self._interleaved():
            if self._cancel.is_set():
                break
            q.put(idx)
        for _ in pool:
            q.put(None)                 # sentinels
        for w in pool:
            w.join()
        for fh in handles:              # close all lane read handles
            try:
                fh.close()
            except Exception:
                pass

        if self._cancel.is_set() or errs:
            _emit("error", "up", self.id, name=self.name, error="transfer aborted")
            _log("[ERROR] up transfer aborted id={}".format(self.id))
            _unregister_sender(self.id)
            return

        self._maybe_progress(force=True)
        self._send_obj({"type": "file_complete", "id": self.id})
        elapsed = max(1e-6, time.time() - self._t0)
        _emit("complete", "up", self.id, name=self.name, size=self.size,
              total_chunks=self.total_chunks, done=self.total_chunks, pct=100.0,
              speed=round(self.size / elapsed, 1), eta=0)
        _log("[COMPLETE] up id={} name={} {} bytes in {:.2f}s".format(
            self.id, self.name, self.size, elapsed))
        _unregister_sender(self.id)


# ==========================================================================
# RECEIVER
# ==========================================================================
class FileReceiver:
    """Reassemble an incoming file straight to disk (memory-bounded)."""

    def __init__(self, meta: dict):
        self.id = str(meta.get("id") or uuid.uuid4().hex)
        self.name = _safe_name(str(meta.get("name") or "file"))
        self.size = max(0, int(meta.get("size") or 0))
        self.chunk_size = clamp_chunk(meta.get("chunk_size") or DEFAULT_CHUNK)
        self.total_chunks = max(0, int(meta.get("total_chunks") or 0))
        self.lanes = int(meta.get("lanes") or DEFAULT_LANES)
        self.path = _unique_path(_dest_dir(), self.name)
        self._f = open(self.path, "wb")
        # pre-allocate so seek-writes land in a single contiguous file (option 1:
        # pre-allocated file + seek offsets -- no temp parts, no merge race)
        if self.size > 0:
            try:
                self._f.truncate(self.size)
            except Exception:
                pass
        self._seen = set()
        self._recv_bytes = 0
        self._since_flush = 0
        self._t0 = time.time()
        self._last_emit = 0.0
        self._last_emit_n = 0
        self._done = False
        _log("[FILE META] down id={} name={} size={} chunks={} -> {}".format(
            self.id, self.name, self.size, self.total_chunks, self.path))
        _emit("start", "down", self.id, name=self.name, size=self.size,
              total_chunks=self.total_chunks, chunk_size=self.chunk_size)

    def on_chunk(self, index: int, b64: str) -> None:
        if self._done:
            return
        try:
            raw = base64.b64decode(b64)
        except Exception:
            _log("[ERROR] down bad base64 id={} index={}".format(self.id, index))
            return
        try:
            self._f.seek(index * self.chunk_size)     # order-independent
            self._f.write(raw)
        except Exception as e:
            _log("[ERROR] down write failed -- {}".format(type(e).__name__))
            _emit("error", "down", self.id, name=self.name, error="write failed")
            return
        if index not in self._seen:
            self._seen.add(index)
            self._recv_bytes += len(raw)
        self._since_flush += len(raw)
        if self._since_flush >= _FLUSH_BYTES:   # flush every few MB, not per chunk
            try:
                self._f.flush()
            except Exception:
                pass
            self._since_flush = 0
        self._maybe_progress()

    def _maybe_progress(self, force=False) -> None:
        now = time.time()
        n = len(self._seen)
        due = (n - self._last_emit_n >= _THROTTLE_CHUNKS
               or (now - self._last_emit) * 1000 >= _THROTTLE_MS)
        if not force and not due:
            return
        self._last_emit, self._last_emit_n = now, n
        elapsed = max(1e-6, now - self._t0)
        speed = self._recv_bytes / elapsed
        pct = (n / self.total_chunks * 100) if self.total_chunks else 100
        eta = ((self.size - self._recv_bytes) / speed) if speed > 0 else 0
        _emit("progress", "down", self.id, name=self.name, size=self.size,
              total_chunks=self.total_chunks, chunk_size=self.chunk_size,
              done=n, pct=round(pct, 1), speed=round(speed, 1), eta=round(eta, 1))
        _log("[PROGRESS] down {} {}/{} chunks  [SPEED] {:.1f} B/s".format(
            self.name, n, self.total_chunks, speed))

    def finalize(self) -> None:
        if self._done:
            return
        self._done = True
        try:
            self._f.flush()
            self._f.close()
        except Exception:
            pass
        elapsed = max(1e-6, time.time() - self._t0)
        _emit("complete", "down", self.id, name=self.name, size=self.size,
              total_chunks=self.total_chunks, done=len(self._seen), pct=100.0,
              speed=round(self._recv_bytes / elapsed, 1), eta=0, path=self.path)
        _log("[COMPLETE] down id={} name={} saved -> {} ({} bytes, {:.2f}s)".format(
            self.id, self.name, self.path, self._recv_bytes, elapsed))

    def abort(self) -> None:
        self._done = True
        try:
            self._f.close()
        except Exception:
            pass


# ==========================================================================
# REGISTRY + read-loop hook
# ==========================================================================
def start_send(name: str, src_path: str, size: int, chunk_size: int, lanes: int,
               cleanup: bool = True) -> dict:
    """Kick off an outgoing transfer of the file spooled at ``src_path`` on the
    active socket. The sender STREAMS from disk (never buffers the file) and, when
    ``cleanup`` is set, deletes the spool once finished. Returns {ok,id,...}."""
    conn = connection.HUB.active()
    if conn is None:
        # nothing started -> caller owns the spool; drop it so nothing leaks
        if cleanup and src_path:
            try:
                os.remove(src_path)
            except Exception:
                pass
        return {"ok": False, "error": "not connected"}
    s = FileSender(conn, name, src_path, size, chunk_size, lanes, cleanup=cleanup)
    with _reg_lock:
        _senders[s.id] = s
    s.start()
    return {"ok": True, "id": s.id, "name": s.name, "size": s.size,
            "total_chunks": s.total_chunks, "chunk_size": s.chunk_size,
            "lanes": s.lanes}


def _unregister_sender(tid: str) -> None:
    with _reg_lock:
        _senders.pop(tid, None)


def handle_message(msg: dict, conn, peer, log) -> bool:
    """Registered with connection.set_message_handler. Consumes ONLY the file_*
    message types (returns True); anything else is left for the caller to handle.
    Runs on the chat read-loop thread -- decode+disk-write of a single 64-256 KB
    chunk is cheap, so chat is never meaningfully blocked."""
    mtype = msg.get("type")
    if mtype not in ("file_meta", "file_chunk", "file_complete"):
        return False
    tid = str(msg.get("id") or "")
    try:
        if mtype == "file_meta":
            _log("[FILE START] down id={} name={}".format(tid, msg.get("name")))
            rx = FileReceiver(msg)
            with _reg_lock:
                old = _receivers.get(rx.id)
                if old:
                    old.abort()
                _receivers[rx.id] = rx
        elif mtype == "file_chunk":
            with _reg_lock:
                rx = _receivers.get(tid)
            if rx is not None:
                rx.on_chunk(int(msg.get("index") or 0), str(msg.get("data") or ""))
        elif mtype == "file_complete":
            with _reg_lock:
                rx = _receivers.pop(tid, None)
            if rx is not None:
                rx.finalize()
    except Exception as e:
        _log("[ERROR] down handler -- {}".format(type(e).__name__))
        _emit("error", "down", tid, error=type(e).__name__)
    return True


def reset() -> None:
    """Abort any in-flight transfers (e.g. on disconnect). In-memory cleanup only."""
    with _reg_lock:
        rxs = list(_receivers.values())
        _receivers.clear()
        snds = list(_senders.values())
        _senders.clear()
    for s in snds:
        try:
            s.cancel()
        except Exception:
            pass
    for r in rxs:
        try:
            r.abort()
        except Exception:
            pass


# register the read-loop hook exactly once, at import
connection.set_message_handler(handle_message)
