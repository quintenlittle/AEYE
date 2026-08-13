"""AEYE P2P -- TLS transport wrapper (self-signed, no external dependencies).

Wraps the existing P2P sockets in TLS. The protocol, message format and chat
logic are untouched -- this is purely the transport: encrypt the bytes, nothing
else. The client does NOT verify the certificate (self-signed is fine here; the
session code is the real credential), so this provides *confidentiality in
transit*, not peer authentication.

Certs live as ``cert.pem`` + ``key.pem`` in a configured directory; if missing
they're generated once (RSA-2048 self-signed) and cached. Because the stdlib
can't generate certs and we allow no third-party packages, the generator here is
a small, self-contained RSA + X.509 (DER) implementation. Its correctness is
proven by a real TLS handshake (see the module self-test / the P2P test).
"""
from __future__ import annotations

import hashlib
import os
import secrets
import ssl
import threading
import time

_lock = threading.Lock()
_cert_dir = None
_server_ctx = None          # cached server SSLContext


# ==========================================================================
# public API
# ==========================================================================
def configure(cert_dir: str) -> None:
    """Point the cert store at a writable directory (called once at startup)."""
    global _cert_dir
    _cert_dir = cert_dir


def _dir() -> str:
    d = _cert_dir or os.path.join(os.path.expanduser("~"), ".aeye-p2p")
    os.makedirs(d, exist_ok=True)
    return d


def ensure_cert() -> tuple:
    """Return (certfile, keyfile), generating a self-signed pair if absent.
    Idempotent + thread-safe."""
    d = _dir()
    certfile = os.path.join(d, "cert.pem")
    keyfile = os.path.join(d, "key.pem")
    with _lock:
        if os.path.exists(certfile) and os.path.exists(keyfile):
            return certfile, keyfile
        cert_pem, key_pem = _generate_self_signed("AEYE-P2P")
        # write key first (0600 where supported), then cert
        with open(keyfile, "wb") as f:
            f.write(key_pem)
        try:
            os.chmod(keyfile, 0o600)
        except Exception:
            pass
        with open(certfile, "wb") as f:
            f.write(cert_pem)
    return certfile, keyfile


def server_context() -> ssl.SSLContext:
    """TLS server context loaded from the (generated) cert. Cached."""
    global _server_ctx
    with _lock:
        if _server_ctx is not None:
            return _server_ctx
    certfile, keyfile = ensure_cert()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=certfile, keyfile=keyfile)
    with _lock:
        _server_ctx = ctx
    return ctx


def client_context() -> ssl.SSLContext:
    """TLS client context that accepts the self-signed peer (no CA/hostname
    verification -- see the module docstring)."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def server_wrap(sock):
    """Wrap an accepted socket in TLS (server side). Performs the handshake."""
    return server_context().wrap_socket(sock, server_side=True)


def client_wrap(sock, host: str):
    """Wrap a connected socket in TLS (client side). Performs the handshake."""
    return client_context().wrap_socket(sock, server_hostname=host or "AEYE-P2P")


# ==========================================================================
# minimal DER encoding
# ==========================================================================
def _der_len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def _tlv(tag: int, content: bytes) -> bytes:
    return bytes([tag]) + _der_len(len(content)) + content


def _int(x: int) -> bytes:
    if x == 0:
        body = b"\x00"
    else:
        body = x.to_bytes((x.bit_length() + 7) // 8, "big")
        if body[0] & 0x80:                 # keep it positive
            body = b"\x00" + body
    return _tlv(0x02, body)


def _seq(*items: bytes) -> bytes:
    return _tlv(0x30, b"".join(items))


def _set(*items: bytes) -> bytes:
    return _tlv(0x31, b"".join(items))


def _bitstr(b: bytes) -> bytes:
    return _tlv(0x03, b"\x00" + b)


def _octet(b: bytes) -> bytes:
    return _tlv(0x04, b)


def _oid(dotted: str) -> bytes:
    parts = [int(p) for p in dotted.split(".")]
    body = bytearray([40 * parts[0] + parts[1]])
    for p in parts[2:]:
        stack = [p & 0x7F]
        p >>= 7
        while p:
            stack.append((p & 0x7F) | 0x80)
            p >>= 7
        body.extend(reversed(stack))
    return _tlv(0x06, bytes(body))


_NULL = b"\x05\x00"
_OID_RSA = _oid("1.2.840.113549.1.1.1")          # rsaEncryption
_OID_SHA256_RSA = _oid("1.2.840.113549.1.1.11")  # sha256WithRSAEncryption
_OID_SHA256 = _oid("2.16.840.1.101.3.4.2.1")     # sha-256
_OID_CN = _oid("2.5.4.3")                         # commonName


def _pem(label: str, der: bytes) -> bytes:
    import base64
    b64 = base64.encodebytes(der).decode("ascii").strip()
    return ("-----BEGIN {}-----\n{}\n-----END {}-----\n"
            .format(label, b64, label)).encode("ascii")


# ==========================================================================
# minimal RSA
# ==========================================================================
def _is_prime(n: int, rounds: int = 40) -> bool:
    if n < 2:
        return False
    small = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37)
    for p in small:
        if n % p == 0:
            return n == p
    d = n - 1
    r = 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _gen_prime(bits: int) -> int:
    while True:
        cand = secrets.randbits(bits) | (1 << (bits - 1)) | 1   # top + bottom bit set
        if _is_prime(cand):
            return cand


def _gen_rsa(bits: int = 2048):
    e = 65537
    half = bits // 2
    while True:
        p = _gen_prime(half)
        q = _gen_prime(half)
        if p == q:
            continue
        n = p * q
        if n.bit_length() != bits:
            continue
        phi = (p - 1) * (q - 1)
        if phi % e == 0:
            continue
        d = pow(e, -1, phi)
        return {
            "n": n, "e": e, "d": d, "p": p, "q": q,
            "dp": d % (p - 1), "dq": d % (q - 1), "qinv": pow(q, -1, p),
        }


def _rsa_sign_sha256(msg: bytes, n: int, d: int) -> bytes:
    """RSASSA-PKCS1-v1_5 signature with SHA-256."""
    digest = hashlib.sha256(msg).digest()
    digest_info = _seq(_seq(_OID_SHA256, _NULL), _octet(digest))
    k = (n.bit_length() + 7) // 8
    ps = b"\xff" * (k - len(digest_info) - 3)
    em = b"\x00\x01" + ps + b"\x00" + digest_info
    s = pow(int.from_bytes(em, "big"), d, n)
    return s.to_bytes(k, "big")


def _utctime(t: float) -> bytes:
    return _tlv(0x17, time.strftime("%y%m%d%H%M%SZ", time.gmtime(t)).encode("ascii"))


def _generate_self_signed(cn: str, bits: int = 2048, days: int = 3650):
    """Return (cert_pem, key_pem) for a fresh self-signed RSA certificate."""
    k = _gen_rsa(bits)
    n, e, d = k["n"], k["e"], k["d"]

    # PKCS#8 private key
    rsa_priv = _seq(
        _int(0), _int(n), _int(e), _int(d),
        _int(k["p"]), _int(k["q"]), _int(k["dp"]), _int(k["dq"]), _int(k["qinv"]))
    pkcs8 = _seq(_int(0), _seq(_OID_RSA, _NULL), _octet(rsa_priv))
    key_pem = _pem("PRIVATE KEY", pkcs8)

    # X.509
    spki = _seq(_seq(_OID_RSA, _NULL), _bitstr(_seq(_int(n), _int(e))))
    name = _seq(_set(_seq(_OID_CN, _tlv(0x0C, cn.encode("utf-8")))))   # CN=<cn>, UTF8String
    now = time.time()
    validity = _seq(_utctime(now - 86400), _utctime(now + days * 86400))
    sig_algo = _seq(_OID_SHA256_RSA, _NULL)
    serial = secrets.randbits(64) | 1
    tbs = _seq(
        _tlv(0xA0, _int(2)),        # [0] EXPLICIT version v3
        _int(serial),
        sig_algo,
        name,                       # issuer
        validity,
        name,                       # subject == issuer (self-signed)
        spki)
    signature = _rsa_sign_sha256(tbs, n, d)
    cert = _seq(tbs, sig_algo, _bitstr(signature))
    return _pem("CERTIFICATE", cert), key_pem
