"""AEYE P2P -- UPnP port-forwarding hook (Phase 1 stub).

Real IGD/UPnP forwarding (via ``miniupnpc`` or similar) lands in a later phase.
For now these are no-ops that return ``False``, so the button and UI can be
wired today and gain real behaviour later without changing any call sites.
"""
from __future__ import annotations


def attempt_port_forward(port: int) -> bool:
    """Try to open ``port`` on the router via UPnP. Returns True on success.

    STUB -- always returns False (not implemented yet). The structure is ready
    for a miniupnpc-based implementation, e.g.::

        import miniupnpc
        u = miniupnpc.UPnP()
        u.discoverdelay = 200
        if u.discover() > 0:
            u.selectigd()
            return bool(u.addportmapping(
                int(port), 'TCP', u.lanaddr, int(port), 'AEYE P2P', ''))
        return False
    """
    return False


def remove_port_forward(port: int) -> bool:
    """Undo a forward created by :func:`attempt_port_forward`. STUB -> False."""
    return False
