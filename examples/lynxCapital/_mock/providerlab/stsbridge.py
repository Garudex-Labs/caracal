"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Loopback TCP relay that exposes the Caracal STS on the issuer's localhost address inside the lab container.
"""

from __future__ import annotations

import socket
import threading
from urllib.parse import urlparse

# Resource servers verify mandates against the zone issuer URL, which resolves
# to the deployment host's loopback. Inside the lab container that loopback has
# no STS, so this relay binds the issuer's localhost port and forwards raw TCP
# to the STS service on the container network, letting the verifier kit fetch
# JWKS from the exact URL carried in the mandate `iss` claim.


def _pump(src: socket.socket, dst: socket.socket) -> None:
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _serve(listener: socket.socket, upstream: tuple[str, int]) -> None:
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            return
        try:
            remote = socket.create_connection(upstream, timeout=10)
        except OSError:
            client.close()
            continue
        threading.Thread(target=_pump, args=(client, remote), daemon=True).start()
        threading.Thread(target=_pump, args=(remote, client), daemon=True).start()


def start(issuer: str, sts_url: str) -> bool:
    """Bind the issuer's loopback port and relay to the STS service; returns
    False when the issuer is already reachable or the port cannot be bound."""
    iss = urlparse(issuer)
    sts = urlparse(sts_url)
    if not iss.hostname or not sts.hostname:
        return False
    if (iss.hostname, iss.port) == (sts.hostname, sts.port):
        return False
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind(("127.0.0.1", iss.port or (443 if iss.scheme == "https" else 80)))
    except OSError:
        listener.close()
        return False
    listener.listen(32)
    upstream = (sts.hostname, sts.port or (443 if sts.scheme == "https" else 80))
    threading.Thread(
        target=_serve, args=(listener, upstream), daemon=True, name="sts-bridge"
    ).start()
    return True
