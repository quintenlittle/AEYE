"""AEYE P2P -- UPnP IGD port forwarding (NAT traversal).

Best-effort automatic port mapping via ``miniupnpc`` so a peer across the
internet can reach this instance's P2P listener without manual router config.

HARD FALLBACK CONTRACT: this module must NEVER crash the app and must NEVER
block. If ``miniupnpc`` isn't installed, or no UPnP-capable router (IGD) is
found, or the router refuses the mapping, every call quietly returns False and
AEYE keeps working in LAN-only mode (local connections always work regardless).

Discovery is slow (hundreds of ms) and network-bound, so callers should run
these off the main thread (the server does).

Dependency: ``pip install miniupnpc`` (a small C extension; stdlib-only fallback
is "do nothing"). We import it lazily inside each call so a missing dep can't
break import of the p2p package.
"""
from __future__ import annotations

import threading
import time

_DESC = "AEYE P2P"
_PROTO = "TCP"
_REFRESH_SECS = 1800            # re-assert mappings every 30 min (routers expire them)

_lock = threading.Lock()
_mapped = set()                # ports we're keeping alive
_refresher = None              # single keepalive thread
_last_error = None             # for optional diagnostics (never printed by default)


def _upnp():
    """Return a discovered+selected miniupnpc.UPnP, or None. Silent on failure.

    Networks often have several SSDP responders (media renderers, etc.) and only
    some expose an IGD, so ``selectigd`` can throw a transient "HTTP error" while
    fetching a device description. We retry a couple of times with a longer
    discovery delay before giving up to LAN-only."""
    global _last_error
    try:
        import miniupnpc                       # optional dep -- absent => LAN-only
    except Exception:
        _last_error = "miniupnpc not installed"
        return None
    _last_error = ""
    for attempt in range(3):                    # a few tries smooths transient errors
        try:
            u = miniupnpc.UPnP()
            u.discoverdelay = 1000              # give slower routers time to answer
            n = u.discover()
            if n <= 0:                          # nothing answered SSDP at all
                _last_error = "no UPnP router found"
                continue
            u.selectigd()                       # may raise if the IGD desc HTTP fails
            return u
        except Exception as e:
            _last_error = "{}: {}".format(type(e).__name__, e)
            continue
    return None


def _add(u, port: int) -> bool:
    try:
        # remove a stale mapping first so re-adds don't error on some routers
        try:
            u.deleteportmapping(int(port), _PROTO)
        except Exception:
            pass
        return bool(u.addportmapping(int(port), _PROTO, u.lanaddr,
                                     int(port), _DESC, ""))
    except Exception as e:
        global _last_error
        _last_error = "{}: {}".format(type(e).__name__, e)
        return False


def _ensure_refresher() -> None:
    global _refresher
    if _refresher and _refresher.is_alive():
        return

    def loop():
        while True:
            time.sleep(_REFRESH_SECS)
            with _lock:
                ports = list(_mapped)
            if not ports:
                return                         # nothing left to keep alive -> exit
            u = _upnp()
            if not u:
                continue
            for p in ports:
                _add(u, p)

    _refresher = threading.Thread(target=loop, name="aeye-upnp-refresh", daemon=True)
    _refresher.start()


def attempt_port_forward(port: int) -> bool:
    """Map ``port`` (TCP) on the router via UPnP and keep it refreshed. Returns
    True on success, False if UPnP is unavailable/failed (LAN-only). Never raises."""
    try:
        u = _upnp()
        if not u:
            return False
        ok = _add(u, int(port))
        if ok:
            with _lock:
                _mapped.add(int(port))
            _ensure_refresher()
        return ok
    except Exception:
        return False


def remove_port_forward(port: int) -> bool:
    """Undo a forward created by :func:`attempt_port_forward`. Never raises."""
    try:
        with _lock:
            _mapped.discard(int(port))
        u = _upnp()
        if not u:
            return False
        try:
            u.deleteportmapping(int(port), _PROTO)
            return True
        except Exception:
            return False
    except Exception:
        return False


def last_error() -> str:
    """Human-readable reason the last UPnP attempt failed (for UI messaging)."""
    return _last_error or ""


def available() -> bool:
    """Whether the miniupnpc dependency is importable at all."""
    try:
        import miniupnpc  # noqa: F401
        return True
    except Exception:
        return False


def external_ip() -> str:
    """Best-effort external (WAN) IP via the IGD, or "" if unavailable."""
    try:
        u = _upnp()
        if not u:
            return ""
        return u.externalipaddress() or ""
    except Exception:
        return ""


def autostart(port: int) -> None:
    """Fire-and-forget: try to map ``port`` on a background thread at app startup.
    Non-blocking and silent -- success enables WAN P2P, failure leaves LAN-only."""
    threading.Thread(target=attempt_port_forward, args=(int(port),),
                     name="aeye-upnp-autostart", daemon=True).start()
