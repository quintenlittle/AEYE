"""AEYE P2P -- session-code manager (Phase 1).

A session code is a short, human-shareable token that authorises a peer to
connect to this host's P2P listener. Codes look like ``AEYE-XXXX-XXXX``
(uppercase alphanumeric), live for 10 minutes, and only one is active at a
time. No chat, no encryption yet -- this is purely the handshake credential.
"""
from __future__ import annotations

import secrets
import threading
import time

# Unambiguous uppercase alphabet -- no 0/O or 1/I, so a code read aloud or
# typed by hand can't be mistaken.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
SESSION_TTL_SECONDS = 10 * 60          # codes expire after 10 minutes


def _block(n: int = 4) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(n))


def generate_code() -> str:
    """Return a fresh code of the form ``AEYE-XXXX-XXXX``."""
    return "AEYE-{}-{}".format(_block(), _block())


class SessionManager:
    """Holds the single active session code and its lifetime. Thread-safe, so
    the HTTP handlers and the listener's connection threads can share it."""

    def __init__(self, ttl_seconds: int = SESSION_TTL_SECONDS):
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._code = None
        self._created = 0.0
        self._active = False

    # ---- public API (matches the Phase 1 spec) -----------------------------
    def create_session(self) -> dict:
        """Mint a fresh code, replacing any previous one. Returns its info."""
        with self._lock:
            self._code = generate_code()
            self._created = time.time()
            self._active = True
            return self._info_locked()

    def validate_session(self, code: str) -> bool:
        """True iff ``code`` matches the active, non-expired session."""
        with self._lock:
            if not self._active or not self._code:
                return False
            if self._expired_locked():
                self._active = False          # lazily reap on read
                return False
            given = (code or "").strip().upper()
            return secrets.compare_digest(given, self._code)   # constant-time

    def invalidate_session(self) -> None:
        """Tear down the active session (called on host-stop / shutdown)."""
        with self._lock:
            self._active = False
            self._code = None
            self._created = 0.0

    # ---- introspection -----------------------------------------------------
    def info(self) -> dict:
        with self._lock:
            if self._active and self._expired_locked():
                self._active = False
            return self._info_locked()

    def _expired_locked(self) -> bool:
        return (time.time() - self._created) > self._ttl

    def _info_locked(self) -> dict:
        alive = self._active and not self._expired_locked()
        remaining = max(0, int(self._ttl - (time.time() - self._created))) if alive else 0
        return {
            "code": self._code if alive else None,
            "active": alive,
            "created": self._created if alive else 0,
            "ttl": self._ttl,
            "expires_in": remaining,
        }
