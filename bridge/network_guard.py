"""Block local and private TCP destinations for the desktop clipping process.

The guard checks the address passed to connect, after DNS resolution. This
also catches redirects and DNS changes made after the UI's initial URL check.
It is installed only in BridgeClip's local worker process.
"""

import ipaddress
import socket
import sys
from contextlib import contextmanager
from contextvars import ContextVar

_original_connect = socket.socket.connect
_original_connect_ex = socket.socket.connect_ex
_installed = False

# The one loopback host:port a clip-planning call may reach, set only while the
# local planning adapter holds the exception. Everything else stays blocked.
_allowed_loopback: ContextVar = ContextVar("allowed_loopback_destination", default=None)


def _internal_socketpair(family=socket.AF_INET, type=socket.SOCK_STREAM, proto=0):
    """Build a self-connected pair without exempting ordinary loopback traffic.

    Windows implements socket.socketpair() by connecting to a temporary local
    listener. Use the original connect only for the client socket created here;
    all other connects continue through the destination guard.
    """
    if family not in (socket.AF_INET, socket.AF_INET6):
        raise ValueError("Only AF_INET and AF_INET6 socket pairs are supported")
    if type != socket.SOCK_STREAM or proto != 0:
        raise ValueError("Only stream socket pairs with protocol zero are supported")
    host = "127.0.0.1" if family == socket.AF_INET else "::1"
    listener = socket.socket(family, type, proto)
    try:
        listener.bind((host, 0))
        listener.listen()
        address = listener.getsockname()[:2]
        client = socket.socket(family, type, proto)
        try:
            client.setblocking(False)
            try:
                _original_connect(client, address)
            except (BlockingIOError, InterruptedError):
                pass
            client.setblocking(True)
            server, _ = listener.accept()
        except BaseException:
            client.close()
            raise
    finally:
        listener.close()
    try:
        if server.getsockname() != client.getpeername() or client.getsockname() != server.getpeername():
            raise ConnectionError("Unexpected socket pair peer")
    except BaseException:
        server.close()
        client.close()
        raise
    return server, client


def _checked_loopback_address(sock: socket.socket, address, allowed):
    """Allow only the saved loopback host:port, checking the resolved address."""
    if not isinstance(address, tuple) or len(address) < 2:
        raise OSError("Network destination is invalid")
    host, port = address[:2]
    allowed_host, allowed_port = allowed
    try:
        port_number = int(port)
    except (TypeError, ValueError):
        raise OSError("Network destination is invalid") from None
    if port_number != allowed_port:
        raise OSError("Network destination is not allowed")
    try:
        ip = ipaddress.ip_address(host)
        if not ip.is_loopback:
            raise OSError("Network destination is not loopback")
        return address[:2] + address[2:]
    except ValueError:
        pass
    if str(host).lower().rstrip(".") != allowed_host:
        raise OSError("Network destination is not the saved host")
    results = socket.getaddrinfo(host, port, sock.family, sock.type, sock.proto)
    if not results or any(not ipaddress.ip_address(result[4][0]).is_loopback for result in results):
        raise OSError("Network destination is not loopback")
    return results[0][4]


def _public_address(sock: socket.socket, address):
    if sock.family not in (socket.AF_INET, socket.AF_INET6):
        return address
    if not isinstance(address, tuple) or len(address) < 2:
        raise OSError("Network destination is invalid")
    allowed = _allowed_loopback.get()
    if allowed is not None:
        return _checked_loopback_address(sock, address, allowed)
    host, port = address[:2]
    try:
        ip = ipaddress.ip_address(host)
        if not ip.is_global:
            raise OSError("Local network destinations are not allowed")
        return address
    except ValueError:
        pass

    results = socket.getaddrinfo(host, port, sock.family, sock.type, sock.proto)
    if not results:
        raise OSError("Network destination could not be resolved")
    if any(not ipaddress.ip_address(result[4][0]).is_global for result in results):
        raise OSError("Local network destinations are not allowed")
    return results[0][4]


@contextmanager
def allow_loopback_destination(host: str, port: int):
    """Scoped exception for one local planning request.

    The caller (the local planning adapter) enables this only around a planning
    call whose URL was validated as loopback and saved in settings. Plain http
    stays blocked everywhere else, and the address is re-checked at connect
    time, so DNS rebinding cannot widen it.
    """
    if not isinstance(host, str) or not host:
        raise ValueError("Invalid loopback destination")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("Invalid loopback destination")
    token = _allowed_loopback.set((host.lower().rstrip("."), port))
    try:
        yield
    finally:
        _allowed_loopback.reset(token)


def _guard_async_connect(original):
    async def guarded_sock_connect(loop, sock, address):
        return await original(loop, sock, _public_address(sock, address))

    return guarded_sock_connect


def install() -> None:
    global _installed
    if _installed:
        return

    def guarded_connect(sock, address):
        return _original_connect(sock, _public_address(sock, address))

    def guarded_connect_ex(sock, address):
        return _original_connect_ex(sock, _public_address(sock, address))

    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
    # Python's Windows socketpair fallback uses socket.connect() to reach its
    # own ephemeral loopback listener. Keep that private IPC working without
    # allowing any arbitrary local destination through guarded_connect().
    fallback_socketpair = getattr(socket, "_fallback_socketpair", None)
    if fallback_socketpair is not None and socket.socketpair is fallback_socketpair:
        socket.socketpair = _internal_socketpair
    # Windows Proactor connects through ConnectEx instead of socket.connect(),
    # so guard the event loop's destination before it reaches that API.
    if sys.platform == "win32":
        from asyncio.proactor_events import BaseProactorEventLoop

        BaseProactorEventLoop.sock_connect = _guard_async_connect(
            BaseProactorEventLoop.sock_connect
        )
    _installed = True
