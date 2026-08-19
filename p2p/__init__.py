"""AEYE P2P subsystem (Phase 1): session codes + TCP handshake + UPnP stub.

Modular and self-contained under ``p2p/`` so it never interferes with the main
AEYE HTTP server on port 8130. The listener binds its own port (default 8131).
"""
from .session import SessionManager, generate_code, SESSION_TTL_SECONDS
from .connection import (
    P2PListener, connect_and_auth, DEFAULT_PORT,
    HUB, send_chat, run_chat_loop, open_chat_client, set_debug,   # Phase 2: chat
)
from .upnp import attempt_port_forward, remove_port_forward
from .tls import configure as set_cert_dir, ensure_cert           # Phase 4: TLS
from . import filetransfer                                        # Phase 5: files
# importing filetransfer registers its read-loop message handler (additive)
from .filetransfer import (
    start_send as file_start_send,
    configure_download as file_configure_download,
    dirs as file_dirs,
    reset as file_reset,
    set_debug as file_set_debug,
    MIN_CHUNK, MAX_CHUNK, DEFAULT_CHUNK, DEFAULT_LANES,
)

__all__ = [
    "SessionManager", "generate_code", "SESSION_TTL_SECONDS",
    "P2PListener", "connect_and_auth", "DEFAULT_PORT",
    "HUB", "send_chat", "run_chat_loop", "open_chat_client", "set_debug",
    "attempt_port_forward", "remove_port_forward",
    "set_cert_dir", "ensure_cert",
    "filetransfer", "file_start_send", "file_configure_download", "file_dirs",
    "file_reset", "file_set_debug",
    "MIN_CHUNK", "MAX_CHUNK", "DEFAULT_CHUNK", "DEFAULT_LANES",
]
